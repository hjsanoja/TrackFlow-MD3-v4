-- ============================================================================
-- TRACKFLOW - FASE 12: BANDEJA DE REVISION DE CAPTURAS SOSPECHOSAS
-- ============================================================================
-- El esquema ya marca las capturas dudosas desde la Fase 1: el trigger
-- fn_control_calidad_precio compara el nombre capturado contra el del catalogo
-- y la variacion de precio contra el umbral de config_calidad, y escribe
-- sospechoso, similitud_nombre y motivo_sospecha.
--
-- El problema: NADIE LAS VE NUNCA. No hay pantalla que las lea, asi que un
-- precio mal leido entra igual en los promedios, en las brechas y en el
-- indice de competitividad. Antes de construir analisis encima, hay que poder
-- revisarlas.
--
-- Esta fase expone esas capturas con su contexto y concede el permiso justo
-- para marcarlas como revisadas.
--
-- ORDEN DE EJECUCION: despues de fase11_vista_variacion.sql. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. VISTA DE CAPTURAS PENDIENTES DE REVISION
-- ----------------------------------------------------------------------------
-- Incluye el precio anterior de la misma publicacion para poder juzgar de un
-- vistazo si el salto es real o un fallo de lectura.
CREATE OR REPLACE VIEW public.v_capturas_sospechosas
WITH (security_invoker = true)
AS
SELECT
    fp.id                          AS captura_id,
    fp.publicacion_id,
    pub.cadena_id,
    pub.url,
    p.id_interno,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    p.nombre                       AS producto_nombre,
    lab.nombre                     AS laboratorio,
    lab.es_propio,

    fp.fecha_captura,
    (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha_local,

    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_bs,
    fp.tasa_bcv,
    CASE WHEN fp.tasa_bcv > 0
         THEN ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv)::numeric, 2)
         ELSE NULL END             AS precio_usd,

    -- Por que se marco
    fp.motivo_sospecha,
    fp.similitud_nombre,
    fp.nombre_capturado,
    fp.revisado_manual,
    fp.estado,

    -- Contexto: la captura valida anterior de la misma publicacion
    ant.fecha_local                AS fecha_anterior,
    ant.precio_vigente_bs          AS precio_anterior_bs,
    CASE
      WHEN ant.precio_vigente_bs > 0
      THEN ROUND(
             (((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) - ant.precio_vigente_bs)
               / ant.precio_vigente_bs) * 100)::numeric, 1)
      ELSE NULL
    END                            AS variacion_pct

FROM fact_precios fp
JOIN publicaciones pub      ON pub.id = fp.publicacion_id
JOIN dim_productos p        ON p.id = pub.producto_id
JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe
       ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio
       ON p_propio.id = pe.producto_propio_id
LEFT JOIN LATERAL (
    SELECT d.fecha_local, d.precio_vigente_bs
    FROM v_precio_diario d
    WHERE d.publicacion_id = fp.publicacion_id
      AND d.fecha_captura < fp.fecha_captura
    ORDER BY d.fecha_captura DESC
    LIMIT 1
) ant ON TRUE
WHERE fp.sospechoso
  AND NOT fp.revisado_manual;

-- ----------------------------------------------------------------------------
-- 2. PERMISO PARA MARCAR COMO REVISADA, Y SOLO ESO
-- ----------------------------------------------------------------------------
-- fact_precios no tiene politica UPDATE a proposito: insertar y modificar
-- capturas es del scraper, con service_role. Pero revisar es una tarea humana.
--
-- Las politicas RLS no pueden limitar QUE columnas se tocan, asi que el limite
-- se pone con privilegios a nivel de columna: el panel solo puede escribir en
-- los tres campos de revision. Un intento de cambiar el precio es rechazado
-- por Postgres aunque la politica RLS lo permita.
-- Dos acciones posibles desde la bandeja, y lo que significan:
--
--   "Es valida"   -> revisado_manual = TRUE, sospechoso = FALSE
--                    La captura vuelve a entrar en los analisis, porque
--                    v_ultimo_precio_valido filtra por NOT sospechoso.
--
--   "Es erronea"  -> revisado_manual = TRUE, sospechoso se queda en TRUE
--                    Queda descartada de los analisis para siempre, pero sin
--                    borrarla: el dato crudo se conserva.
GRANT UPDATE (revisado_manual, sospechoso, motivo_sospecha)
ON public.fact_precios TO authenticated;

DROP POLICY IF EXISTS "auth_update_revision_fact_precios" ON fact_precios;
CREATE POLICY "auth_update_revision_fact_precios" ON fact_precios
    FOR UPDATE TO authenticated
    USING (true)
    WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 3. RESUMEN PARA EL INDICADOR DE LA PANTALLA
-- ----------------------------------------------------------------------------
-- DROP previo: CREATE OR REPLACE VIEW no permite insertar una columna en
-- medio ni renombrar las existentes, y esta vista gano 'descartadas'.
DROP VIEW IF EXISTS public.v_calidad_datos;

CREATE VIEW public.v_calidad_datos
WITH (security_invoker = true)
AS
SELECT
    COUNT(*)                                             AS capturas_totales,
    COUNT(*) FILTER (WHERE sospechoso)                   AS sospechosas,
    COUNT(*) FILTER (WHERE sospechoso AND NOT revisado_manual) AS pendientes,
    -- Se cuenta por revisado_manual y no por "sospechoso Y revisado": al
    -- confirmar que una captura es valida se le quita la marca de sospechosa
    -- para que vuelva a entrar en los analisis, y entonces dejaria de contarse.
    COUNT(*) FILTER (WHERE revisado_manual)                    AS revisadas,
    COUNT(*) FILTER (WHERE revisado_manual AND sospechoso)     AS descartadas,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'nombre')         AS por_nombre,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'variacion_precio') AS por_precio,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'ambos')          AS por_ambos,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'legacy')         AS legacy,
    ROUND(
      (COUNT(*) FILTER (WHERE NOT sospechoso)::numeric
       / NULLIF(COUNT(*), 0)) * 100, 1)                  AS porcentaje_limpio
FROM fact_precios;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Estado general de la calidad de tus datos
/*
SELECT * FROM v_calidad_datos;
*/

-- V2. Las 20 capturas sospechosas con mayor salto de precio
/*
SELECT id_producto_propio, cadena_id, producto_nombre, motivo_sospecha,
       precio_anterior_bs, precio_bs, variacion_pct, similitud_nombre
FROM v_capturas_sospechosas
ORDER BY ABS(COALESCE(variacion_pct, 0)) DESC
LIMIT 20;
*/

-- V3. Reparto por motivo
/*
SELECT motivo_sospecha, COUNT(*) FROM v_capturas_sospechosas
GROUP BY motivo_sospecha ORDER BY 2 DESC;
*/
