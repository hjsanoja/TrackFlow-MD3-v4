-- ============================================================================
-- TRACKFLOW - FASE 7: HISTORICO DE PRECIOS PARA ANALISIS DE TENDENCIAS
-- ============================================================================
-- PROBLEMA: las flechas de variacion, los graficos de evolucion y el comparador
-- de meses salen planos o en 0%.
--
-- CAUSA RAIZ: fase5_archivo_deprecacion.sql renombro historico_precios a
-- legacy_historico_precios y, a diferencia de cadenas, bcv_rates y
-- productos_competencia, NO le creo vista de compatibilidad. El frontend
-- consulta 'historico_precios', recibe el error 42P01 (la tabla no existe) y
-- se queda con una lista vacia, asi que no tiene con que comparar.
--
-- Los 20.153 precios historicos SI estan: viven en fact_precios. Lo que falta
-- es exponerlos con la forma que el panel espera.
--
-- ORDEN DE EJECUCION: despues de fase6_correcciones.sql.
-- Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. VISTA DE COMPATIBILIDAD historico_precios SOBRE fact_precios
-- ----------------------------------------------------------------------------
-- Coherencia obligatoria con la vista productos_competencia del paso 7 de
-- fase6_correcciones.sql: el panel agrupa el historico con la clave
-- (id_producto_propio + cadena + marca). Si estas tres columnas no devuelven
-- exactamente los mismos valores en ambas vistas, las claves no coinciden y
-- las tendencias vuelven a salir vacias. Por eso aqui tambien:
--   id_producto_propio -> se resuelve via producto_equivalencias
--   cadena             -> pub.cadena_id
--   marca              -> p.nombre (el nombre del producto, no el laboratorio)
DO $historico$
DECLARE
    v_relkind "char";
BEGIN
    SELECT c.relkind INTO v_relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'historico_precios';

    IF v_relkind = 'r' THEN
        RAISE NOTICE 'historico_precios sigue siendo una tabla real: no se toca (la Fase 5 no fue aplicada).';
        RETURN;
    END IF;

    IF v_relkind = 'v' THEN
        DROP VIEW public.historico_precios;
    END IF;

    CREATE VIEW public.historico_precios AS
    SELECT
        fp.id::text AS id,
        COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
        pub.cadena_id AS cadena,
        p.nombre AS marca,
        CASE WHEN lab.es_propio THEN 'propio' ELSE 'alternativa' END AS tipo,
        lab.nombre AS laboratorio,
        fp.precio_full_bs,
        fp.precio_desc_bs,
        CASE WHEN fp.tasa_bcv > 0
             THEN ROUND((fp.precio_full_bs / fp.tasa_bcv)::numeric, 2)
             ELSE NULL END AS precio_full_usd,
        CASE WHEN fp.tasa_bcv > 0 AND fp.precio_desc_bs IS NOT NULL
             THEN ROUND((fp.precio_desc_bs / fp.tasa_bcv)::numeric, 2)
             ELSE NULL END AS precio_desc_usd,
        fp.tasa_bcv,
        fp.tiene_promocion AS tiene_descuento,
        fp.promo_texto_raw AS tipo_promo,
        fp.scrape_run_id::text AS run_id,
        fp.fecha_captura AS scraped_at,
        -- Fecha calendario local: es la que permite agrupar por dia y por mes
        (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha_local,
        pub.url,
        pub.id AS publicacion_id,
        fp.estado,
        fp.error_mensaje AS ultimo_error
    FROM fact_precios fp
    JOIN publicaciones pub ON pub.id = fp.publicacion_id
    JOIN dim_productos p ON p.id = pub.producto_id
    JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN producto_equivalencias pe
           ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN dim_productos p_propio
           ON p_propio.id = pe.producto_propio_id
    WHERE fp.estado = 'ok'
      AND fp.disponible;

    RAISE NOTICE 'Vista historico_precios creada sobre fact_precios.';
END
$historico$;

-- ----------------------------------------------------------------------------
-- 2. SERIE DIARIA PARA COMPARAR DIAS Y MESES
-- ----------------------------------------------------------------------------
-- El scraper puede capturar varias veces el mismo dia. Para una tendencia lo
-- que interesa es UN precio por publicacion y por dia (el ultimo del dia).
-- Esta vista reduce el volumen y es la base para comparar contra "hace 7 dias"
-- o "el mes pasado" sin traerse todas las capturas al navegador.
CREATE OR REPLACE VIEW public.v_precio_diario
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (fp.publicacion_id, (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date)
    (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha_local,
    DATE_TRUNC('month', (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date)::date AS mes,
    fp.publicacion_id,
    pub.cadena_id,
    p.id_interno,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    p.nombre AS producto_nombre,
    lab.nombre AS laboratorio,
    lab.es_propio,
    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_vigente_bs,
    fp.tasa_bcv,
    CASE WHEN fp.tasa_bcv > 0
         THEN ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv)::numeric, 2)
         ELSE NULL END AS precio_vigente_usd,
    fp.fecha_captura
FROM fact_precios fp
JOIN publicaciones pub ON pub.id = fp.publicacion_id
JOIN dim_productos p ON p.id = pub.producto_id
JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe
       ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio
       ON p_propio.id = pe.producto_propio_id
WHERE fp.estado = 'ok'
  AND fp.disponible
ORDER BY
    fp.publicacion_id,
    (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date,
    fp.fecha_captura DESC;

-- ----------------------------------------------------------------------------
-- 3. INDICE DE APOYO
-- ----------------------------------------------------------------------------
-- Las consultas del panel filtran por rango de fechas sobre fact_precios.
CREATE INDEX IF NOT EXISTS idx_fact_precios_captura_pub
ON fact_precios (fecha_captura DESC, publicacion_id);

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. El historico ya responde (deberia dar ~20.153 o algo menos, porque la
--     vista excluye capturas con estado <> 'ok' o no disponibles)
/*
SELECT COUNT(*) AS filas_historico FROM historico_precios;
*/

-- V2. Cobertura por mes: cuantos dias y cuantos precios hay en cada mes.
--     Si solo aparece un mes, todavia no hay con que comparar meses anteriores.
/*
SELECT mes,
       COUNT(DISTINCT fecha_local) AS dias_con_datos,
       COUNT(*)                    AS precios
FROM v_precio_diario
GROUP BY mes
ORDER BY mes DESC;
*/

-- V3. Las claves de agrupacion coinciden entre ambas vistas.
--     Debe devolver 0 filas: todo enlace vigente tiene historico con la misma
--     combinacion (id_producto_propio + cadena + marca).
/*
SELECT pc.id_producto_propio, pc.cadena, pc.marca
FROM productos_competencia pc
WHERE NOT EXISTS (
    SELECT 1 FROM historico_precios h
    WHERE h.id_producto_propio = pc.id_producto_propio
      AND h.cadena = pc.cadena
      AND h.marca = pc.marca
);
*/
