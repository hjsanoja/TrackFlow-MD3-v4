-- ============================================================================
-- TRACKFLOW - FASE 49: LECTURA DE PRESENTACION Y LIMPIEZA
-- ============================================================================
-- 1. fn_leer_presentacion: "10 Sobres x 1.3 gr" se leia "x 1" (tomaba el
--    1 de "1.3 gr", que es el peso de cada sobre). Ahora un "x N" seguido de
--    decimales o de una unidad de peso/volumen no cuenta como cantidad, y se
--    usa "10 sobres". Misma regla en el panel (utils/leerPresentacion.js) y
--    en el buscador (buscar_enlaces.py).
--    Las capturas ya marcadas por esto no se desmarcan solas: en Revision de
--    capturas se ve que el tamaño ahora coincide y se marcan «Es válida».
-- 2. v_precios_repetidos: suma dosis y tamaño registrados del enlace, para
--    la ficha nueva (registrado frente a leido en la tienda).
-- 3. Limpieza de lo que ya no se usa:
--    - Agotados y Precio minimo salieron del panel: v_disponibilidad,
--      v_precio_minimo_alertas y la tabla precio_minimo (sus minimos
--      cargados se pierden).
--    - Vistas de la limpieza del catalogo de 2025 (fase 15): v_nombres_a_revisar,
--      v_nombres_redundantes, v_productos_sin_ficha.
--    - Funciones que nada llama: fn_clave_molecula (fase 20, de una sola vez),
--      fn_evaluar_calidad_historica (fase 13; la reemplazo Sensibilidad),
--      fn_get_pvp_propio_vigente (fase 1) y fn_eliminar_producto (fase 6; el
--      panel borra por su cuenta y respeta que Consulta no borre).
--    fn_es_agotado se queda: la usa v_enlaces_fallidos.
--
-- ORDEN: despues de fase48. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Lectura de presentacion
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leer_presentacion(p_texto TEXT)
RETURNS TABLE (dosis_mg NUMERIC, tamano NUMERIC, unidad TEXT)
LANGUAGE sql IMMUTABLE
AS $$
    WITH t AS (
        SELECT regexp_replace(lower(COALESCE(p_texto, '')), '([0-9]),([0-9])', '\1.\2', 'g') AS s
    ), d AS (
        SELECT s,
               regexp_match(s, '([0-9]+(?:\.[0-9]+)?)\s*(mg|mcg|g)(?![a-wyz])') AS m,
               regexp_match(s, '(?:^|[^a-z]|mg|mcg)x\s*([0-9]+(?:\.[0-9]+)?)\s*(ml|g)\M') AS xv,
               (SELECT (array_agg(r.x[1] ORDER BY r.o DESC))[1]
                FROM regexp_matches(s, '(?<![/0-9.])([0-9]+(?:\.[0-9]+)?)\s*ml\M', 'g') WITH ORDINALITY AS r(x, o)) AS ml,
               -- "x 30" es cantidad; "x 1.3 gr" o "x 500 mg" no.
               regexp_match(s, '(?:^|[^a-z]|mg|mcg)x\s*([0-9]+)(?![0-9.])(?!\s*(?:mg|mcg|g|gr|grs|ml)\M)') AS xn,
               regexp_match(s, '([0-9]+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|cápsulas|capsula|cápsula|caps|grageas|sobres|ampollas|ampolla|ovulos|óvulos|parches|unidades|und)\M') AS fn
        FROM t
    ), e AS (
        SELECT d.*, CASE WHEN ml::numeric > 5 THEN ml::numeric END AS ml_ok FROM d
    )
    SELECT
        CASE WHEN m IS NULL THEN NULL
             WHEN m[2] = 'g' AND s ~ ('x\s*' || m[1] || '\s*g\M') THEN NULL
             WHEN m[2] = 'mcg' THEN m[1]::numeric / 1000
             WHEN m[2] = 'g' THEN m[1]::numeric * 1000
             ELSE m[1]::numeric END,
        COALESCE(xv[1]::numeric, ml_ok, xn[1]::numeric, fn[1]::numeric),
        CASE WHEN xv IS NOT NULL THEN xv[2]
             WHEN ml_ok IS NOT NULL THEN 'ml'
             WHEN xn IS NOT NULL OR fn IS NOT NULL THEN 'unidad' END
    FROM e;
$$;

-- ----------------------------------------------------------------------------
-- 2. Precios repetidos con la presentacion registrada (columnas al final)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_precios_repetidos
WITH (security_invoker = true)
AS
WITH ultimas AS (
    SELECT DISTINCT ON (fp.publicacion_id)
           fp.id AS captura_id, fp.publicacion_id, fp.fecha_captura,
           fp.precio_full_bs, fp.precio_desc_bs, fp.tasa_bcv,
           fp.sospechoso, fp.revisado_manual, fp.motivo_sospecha, fp.nombre_capturado
    FROM fact_precios fp
    WHERE fp.estado = 'ok' AND fp.disponible
      AND fp.origen = 'scraper'
      AND fp.fecha_captura >= NOW() - INTERVAL '3 days'
    ORDER BY fp.publicacion_id, fp.fecha_captura DESC
),
con AS (
    SELECT u.*, pub.cadena_id, pub.url, pub.producto_id,
           p.nombre AS producto_nombre, lab.nombre AS laboratorio, lab.es_propio,
           COALESCE(pp.id_interno, p.id_interno) AS id_producto_propio,
           pp.nombre AS producto_propio_nombre
    FROM ultimas u
    JOIN publicaciones pub      ON pub.id = u.publicacion_id AND pub.activo
    JOIN dim_productos p        ON p.id = pub.producto_id
    JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
    LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN dim_productos pp  ON pp.id = pe.producto_propio_id
),
grupos AS (
    SELECT cadena_id, precio_full_bs,
           COUNT(DISTINCT publicacion_id) AS enlaces,
           COUNT(DISTINCT producto_id) AS productos,
           BOOL_AND(revisado_manual) AS revisados
    FROM con
    GROUP BY cadena_id, precio_full_bs
    HAVING COUNT(DISTINCT publicacion_id) >= 2 AND COUNT(DISTINCT producto_id) >= 2
)
SELECT c.*, g.enlaces, g.productos,
       c.cadena_id || '|' || c.precio_full_bs::text AS grupo,
       CASE WHEN c.tasa_bcv > 0 THEN ROUND((c.precio_full_bs / c.tasa_bcv)::numeric, 2) END AS precio_usd,
       r.dosis_mg AS registrada_dosis_mg,
       r.tamano   AS registrada_tamano,
       r.unidad   AS registrada_unidad
FROM con c
JOIN grupos g USING (cadena_id, precio_full_bs)
LEFT JOIN LATERAL fn_presentacion_registrada(c.producto_id) r ON TRUE
WHERE NOT g.revisados;

GRANT SELECT ON public.v_precios_repetidos TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Limpieza
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_disponibilidad;
DROP VIEW IF EXISTS public.v_precio_minimo_alertas;
DROP TABLE IF EXISTS public.precio_minimo;

DROP VIEW IF EXISTS public.v_nombres_a_revisar;
DROP VIEW IF EXISTS public.v_nombres_redundantes;
DROP VIEW IF EXISTS public.v_productos_sin_ficha;

DROP FUNCTION IF EXISTS public.fn_clave_molecula(TEXT);
DROP FUNCTION IF EXISTS public.fn_evaluar_calidad_historica(BOOLEAN, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS public.fn_get_pvp_propio_vigente(BIGINT, DATE);
DROP FUNCTION IF EXISTS public.fn_eliminar_producto(TEXT);

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT * FROM fn_leer_presentacion('Prolardii Pharmetique 10 Sobres x 1.3 gr');  -- NULL | 10 | unidad
-- SELECT * FROM fn_leer_presentacion('Losartan Potasico 50 mg x 30 Tabletas');      -- 50 | 30 | unidad
-- SELECT * FROM fn_leer_presentacion('ANALPER JBE 180MG/5ML 120ML');                -- 180 | 120 | ml
