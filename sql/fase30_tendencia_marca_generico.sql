-- ============================================================================
-- FASE 30: LA TENDENCIA RESPETA EL FILTRO "COMPETIDORES: MARCA / GENERICO"
-- ============================================================================
-- fn_posicion_productos y fn_tendencia_posicion (fase 28) reciben un
-- parametro nuevo al final, p_tipo_mercado ('MARCA', 'GENERICO' o NULL =
-- todos), que deja solo los competidores de ese tipo (dim_productos.
-- tipo_mercado, fase 29). Tus enlaces no se filtran.
-- Se borran las versiones viejas antes: con dos versiones de la misma funcion
-- el panel no sabria a cual llamar. Requiere la fase 29.
-- ============================================================================

DROP FUNCTION IF EXISTS public.fn_tendencia_posicion(INT, BOOLEAN, BOOLEAN, TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.fn_posicion_productos(DATE, DATE, BOOLEAN, BOOLEAN, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION public.fn_posicion_productos(
    p_desde DATE,
    p_hasta DATE,
    p_con_descuento BOOLEAN DEFAULT FALSE,
    p_por_unidad BOOLEAN DEFAULT FALSE,
    p_cadena TEXT DEFAULT NULL,          -- comparar solo contra esta cadena
    p_productos TEXT[] DEFAULT NULL,     -- id_interno de los productos (NULL = todos)
    p_tipo_mercado TEXT DEFAULT NULL     -- 'MARCA' o 'GENERICO': solo esos competidores
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
      AND (lab.es_propio OR p_tipo_mercado IS NULL OR p.tipo_mercado = p_tipo_mercado)
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
    p_productos TEXT[] DEFAULT NULL,
    p_tipo_mercado TEXT DEFAULT NULL
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
         p_con_descuento, p_por_unidad, p_cadena, p_productos, p_tipo_mercado)
WHERE dif_promedio IS NOT NULL
GROUP BY fecha
ORDER BY fecha;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_posicion_productos(DATE, DATE, BOOLEAN, BOOLEAN, TEXT, TEXT[], TEXT) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_tendencia_posicion(INT, BOOLEAN, BOOLEAN, TEXT, TEXT[], TEXT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_posicion_productos(DATE, DATE, BOOLEAN, BOOLEAN, TEXT, TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tendencia_posicion(INT, BOOLEAN, BOOLEAN, TEXT, TEXT[], TEXT) TO authenticated;

-- COMPROBACION: el ultimo dia de la tendencia con toda la competencia, solo
-- genericos y solo marcas (productos comparados y mediana en %).
SELECT 'todos' AS competidores, * FROM public.fn_tendencia_posicion(7) ORDER BY fecha DESC LIMIT 1;
SELECT 'genericos' AS competidores, * FROM public.fn_tendencia_posicion(7, p_tipo_mercado => 'GENERICO') ORDER BY fecha DESC LIMIT 1;
SELECT 'marcas' AS competidores, * FROM public.fn_tendencia_posicion(7, p_tipo_mercado => 'MARCA') ORDER BY fecha DESC LIMIT 1;
