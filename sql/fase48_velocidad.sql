-- ============================================================================
-- TRACKFLOW - FASE 48: VELOCIDAD DE CARGA
-- ============================================================================
-- Las pantallas tardaban por cuatro cosas de la base:
--   1. JIT: Postgres "compila" las consultas que cree grandes y en estas
--      tablas eso cuesta mas que la consulta misma (hasta medio segundo por
--      pedido). Se apaga para el rol del panel (authenticated).
--   2. v_variacion (Precios, Dashboard): buscaba el precio de hace 1, 7 y 15
--      dias recorriendo el historial de cada publicacion tres veces. Ahora lo
--      ordena una sola vez. Mismas columnas y mismos datos.
--   3. Revision de capturas: la vista calculaba la presentacion y el
--      historial de TODAS las capturas dudosas o revisadas (miles) para
--      mostrar 500. fn_capturas_revision elige primero las 500 y calcula solo
--      esas. Mismas columnas que v_capturas_revision (que se queda igual).
--   4. v_disponibilidad (Agotados y la campana de avisos): misma idea que 2.
--
-- No cambia datos. ORDEN: despues de fase47. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Sin JIT para el panel. PostgREST toma el cambio al recargar su config.
-- ----------------------------------------------------------------------------
ALTER ROLE authenticated SET jit = off;
NOTIFY pgrst, 'reload config';

-- ----------------------------------------------------------------------------
-- 2. v_variacion
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_variacion
WITH (security_invoker = true)
AS
WITH diario AS MATERIALIZED (
    SELECT * FROM public.v_precio_diario
),
ultimo AS (
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM diario d
    ORDER BY d.publicacion_id, d.fecha_local DESC
),
r1 AS (
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM diario d JOIN ultimo u ON u.publicacion_id = d.publicacion_id
    WHERE d.fecha_local <= u.fecha_local - 1
    ORDER BY d.publicacion_id, d.fecha_local DESC
),
r7 AS (
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM diario d JOIN ultimo u ON u.publicacion_id = d.publicacion_id
    WHERE d.fecha_local <= u.fecha_local - 7
    ORDER BY d.publicacion_id, d.fecha_local DESC
),
r15 AS (
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM diario d JOIN ultimo u ON u.publicacion_id = d.publicacion_id
    WHERE d.fecha_local <= u.fecha_local - 15
    ORDER BY d.publicacion_id, d.fecha_local DESC
)
SELECT
    u.publicacion_id, u.id_producto_propio, u.id_interno, u.cadena_id, u.producto_nombre, u.laboratorio, u.es_propio,
    u.fecha_local AS fecha_actual, u.precio_full_bs AS precio_actual_full_bs, u.precio_desc_bs AS precio_actual_desc_bs,
    u.precio_vigente_bs AS precio_actual_bs, u.precio_vigente_usd AS precio_actual_usd, u.tasa_bcv AS tasa_actual,
    r1.fecha_local AS fecha_1d, r1.precio_full_bs AS precio_1d_full_bs, r1.precio_desc_bs AS precio_1d_desc_bs,
    r1.precio_vigente_bs AS precio_1d_bs, r1.precio_vigente_usd AS precio_1d_usd, r1.tasa_bcv AS tasa_1d,
    r7.fecha_local AS fecha_7d, r7.precio_full_bs AS precio_7d_full_bs, r7.precio_desc_bs AS precio_7d_desc_bs,
    r7.precio_vigente_bs AS precio_7d_bs, r7.precio_vigente_usd AS precio_7d_usd, r7.tasa_bcv AS tasa_7d,
    r15.fecha_local AS fecha_15d, r15.precio_full_bs AS precio_15d_full_bs, r15.precio_desc_bs AS precio_15d_desc_bs,
    r15.precio_vigente_bs AS precio_15d_bs, r15.precio_vigente_usd AS precio_15d_usd, r15.tasa_bcv AS tasa_15d
FROM ultimo u
LEFT JOIN r1 ON r1.publicacion_id = u.publicacion_id
LEFT JOIN r7 ON r7.publicacion_id = u.publicacion_id
LEFT JOIN r15 ON r15.publicacion_id = u.publicacion_id;

-- ----------------------------------------------------------------------------
-- 3. Revision de capturas: primero se eligen, despues se calculan.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fact_precios_revisadas
    ON public.fact_precios (fecha_captura DESC)
    WHERE revisado_manual AND motivo_sospecha IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_capturas_revision(p_estado TEXT, p_limite INT DEFAULT 500)
RETURNS SETOF public.v_capturas_revision
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
SET jit = off
AS $$
WITH elegidas AS (
    SELECT fp.*
    FROM fact_precios fp
    WHERE CASE p_estado
            WHEN 'pendiente' THEN fp.sospechoso AND NOT fp.revisado_manual
            WHEN 'erronea'   THEN fp.revisado_manual AND fp.motivo_sospecha IS NOT NULL AND fp.sospechoso
            WHEN 'valida'    THEN fp.revisado_manual AND fp.motivo_sospecha IS NOT NULL AND NOT fp.sospechoso
            ELSE FALSE END
    ORDER BY fp.fecha_captura DESC
    LIMIT GREATEST(LEAST(COALESCE(p_limite, 500), 2000), 1)
),
pendientes AS (
    SELECT f.publicacion_id, COUNT(*) AS n
    FROM fact_precios f
    WHERE f.sospechoso AND NOT f.revisado_manual
      AND f.publicacion_id IN (SELECT publicacion_id FROM elegidas)
    GROUP BY f.publicacion_id
)
SELECT
    fp.id, fp.publicacion_id, pub.cadena_id, pub.url, pub.activo,
    p.id_interno, COALESCE(p_propio.id_interno, p.id_interno), p.nombre, p_propio.nombre,
    lab.nombre, lab.es_propio,
    fp.fecha_captura, fp.precio_full_bs, fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs), fp.tasa_bcv,
    CASE WHEN fp.tasa_bcv > 0 THEN ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv)::numeric, 2) END,
    fp.motivo_sospecha, fp.similitud_nombre, fp.nombre_capturado,
    CASE WHEN NOT fp.revisado_manual THEN 'pendiente' WHEN fp.sospechoso THEN 'erronea' ELSE 'valida' END,
    ant.fecha_captura, ant.precio_bs,
    CASE WHEN ant.precio_bs > 0
         THEN ROUND((((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) - ant.precio_bs) / ant.precio_bs) * 100)::numeric, 1) END,
    sig.fecha_captura, sig.precio_bs,
    COALESCE(pe2.n, 0),
    l.dosis_mg, l.tamano, l.unidad, r.dosis_mg, r.tamano, r.unidad,
    COALESCE(h_antes.lecturas, '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('f', fp.fecha_captura,
             'p', COALESCE(fp.precio_desc_bs, fp.precio_full_bs), 's', fp.sospechoso, 'a', TRUE))
      || COALESCE(h_despues.lecturas, '[]'::jsonb)
FROM elegidas fp
JOIN publicaciones pub      ON pub.id = fp.publicacion_id
JOIN dim_productos p        ON p.id = pub.producto_id
JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio    ON p_propio.id = pe.producto_propio_id
LEFT JOIN pendientes pe2            ON pe2.publicacion_id = fp.publicacion_id
LEFT JOIN LATERAL fn_leer_presentacion(fp.nombre_capturado) l ON TRUE
LEFT JOIN LATERAL fn_presentacion_registrada(p.id) r ON TRUE
LEFT JOIN LATERAL (
    SELECT a.fecha_captura, COALESCE(a.precio_desc_bs, a.precio_full_bs) AS precio_bs
    FROM fact_precios a
    WHERE a.publicacion_id = fp.publicacion_id AND a.fecha_captura < fp.fecha_captura
      AND a.estado = 'ok' AND a.disponible AND NOT a.sospechoso
    ORDER BY a.fecha_captura DESC LIMIT 1
) ant ON TRUE
LEFT JOIN LATERAL (
    SELECT s.fecha_captura, COALESCE(s.precio_desc_bs, s.precio_full_bs) AS precio_bs
    FROM fact_precios s
    WHERE s.publicacion_id = fp.publicacion_id AND s.fecha_captura > fp.fecha_captura
      AND s.estado = 'ok' AND s.disponible
    ORDER BY s.fecha_captura ASC LIMIT 1
) sig ON TRUE
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('f', x.fecha_captura, 'p', x.precio, 's', x.sospechoso) ORDER BY x.fecha_captura) AS lecturas
    FROM (SELECT b.fecha_captura, COALESCE(b.precio_desc_bs, b.precio_full_bs) AS precio, b.sospechoso
          FROM fact_precios b
          WHERE b.publicacion_id = fp.publicacion_id AND b.fecha_captura < fp.fecha_captura
            AND b.estado = 'ok' AND b.disponible
          ORDER BY b.fecha_captura DESC LIMIT 8) x
) h_antes ON TRUE
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('f', x.fecha_captura, 'p', x.precio, 's', x.sospechoso) ORDER BY x.fecha_captura) AS lecturas
    FROM (SELECT d.fecha_captura, COALESCE(d.precio_desc_bs, d.precio_full_bs) AS precio, d.sospechoso
          FROM fact_precios d
          WHERE d.publicacion_id = fp.publicacion_id AND d.fecha_captura > fp.fecha_captura
            AND d.estado = 'ok' AND d.disponible
          ORDER BY d.fecha_captura ASC LIMIT 4) x
) h_despues ON TRUE
ORDER BY fp.fecha_captura DESC;
$$;

GRANT EXECUTE ON FUNCTION public.fn_capturas_revision(TEXT, INT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. v_disponibilidad
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_disponibilidad
WITH (security_invoker = true)
AS
WITH lecturas AS MATERIALIZED (
    SELECT f.publicacion_id, f.fecha_captura,
           CASE WHEN f.estado = 'ok' AND f.disponible THEN 'hay' ELSE 'agotado' END AS situacion
    FROM public.fact_precios f
    WHERE f.fecha_captura > NOW() - INTERVAL '60 days'
      AND ((f.estado = 'ok' AND f.disponible) OR public.fn_es_agotado(f.error_mensaje))
),
ultima AS (
    SELECT DISTINCT ON (publicacion_id) publicacion_id, situacion, fecha_captura AS ultima_lectura
    FROM lecturas
    ORDER BY publicacion_id, fecha_captura DESC
),
contraria AS (
    SELECT u.publicacion_id, MAX(l.fecha_captura) AS fecha
    FROM ultima u JOIN lecturas l ON l.publicacion_id = u.publicacion_id AND l.situacion <> u.situacion
    GROUP BY u.publicacion_id
),
tramo AS (
    SELECT u.publicacion_id, u.situacion, u.ultima_lectura, c.fecha AS ultima_contraria,
           MIN(l.fecha_captura) AS desde
    FROM ultima u
    LEFT JOIN contraria c ON c.publicacion_id = u.publicacion_id
    JOIN lecturas l ON l.publicacion_id = u.publicacion_id AND l.situacion = u.situacion
                   AND l.fecha_captura > COALESCE(c.fecha, '-infinity'::timestamptz)
    GROUP BY u.publicacion_id, u.situacion, u.ultima_lectura, c.fecha
)
SELECT t.publicacion_id,
       CASE WHEN t.situacion = 'agotado' THEN 'agotado' ELSE 'volvio' END AS estado,
       t.desde,
       t.ultima_lectura,
       pub.cadena_id,
       pub.url,
       lab.es_propio,
       p.nombre AS producto_nombre,
       lab.nombre AS laboratorio,
       COALESCE(pp.id_interno, p.id_interno) AS id_producto_propio,
       COALESCE(pp.nombre, p.nombre) AS producto_propio_nombre
FROM tramo t
JOIN public.publicaciones pub    ON pub.id = t.publicacion_id AND pub.activo
JOIN public.dim_productos p      ON p.id = pub.producto_id
JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN public.producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN public.dim_productos pp ON pp.id = pe.producto_propio_id
WHERE t.situacion = 'agotado'
   OR (t.ultima_contraria IS NOT NULL AND t.desde > NOW() - INTERVAL '7 days');

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT COUNT(*) FROM v_variacion;
-- SELECT estado_revision, COUNT(*) FROM fn_capturas_revision('pendiente') GROUP BY 1;
-- SELECT estado, COUNT(*) FROM v_disponibilidad GROUP BY 1;
