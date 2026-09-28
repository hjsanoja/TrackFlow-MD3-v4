-- ============================================================================
-- TRACKFLOW - FASE 44: PRECIOS REPETIDOS
-- ============================================================================
-- En algunas tiendas nuevas (p. ej. Farmabien) el robot leia un monto que se
-- repite en todas las paginas (envio, carrito, banner) en vez del precio del
-- producto: productos distintos quedaban con el MISMO precio al centavo.
--
-- 1. Motivo nuevo 'precio_repetido': el robot marca como dudosas las lecturas
--    de 3 o mas enlaces de la misma tienda con el mismo precio exacto.
-- 2. v_precios_repetidos: la ultima lectura de cada enlace (3 dias) agrupada
--    por cadena y precio exacto, cuando el precio se repite en 2 o mas
--    enlaces de productos distintos. Los grupos ya revisados no salen.
--
-- No cambia datos. ORDEN: despues de fase43. Es idempotente.
-- ============================================================================

SET search_path = public;

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.fact_precios'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%motivo_sospecha%'
    LOOP
        EXECUTE format('ALTER TABLE public.fact_precios DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE public.fact_precios ADD CONSTRAINT fact_precios_motivo_sospecha_check
    CHECK (motivo_sospecha IN ('nombre', 'variacion_precio', 'ambos', 'legacy', 'presentacion', 'precio_repetido'));

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
       CASE WHEN c.tasa_bcv > 0 THEN ROUND((c.precio_full_bs / c.tasa_bcv)::numeric, 2) END AS precio_usd
FROM con c
JOIN grupos g USING (cadena_id, precio_full_bs)
WHERE NOT g.revisados;

GRANT SELECT ON public.v_precios_repetidos TO authenticated;

-- COMPROBACION: grupos por cadena
/*
SELECT cadena_id, precio_full_bs, enlaces, productos FROM v_precios_repetidos
GROUP BY 1, 2, 3, 4 ORDER BY enlaces DESC;
*/
