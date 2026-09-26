-- ============================================================================
-- FASE 28: tendencia de tu posicion y cambios desde tu ultima visita
-- ============================================================================
-- Dos funciones para el Dashboard. Las dos hacen el calculo en la base y
-- devuelven poco, para no bajar el historico completo al navegador (era lo
-- que hacia lento el panel).
--
--   1. fn_posicion_productos(desde, hasta, ...): por dia y por producto
--      propio, tu precio, el minimo y el promedio de la competencia en
--      dolares (a la tasa de cada captura). Usa el ultimo precio conocido de
--      cada enlace en los 7 dias anteriores, asi un dia sin lectura no hace
--      saltar la linea.
--      fn_tendencia_posicion(dias, ...): lo mismo resumido por dia (la
--      mediana de "frente al promedio" y cuantos productos eres el mas
--      barato o el mas caro).
--   2. fn_cambios_desde(momento): los enlaces cuyo precio cambio desde ese
--      momento (el de antes y el de ahora, con la tasa de cada uno). Se mide
--      en dolares: la subida diaria del bolivar no cuenta como cambio.
--
-- "Tu precio" = el mas bajo de tus enlaces (laboratorio propio); si no hay,
-- el PVP vigente ese dia. Por unidad = el precio dividido entre las unidades
-- del empaque (cantidad_contenido de la ficha).
--
--   3. La vista productos_competencia suma dos columnas al final:
--      unidades_empaque y unidad_contenido del producto del enlace. Asi el
--      precio por unidad de un competidor sale de su ficha y no de adivinar
--      las unidades leyendo su nombre. (Un 1 es el valor por defecto de los
--      competidores: el panel lo toma como "no se sabe".)
--
-- No cambia datos. Se puede correr mas de una vez.
-- ============================================================================

-- Indice para buscar "el ultimo precio de este enlace antes de tal fecha".
-- (Ya existe en la mayoria de las bases: fase 1.)
CREATE INDEX IF NOT EXISTS idx_fact_precios_ultimo
    ON public.fact_precios (publicacion_id, fecha_captura DESC);

-- ----------------------------------------------------------------------------
-- 1. POSICION POR DIA Y PRODUCTO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_posicion_productos(
    p_desde DATE,
    p_hasta DATE,
    p_con_descuento BOOLEAN DEFAULT FALSE,
    p_por_unidad BOOLEAN DEFAULT FALSE,
    p_cadena TEXT DEFAULT NULL,          -- comparar solo contra esta cadena
    p_productos TEXT[] DEFAULT NULL      -- id_interno de los productos (NULL = todos)
)
RETURNS TABLE (
    fecha DATE,
    id_interno TEXT,
    tu_precio_usd NUMERIC,
    fuente TEXT,              -- 'enlace' o 'pvp'
    minimo_usd NUMERIC,
    promedio_usd NUMERIC,
    competidores INT,
    dif_promedio NUMERIC,     -- % de tu precio frente al promedio
    dif_minimo NUMERIC        -- % de tu precio frente al minimo
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH dias AS (
    SELECT d::date AS fecha
    FROM generate_series(p_desde, p_hasta, INTERVAL '1 day') d
),
propios AS (
    SELECT p.id, p.id_interno, COALESCE(NULLIF(p.cantidad_contenido, 0), 1) AS unidades
    FROM dim_productos p
    WHERE p.id_interno NOT LIKE 'COMP\_%'
      AND p.activo
      AND (p_productos IS NULL OR p.id_interno = ANY (p_productos))
),
-- Enlaces de cada producto propio: los suyos y los de sus equivalentes,
-- con el mismo criterio que la vista productos_competencia.
enlaces AS (
    SELECT pr.id_interno,
           pub.id AS publicacion_id,
           pub.cadena_id,
           lab.es_propio,
           -- Un competidor con contenido 1 es "no se sabe" (el valor por
           -- defecto al crearlo): se toman las unidades de tu producto.
           CASE WHEN NOT p_por_unidad THEN 1
                WHEN p.cantidad_contenido > 1 THEN p.cantidad_contenido
                ELSE pr.unidades END AS divisor
    FROM publicaciones pub
    JOIN dim_productos p ON p.id = pub.producto_id
    JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
    JOIN propios pr ON pr.id = COALESCE(pe.producto_propio_id, p.id)
    WHERE pub.activo
      AND (lab.es_propio OR p_cadena IS NULL OR pub.cadena_id = p_cadena)
),
-- Ultimo precio conocido de cada enlace cada dia (hasta 7 dias atras).
precios AS (
    SELECT d.fecha, e.id_interno, e.es_propio,
           (CASE WHEN p_con_descuento THEN COALESCE(f.precio_desc_bs, f.precio_full_bs) ELSE f.precio_full_bs END)
             / f.tasa_bcv / e.divisor AS usd
    FROM dias d
    CROSS JOIN enlaces e
    JOIN LATERAL (
        SELECT fp.precio_full_bs, fp.precio_desc_bs, fp.tasa_bcv
        FROM fact_precios fp
        WHERE fp.publicacion_id = e.publicacion_id
          AND fp.estado = 'ok' AND fp.disponible
          AND fp.fecha_captura <  ((d.fecha + 1)::timestamp AT TIME ZONE 'America/Caracas')
          AND fp.fecha_captura >= ((d.fecha - 6)::timestamp AT TIME ZONE 'America/Caracas')
        ORDER BY fp.fecha_captura DESC
        LIMIT 1
    ) f ON TRUE
    WHERE f.tasa_bcv > 0 AND f.precio_full_bs > 0
),
resumen AS (
    SELECT fecha, id_interno,
           MIN(usd) FILTER (WHERE es_propio)       AS tuyo,
           MIN(usd) FILTER (WHERE NOT es_propio)   AS minimo,
           AVG(usd) FILTER (WHERE NOT es_propio)   AS promedio,
           COUNT(*) FILTER (WHERE NOT es_propio)   AS competidores
    FROM precios
    GROUP BY fecha, id_interno
),
con_pvp AS (
    SELECT r.*,
           COALESCE(r.tuyo, (
               SELECT pv.pvp_usd / CASE WHEN p_por_unidad THEN pr.unidades ELSE 1 END
               FROM pvp_propio pv
               WHERE pv.producto_id = pr.id
                 AND pv.vigente_desde <= r.fecha
                 AND (pv.vigente_hasta IS NULL OR pv.vigente_hasta > r.fecha)
               ORDER BY pv.vigente_desde DESC
               LIMIT 1
           )) AS tu_precio,
           CASE WHEN r.tuyo IS NOT NULL THEN 'enlace' ELSE 'pvp' END AS fuente
    FROM resumen r
    JOIN propios pr ON pr.id_interno = r.id_interno
)
SELECT fecha,
       id_interno::text,
       ROUND(tu_precio::numeric, 4),
       CASE WHEN tu_precio IS NULL THEN NULL ELSE fuente END,
       ROUND(minimo::numeric, 4),
       ROUND(promedio::numeric, 4),
       competidores::int,
       CASE WHEN tu_precio > 0 AND promedio > 0 THEN ROUND(((tu_precio / promedio - 1) * 100)::numeric, 2) END,
       CASE WHEN tu_precio > 0 AND minimo > 0 THEN ROUND(((tu_precio / minimo - 1) * 100)::numeric, 2) END
FROM con_pvp
ORDER BY fecha, id_interno;
$$;

-- Resumen por dia para el grafico.
CREATE OR REPLACE FUNCTION public.fn_tendencia_posicion(
    p_dias INT DEFAULT 90,
    p_con_descuento BOOLEAN DEFAULT FALSE,
    p_por_unidad BOOLEAN DEFAULT FALSE,
    p_cadena TEXT DEFAULT NULL,
    p_productos TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    fecha DATE,
    productos INT,          -- productos con tu precio y el de la competencia
    mediana NUMERIC,        -- mediana de "frente al promedio", en %
    mas_baratos INT,        -- tu precio <= el minimo de la competencia
    mas_caros INT           -- tu precio > el minimo
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
SELECT fecha,
       COUNT(*)::int,
       ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY dif_promedio)::numeric, 2),
       COUNT(*) FILTER (WHERE dif_minimo <= 0.5)::int,
       COUNT(*) FILTER (WHERE dif_minimo > 0.5)::int
FROM public.fn_posicion_productos(
         (timezone('America/Caracas', now())::date - LEAST(GREATEST(p_dias, 7), 365) + 1),
         timezone('America/Caracas', now())::date,
         p_con_descuento, p_por_unidad, p_cadena, p_productos)
WHERE dif_promedio IS NOT NULL
GROUP BY fecha
ORDER BY fecha;
$$;

-- ----------------------------------------------------------------------------
-- 2. CAMBIOS DESDE UN MOMENTO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cambios_desde(p_desde TIMESTAMPTZ)
RETURNS TABLE (
    publicacion_id BIGINT,
    antes_full_bs NUMERIC,
    antes_desc_bs NUMERIC,
    antes_tasa NUMERIC,
    antes_fecha TIMESTAMPTZ,
    ahora_full_bs NUMERIC,
    ahora_desc_bs NUMERIC,
    ahora_tasa NUMERIC,
    ahora_fecha TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH ahora AS (
    SELECT DISTINCT ON (fp.publicacion_id)
           fp.publicacion_id, fp.precio_full_bs, fp.precio_desc_bs, fp.tasa_bcv, fp.fecha_captura
    FROM fact_precios fp
    WHERE fp.fecha_captura > p_desde
      AND fp.estado = 'ok' AND fp.disponible
    ORDER BY fp.publicacion_id, fp.fecha_captura DESC
)
SELECT a.publicacion_id,
       b.precio_full_bs, b.precio_desc_bs, b.tasa_bcv, b.fecha_captura,
       a.precio_full_bs, a.precio_desc_bs, a.tasa_bcv, a.fecha_captura
FROM ahora a
JOIN LATERAL (
    SELECT fp.precio_full_bs, fp.precio_desc_bs, fp.tasa_bcv, fp.fecha_captura
    FROM fact_precios fp
    WHERE fp.publicacion_id = a.publicacion_id
      AND fp.fecha_captura <= p_desde
      AND fp.estado = 'ok' AND fp.disponible
    ORDER BY fp.fecha_captura DESC
    LIMIT 1
) b ON TRUE
-- En dolares (a la tasa de cada captura) y con mas de 0,5 %: que el bolivar
-- suba cada dia no cuenta como cambio de precio.
WHERE a.tasa_bcv > 0 AND b.tasa_bcv > 0 AND b.precio_full_bs > 0
  AND (
       ABS((a.precio_full_bs / a.tasa_bcv) / (b.precio_full_bs / b.tasa_bcv) - 1) > 0.005
    OR (a.precio_desc_bs IS NULL) <> (b.precio_desc_bs IS NULL)
    OR ABS((a.precio_desc_bs / a.tasa_bcv) / NULLIF(b.precio_desc_bs / b.tasa_bcv, 0) - 1) > 0.005
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. UNIDADES DEL EMPAQUE EN productos_competencia
-- ----------------------------------------------------------------------------
-- Misma vista que la fase 9 con dos columnas nuevas al final. CREATE OR
-- REPLACE borra las opciones de la vista (security_invoker...), por eso se
-- leen antes y se vuelven a poner. Si la vista de esta base fuera distinta,
-- se avisa y no se toca.
DO $vista$
DECLARE
    v_opciones TEXT[];
BEGIN
    SELECT reloptions INTO v_opciones FROM pg_class WHERE oid = 'public.productos_competencia'::regclass;

    CREATE OR REPLACE VIEW public.productos_competencia AS
    SELECT
        pub.id::text || '_' ||
            COALESCE(pe.producto_propio_id, pub.producto_id)::text AS id,
        COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
        pub.cadena_id AS cadena,
        p.nombre AS marca,
        CASE WHEN lab.es_propio THEN 'propio' ELSE 'alternativa' END AS tipo,
        pub.url,
        v.fecha_captura AS ultimo_scrape,
        CASE WHEN v.publicacion_id IS NULL THEN 'pendiente' ELSE 'ok' END AS estado,
        NULL::text AS ultimo_error,
        v.precio_full_bs AS ultimo_precio_full_bs,
        v.precio_desc_bs AS ultimo_precio_desc_bs,
        CASE WHEN v.tasa_bcv > 0
             THEN ROUND((v.precio_full_bs / v.tasa_bcv)::numeric, 2)
             ELSE NULL END AS ultimo_precio_full_usd,
        CASE WHEN v.tasa_bcv > 0 AND v.precio_desc_bs IS NOT NULL
             THEN ROUND((v.precio_desc_bs / v.tasa_bcv)::numeric, 2)
             ELSE NULL END AS ultimo_precio_desc_usd,
        p.nombre AS ultimo_nombre,
        COALESCE(v.tiene_promocion, FALSE) AS tiene_descuento,
        v.promo_texto_raw AS tipo_promo,
        lab.nombre AS laboratorio,
        pub.activo,
        p.cantidad_contenido AS unidades_empaque,
        p.unidad_contenido
    FROM public.publicaciones pub
    JOIN public.dim_productos p ON p.id = pub.producto_id
    JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN public.producto_equivalencias pe
           ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN public.dim_productos p_propio
           ON p_propio.id = pe.producto_propio_id
    LEFT JOIN public.v_ultimo_precio_valido v
           ON v.publicacion_id = pub.id;

    IF v_opciones IS NOT NULL THEN
        EXECUTE format('ALTER VIEW public.productos_competencia SET (%s)', array_to_string(v_opciones, ', '));
    END IF;
    RAISE NOTICE 'productos_competencia: columnas unidades_empaque y unidad_contenido listas.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se cambio productos_competencia (%). El panel sigue funcionando sin las unidades.', SQLERRM;
END
$vista$;

REVOKE EXECUTE ON FUNCTION public.fn_posicion_productos(DATE, DATE, BOOLEAN, BOOLEAN, TEXT, TEXT[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_tendencia_posicion(INT, BOOLEAN, BOOLEAN, TEXT, TEXT[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_cambios_desde(TIMESTAMPTZ) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_posicion_productos(DATE, DATE, BOOLEAN, BOOLEAN, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tendencia_posicion(INT, BOOLEAN, BOOLEAN, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cambios_desde(TIMESTAMPTZ) TO authenticated;

-- COMPROBACION: los ultimos 7 dias de la tendencia (dias, productos
-- comparados, mediana en % y cuantas veces eres el mas barato).
SELECT * FROM public.fn_tendencia_posicion(30) ORDER BY fecha DESC LIMIT 7;
