-- ============================================================================
-- FASE 53: cadenas de baja, precios viejos y molecula del competidor
-- ----------------------------------------------------------------------------
-- 1. Cadena de baja (dim_cadenas.activo = false): sus precios dejan de verse
--    en TODO el panel (graficos, promedios, mapas, fichas, Experimental). No
--    se borra nada: al reactivarla vuelven a verse, con su historial. El robot
--    tampoco la lee (scraper/farmatodo.py). Los enlaces siguen visibles en
--    Relacion y Cadenas para poder administrarlos.
--    Como: una politica RESTRICTIVA de lectura en fact_precios. Las vistas
--    del panel son security_invoker y las funciones de analisis son
--    SECURITY INVOKER, asi que todas la respetan sin tocarlas una por una.
-- 2. Precio viejo: si el ultimo precio valido de un enlace tiene MAS DE 15
--    DIAS, no cuenta como precio actual (v_ultimo_precio_valido y
--    v_variacion). El historial queda. v_precios_viejos los lista para la
--    campana de Avisos.
-- 3. Molecula del competidor (dim_productos.molecula_competidor): la que
--    declara la caja del competidor, sobre todo en marcas. Antes se copiaba
--    la de tu producto y un cruce errado (Donepecilo contra una marca de
--    Nifedipina) no se podia ver. v_relaciones_molecula junta cada relacion
--    con las dos moleculas para «Relaciones a revisar» (Experimental).
--
-- ORDEN: despues de fase52. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Precios de las cadenas de baja: ocultos para el panel
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER: lee publicaciones y dim_cadenas sin pasar por su RLS.
CREATE OR REPLACE FUNCTION public.fn_publicaciones_de_baja()
RETURNS BIGINT[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT coalesce(array_agg(pub.id), ARRAY[]::BIGINT[])
    FROM public.publicaciones pub
    JOIN public.dim_cadenas c ON c.id = pub.cadena_id
    WHERE c.activo IS FALSE;
$$;
GRANT EXECUTE ON FUNCTION public.fn_publicaciones_de_baja() TO authenticated;

-- El (SELECT ...) hace que la lista se calcule una vez por consulta.
DROP POLICY IF EXISTS fact_precios_sin_cadenas_de_baja ON public.fact_precios;
CREATE POLICY fact_precios_sin_cadenas_de_baja ON public.fact_precios
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (publicacion_id <> ALL (CAST((SELECT public.fn_publicaciones_de_baja()) AS BIGINT[])));

-- ----------------------------------------------------------------------------
-- 2. Precio actual: solo si tiene 15 dias o menos
-- ----------------------------------------------------------------------------
-- Mismas columnas que fase 2; solo se suma la condicion de fecha.
CREATE OR REPLACE VIEW public.v_ultimo_precio_valido
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (fp.publicacion_id)
    fp.id AS fact_precio_id,
    fp.publicacion_id,
    pub.producto_id,
    pub.cadena_id,
    p.id_interno,
    p.nombre AS producto_nombre,
    lab.nombre AS laboratorio_nombre,
    lab.es_propio,
    m.nombre AS marca_nombre,
    pub.url,
    fp.fecha_captura,
    (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha_local,
    ((NOW() AT TIME ZONE 'America/Caracas')::date - (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date) AS dias_antiguedad,
    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_vigente_bs,
    ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv), 2) AS precio_vigente_usd,
    fp.tasa_bcv,
    fp.tiene_promocion,
    tp.codigo AS tipo_promocion_codigo,
    fp.promo_texto_raw,
    ROUND(
        (COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv) *
        (COALESCE(tp.unidades_paga, 1) / COALESCE(tp.unidades_lleva, 1)),
        2
    ) AS precio_efectivo_unidad_usd
FROM public.fact_precios fp
JOIN public.publicaciones pub ON pub.id = fp.publicacion_id
JOIN public.dim_productos p ON p.id = pub.producto_id
JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN public.dim_marcas m ON m.id = p.marca_id
LEFT JOIN public.dim_tipos_promocion tp ON tp.id = fp.tipo_promocion_id
WHERE fp.estado = 'ok'
  AND NOT fp.sospechoso
  AND fp.disponible = TRUE
  AND fp.fecha_captura >= NOW() - INTERVAL '15 days'
ORDER BY fp.publicacion_id, fp.fecha_captura DESC;

-- v_variacion (fase 48) con la misma regla: sin precio de los ultimos 15
-- dias, el enlace no tiene «precio actual» ni cambios.
CREATE OR REPLACE VIEW public.v_variacion
WITH (security_invoker = true)
AS
WITH diario AS MATERIALIZED (
    SELECT * FROM public.v_precio_diario
),
ultimo AS (
    SELECT * FROM (
        SELECT DISTINCT ON (d.publicacion_id) d.*
        FROM diario d
        ORDER BY d.publicacion_id, d.fecha_local DESC
    ) u
    WHERE u.fecha_local >= (NOW() AT TIME ZONE 'America/Caracas')::date - 15
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

-- Enlaces activos (de cadenas activas) cuyo ultimo precio valido tiene mas
-- de 15 dias: la campana de Avisos los cuenta para revisarlos.
CREATE OR REPLACE VIEW public.v_precios_viejos
WITH (security_invoker = true)
AS
SELECT
    pub.id AS publicacion_id,
    pub.cadena_id,
    pub.url,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    COALESCE(p_propio.nombre, p.nombre) AS producto_propio_nombre,
    p.nombre AS producto_nombre,
    lab.nombre AS laboratorio,
    lab.es_propio,
    u.fecha_captura AS ultima_lectura,
    ((NOW() AT TIME ZONE 'America/Caracas')::date - (u.fecha_captura AT TIME ZONE 'America/Caracas')::date) AS dias
FROM public.publicaciones pub
JOIN public.dim_cadenas c ON c.id = pub.cadena_id AND c.activo IS NOT FALSE
JOIN public.dim_productos p ON p.id = pub.producto_id
JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN public.producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN public.dim_productos p_propio ON p_propio.id = pe.producto_propio_id
JOIN LATERAL (
    SELECT fp.fecha_captura
    FROM public.fact_precios fp
    WHERE fp.publicacion_id = pub.id AND fp.estado = 'ok' AND NOT fp.sospechoso AND fp.disponible
    ORDER BY fp.fecha_captura DESC
    LIMIT 1
) u ON TRUE
WHERE pub.activo IS NOT FALSE
  AND u.fecha_captura < NOW() - INTERVAL '15 days';

GRANT SELECT ON public.v_ultimo_precio_valido, public.v_variacion, public.v_precios_viejos TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Molecula del competidor
-- ----------------------------------------------------------------------------
ALTER TABLE public.dim_productos ADD COLUMN IF NOT EXISTS molecula_competidor TEXT;
COMMENT ON COLUMN public.dim_productos.molecula_competidor IS
    'Molecula (principio activo) que declara el producto del competidor. Vacia: se intenta leer del nombre.';

-- Cada relacion activa: tu producto y su molecula, el competidor y la suya.
CREATE OR REPLACE VIEW public.v_relaciones_molecula
WITH (security_invoker = true)
AS
SELECT
    pe.id AS equivalencia_id,
    pr.id AS propio_db_id,
    pr.id_interno AS propio_id,
    pr.nombre AS propio_nombre,
    (SELECT string_agg(pa.nombre, ' + ' ORDER BY pp.es_principal DESC, pp.id)
       FROM public.producto_principios pp
       JOIN public.dim_principios_activos pa ON pa.id = pp.principio_activo_id
      WHERE pp.producto_id = pr.id) AS propio_molecula,
    pr.tipo_mercado AS propio_tipo,
    co.id AS competidor_db_id,
    co.nombre AS competidor_nombre,
    lab.nombre AS competidor_laboratorio,
    co.tipo_mercado AS competidor_tipo,
    co.molecula_competidor,
    (SELECT string_agg(DISTINCT pub.cadena_id, ', ')
       FROM public.publicaciones pub
      WHERE pub.producto_id = co.id AND pub.activo IS NOT FALSE) AS cadenas
FROM public.producto_equivalencias pe
JOIN public.dim_productos pr ON pr.id = pe.producto_propio_id
JOIN public.dim_productos co ON co.id = pe.producto_competidor_id
JOIN public.dim_laboratorios lab ON lab.id = co.laboratorio_id
WHERE pe.activo AND NOT lab.es_propio;

GRANT SELECT ON public.v_relaciones_molecula TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT id, nombre, activo FROM dim_cadenas ORDER BY nombre;
-- SELECT cadena_id, count(*) FROM v_precios_viejos GROUP BY 1;
-- SELECT * FROM v_relaciones_molecula LIMIT 20;
