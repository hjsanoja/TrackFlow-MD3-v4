-- ============================================================================
-- TRACKFLOW - FASE 34: REVISION DE CAPTURAS, PENDIENTES Y YA REVISADAS
-- ============================================================================
-- La bandeja (fase 12) solo mostraba las capturas pendientes. Al marcar una
-- como "Es valida" o "Es erronea" desaparecia, y no habia forma de verla de
-- nuevo si se marco por error.
--
-- Esta fase agrega:
--   1. v_capturas_revision: las pendientes Y las ya revisadas, con su estado
--      (pendiente / valida / erronea), la lectura anterior y la SIGUIENTE del
--      mismo enlace (para sugerir si fue un error de lectura o un cambio real)
--      y el producto propio con el que se compara.
--   2. v_calidad_datos: "revisadas" deja de contar los precios cargados a mano
--      (tambien llevan revisado_manual) y suma "validas".
--
-- No cambia datos. Volver a revisar una captura (revisado_manual = FALSE,
-- sospechoso = TRUE) ya lo permite el permiso de la fase 12.
--
-- ORDEN DE EJECUCION: despues de fase33. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. CAPTURAS PARA REVISAR Y YA REVISADAS
-- ----------------------------------------------------------------------------
-- Revisada por la bandeja = revisado_manual con motivo de sospecha. Los
-- precios cargados a mano llevan revisado_manual pero no motivo: no entran.
CREATE OR REPLACE VIEW public.v_capturas_revision
WITH (security_invoker = true)
AS
SELECT
    fp.id                          AS captura_id,
    fp.publicacion_id,
    pub.cadena_id,
    pub.url,
    pub.activo                     AS enlace_activo,
    p.id_interno,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    p.nombre                       AS producto_nombre,
    p_propio.nombre                AS producto_propio_nombre,
    lab.nombre                     AS laboratorio,
    lab.es_propio,

    fp.fecha_captura,
    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_bs,
    fp.tasa_bcv,
    CASE WHEN fp.tasa_bcv > 0
         THEN ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv)::numeric, 2)
         ELSE NULL END             AS precio_usd,

    fp.motivo_sospecha,
    fp.similitud_nombre,
    fp.nombre_capturado,
    CASE WHEN NOT fp.revisado_manual THEN 'pendiente'
         WHEN fp.sospechoso          THEN 'erronea'
         ELSE 'valida' END         AS estado_revision,

    -- La ultima lectura buena ANTES de esta
    ant.fecha_captura              AS fecha_anterior,
    ant.precio_bs                  AS precio_anterior_bs,
    CASE WHEN ant.precio_bs > 0
         THEN ROUND((((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) - ant.precio_bs)
                      / ant.precio_bs) * 100)::numeric, 1)
         ELSE NULL END             AS variacion_pct,

    -- La primera lectura DESPUES de esta: si repite el precio, el cambio fue
    -- real; si vuelve al anterior, fue un error de lectura.
    sig.fecha_captura              AS fecha_siguiente,
    sig.precio_bs                  AS precio_siguiente_bs,
    -- Cuantas veces se marco este mismo enlace y siguen pendientes
    COUNT(*) FILTER (WHERE NOT fp.revisado_manual)
        OVER (PARTITION BY fp.publicacion_id) AS pendientes_enlace

FROM fact_precios fp
JOIN publicaciones pub      ON pub.id = fp.publicacion_id
JOIN dim_productos p        ON p.id = pub.producto_id
JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe
       ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio
       ON p_propio.id = pe.producto_propio_id
LEFT JOIN LATERAL (
    SELECT a.fecha_captura, COALESCE(a.precio_desc_bs, a.precio_full_bs) AS precio_bs
    FROM fact_precios a
    WHERE a.publicacion_id = fp.publicacion_id
      AND a.fecha_captura < fp.fecha_captura
      AND a.estado = 'ok' AND a.disponible AND NOT a.sospechoso
    ORDER BY a.fecha_captura DESC
    LIMIT 1
) ant ON TRUE
LEFT JOIN LATERAL (
    SELECT s.fecha_captura, COALESCE(s.precio_desc_bs, s.precio_full_bs) AS precio_bs
    FROM fact_precios s
    WHERE s.publicacion_id = fp.publicacion_id
      AND s.fecha_captura > fp.fecha_captura
      AND s.estado = 'ok' AND s.disponible
    ORDER BY s.fecha_captura ASC
    LIMIT 1
) sig ON TRUE
WHERE (fp.sospechoso AND NOT fp.revisado_manual)
   OR (fp.revisado_manual AND fp.motivo_sospecha IS NOT NULL);

GRANT SELECT ON public.v_capturas_revision TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. RESUMEN: REVISADAS SIN LOS PRECIOS CARGADOS A MANO
-- ----------------------------------------------------------------------------
-- Mismas columnas y en el mismo orden que la fase 12, mas "validas" al final.
CREATE OR REPLACE VIEW public.v_calidad_datos
WITH (security_invoker = true)
AS
SELECT
    COUNT(*)                                             AS capturas_totales,
    COUNT(*) FILTER (WHERE sospechoso)                   AS sospechosas,
    COUNT(*) FILTER (WHERE sospechoso AND NOT revisado_manual) AS pendientes,
    COUNT(*) FILTER (WHERE revisado_manual AND motivo_sospecha IS NOT NULL) AS revisadas,
    COUNT(*) FILTER (WHERE revisado_manual AND sospechoso)     AS descartadas,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'nombre')         AS por_nombre,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'variacion_precio') AS por_precio,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'ambos')          AS por_ambos,
    COUNT(*) FILTER (WHERE motivo_sospecha = 'legacy')         AS legacy,
    ROUND(
      (COUNT(*) FILTER (WHERE NOT sospechoso)::numeric
       / NULLIF(COUNT(*), 0)) * 100, 1)                  AS porcentaje_limpio,
    COUNT(*) FILTER (WHERE revisado_manual AND NOT sospechoso AND motivo_sospecha IS NOT NULL) AS validas
FROM fact_precios;

-- ----------------------------------------------------------------------------
-- VERIFICACION
-- ----------------------------------------------------------------------------
/*
SELECT estado_revision, COUNT(*) FROM v_capturas_revision GROUP BY 1;
SELECT * FROM v_calidad_datos;
*/
