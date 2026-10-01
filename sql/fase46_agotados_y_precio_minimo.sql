-- ============================================================================
-- TRACKFLOW - FASE 46: AGOTADOS Y PRECIO MINIMO PERMITIDO
-- ============================================================================
-- 1. fn_es_agotado(texto): la lectura fallo porque la tienda dice que no hay
--    existencia (no porque la pagina falle). El robot escribe "agotado" en
--    el error; desde este cambio un enlace roto dice "Enlace roto".
-- 2. v_enlaces_fallidos: un producto agotado ya no cuenta como "URL que
--    falla" (la pagina funciona; lo que no hay es existencia).
-- 3. v_disponibilidad: enlaces agotados ahora (desde cuando) y los que
--    volvieron a tener existencia en los ultimos 7 dias. Las lecturas que
--    fallaron por otra cosa (timeout, pagina rota) no dicen nada de la
--    existencia y se saltan.
-- 4. precio_minimo: el precio minimo permitido de cada producto TUYO, en
--    dolares. v_precio_minimo_alertas: tus enlaces (tu producto vendido en
--    una cadena) cuyo precio de venta (la oferta si hay, si no el de lista)
--    quedo por debajo de ese minimo en la ultima lectura, y desde cuando.
--    Es independiente del PVP: el PVP sigue sin entrar en ningun calculo.
--
-- No cambia datos. ORDEN: despues de fase45. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Agotado
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_es_agotado(p_texto TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(p_texto ~* 'agotad|sin existencia|out of stock', FALSE)
       AND NOT COALESCE(p_texto ~* 'enlace roto', FALSE);
$$;

-- ----------------------------------------------------------------------------
-- 2. URL que fallan: sin contar los agotados
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_enlaces_fallidos
WITH (security_invoker = true)
AS
WITH capturas AS (
    SELECT
        f.publicacion_id,
        f.fecha_captura,
        -- Una lectura "agotado" prueba que la pagina funciona: cuenta como
        -- buena para esta vista.
        (f.estado = 'ok' OR public.fn_es_agotado(f.error_mensaje)) AS buena,
        f.error_mensaje,
        ROW_NUMBER() OVER (PARTITION BY f.publicacion_id
                           ORDER BY f.fecha_captura DESC, f.id DESC) AS n
    FROM public.fact_precios f
    WHERE f.fecha_captura > NOW() - INTERVAL '90 days'
),
ultima_buena AS (
    SELECT publicacion_id, MIN(n) AS n
    FROM capturas
    WHERE buena
    GROUP BY publicacion_id
)
SELECT
    c.publicacion_id,
    COUNT(*)::int AS fallos_seguidos,
    MAX(c.fecha_captura) AS ultima_falla,
    (ARRAY_AGG(c.error_mensaje ORDER BY c.n))[1] AS ultimo_error
FROM capturas c
LEFT JOIN ultima_buena b ON b.publicacion_id = c.publicacion_id
WHERE NOT c.buena
  AND c.n < COALESCE(b.n, 2147483647)
GROUP BY c.publicacion_id;

GRANT SELECT ON public.v_enlaces_fallidos TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Agotados y de vuelta en existencia
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_disponibilidad
WITH (security_invoker = true)
AS
WITH lecturas AS (
    SELECT f.publicacion_id, f.fecha_captura,
           CASE WHEN f.estado = 'ok' AND f.disponible THEN 'hay'
                ELSE 'agotado' END AS situacion
    FROM public.fact_precios f
    WHERE f.fecha_captura > NOW() - INTERVAL '60 days'
      AND ((f.estado = 'ok' AND f.disponible) OR public.fn_es_agotado(f.error_mensaje))
),
ultima AS (
    SELECT DISTINCT ON (publicacion_id) publicacion_id, situacion, fecha_captura
    FROM lecturas
    ORDER BY publicacion_id, fecha_captura DESC
),
tramo AS (
    SELECT u.publicacion_id, u.situacion, u.fecha_captura AS ultima_lectura,
           contraria.fecha AS ultima_contraria,
           (SELECT MIN(l.fecha_captura) FROM lecturas l
            WHERE l.publicacion_id = u.publicacion_id AND l.situacion = u.situacion
              AND l.fecha_captura > COALESCE(contraria.fecha, '-infinity'::timestamptz)) AS desde
    FROM ultima u
    LEFT JOIN LATERAL (
        SELECT MAX(l.fecha_captura) AS fecha FROM lecturas l
        WHERE l.publicacion_id = u.publicacion_id AND l.situacion <> u.situacion
    ) contraria ON TRUE
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

GRANT SELECT ON public.v_disponibilidad TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Precio minimo permitido
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.precio_minimo (
    producto_id    BIGINT PRIMARY KEY REFERENCES public.dim_productos(id) ON DELETE CASCADE,
    minimo_usd     NUMERIC(12, 4) CHECK (minimo_usd IS NULL OR minimo_usd > 0),
    actualizado    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_por TEXT
);

ALTER TABLE public.precio_minimo ENABLE ROW LEVEL SECURITY;
-- Leer, crear y cambiar: cualquier usuario activo (consulta tambien: quitar un
-- minimo es dejarlo vacio, no borrar la fila). Borrar: solo administrador.
DROP POLICY IF EXISTS precio_minimo_leer ON public.precio_minimo;
CREATE POLICY precio_minimo_leer ON public.precio_minimo FOR SELECT TO authenticated USING ((SELECT public.fn_usuario_activo()));
DROP POLICY IF EXISTS precio_minimo_crear ON public.precio_minimo;
CREATE POLICY precio_minimo_crear ON public.precio_minimo FOR INSERT TO authenticated WITH CHECK ((SELECT public.fn_usuario_activo()));
DROP POLICY IF EXISTS precio_minimo_cambiar ON public.precio_minimo;
CREATE POLICY precio_minimo_cambiar ON public.precio_minimo FOR UPDATE TO authenticated USING ((SELECT public.fn_usuario_activo())) WITH CHECK ((SELECT public.fn_usuario_activo()));
DROP POLICY IF EXISTS precio_minimo_borrar ON public.precio_minimo;
CREATE POLICY precio_minimo_borrar ON public.precio_minimo FOR DELETE TO authenticated USING ((SELECT public.fn_es_admin()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.precio_minimo TO authenticated;

CREATE OR REPLACE VIEW public.v_precio_minimo_alertas
WITH (security_invoker = true)
AS
WITH minimos AS (
    SELECT pm.producto_id, pm.minimo_usd
    FROM public.precio_minimo pm
    WHERE pm.minimo_usd > 0
),
-- Tus enlaces: tu propio producto publicado en una cadena.
enlaces AS (
    SELECT pub.id AS publicacion_id, pub.cadena_id, pub.url, m.producto_id, m.minimo_usd
    FROM minimos m
    JOIN public.publicaciones pub ON pub.producto_id = m.producto_id AND pub.activo
),
lecturas AS (
    SELECT e.publicacion_id, f.fecha_captura, f.precio_full_bs, f.precio_desc_bs, f.tasa_bcv,
           COALESCE(f.precio_desc_bs, f.precio_full_bs) / f.tasa_bcv AS venta_usd,
           e.minimo_usd
    FROM enlaces e
    JOIN public.fact_precios f ON f.publicacion_id = e.publicacion_id
    WHERE f.estado = 'ok' AND f.disponible AND NOT f.sospechoso
      AND f.tasa_bcv > 0 AND f.precio_full_bs > 0
      AND f.fecha_captura > NOW() - INTERVAL '60 days'
),
ultima AS (
    SELECT DISTINCT ON (publicacion_id) *
    FROM lecturas
    ORDER BY publicacion_id, fecha_captura DESC
)
SELECT u.publicacion_id,
       e.cadena_id,
       e.url,
       p.id_interno AS id_producto_propio,
       p.nombre AS producto_nombre,
       u.minimo_usd,
       ROUND(u.venta_usd::numeric, 4) AS venta_usd,
       ROUND(u.precio_full_bs::numeric, 2) AS precio_full_bs,
       ROUND(u.precio_desc_bs::numeric, 2) AS precio_desc_bs,
       ROUND(((u.venta_usd / u.minimo_usd - 1) * 100)::numeric, 1) AS dif_pct,
       u.fecha_captura AS ultima_lectura,
       -- Desde: la primera lectura bajo el minimo despues de la ultima que lo respeto.
       (SELECT MIN(l.fecha_captura) FROM lecturas l
        WHERE l.publicacion_id = u.publicacion_id
          AND l.venta_usd < l.minimo_usd * 0.995
          AND l.fecha_captura > COALESCE((SELECT MAX(l2.fecha_captura) FROM lecturas l2
                                          WHERE l2.publicacion_id = u.publicacion_id
                                            AND l2.venta_usd >= l2.minimo_usd * 0.995), '-infinity'::timestamptz)) AS desde
FROM ultima u
JOIN enlaces e ON e.publicacion_id = u.publicacion_id
JOIN public.dim_productos p ON p.id = e.producto_id
WHERE u.venta_usd < u.minimo_usd * 0.995;   -- 0,5 % de empate, como el panel

GRANT SELECT ON public.v_precio_minimo_alertas TO authenticated;

-- COMPROBACION
/*
SELECT estado, count(*) FROM v_disponibilidad GROUP BY 1;
SELECT count(*) FROM v_precio_minimo_alertas;
*/
