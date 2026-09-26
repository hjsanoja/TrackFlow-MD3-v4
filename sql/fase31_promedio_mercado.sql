-- ============================================================================
-- FASE 31: EL PROMEDIO DE LA TENDENCIA CUENTA TU PRECIO
-- ============================================================================
-- El Dashboard y el Mapa de Calor comparan tu precio con el promedio del
-- MERCADO: (suma de la competencia + tu precio) / (competidores + 1).
-- fn_posicion_productos (y con ella fn_tendencia_posicion) pasa a usar el
-- mismo: promedio_usd y dif_promedio son del mercado. El minimo sigue siendo
-- solo de la competencia. Misma firma que la fase 30: se reemplaza en su
-- lugar. Requiere la fase 30.
-- ============================================================================

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
    promedio_usd NUMERIC,     -- del mercado: competencia + tu precio
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
),
-- Promedio del MERCADO: la competencia mas tu precio (el Dashboard y el
-- Mapa de Calor usan el mismo).
mercado AS (
    SELECT c.*,
           CASE WHEN c.tu_precio > 0 AND c.competidores > 0
                THEN (c.promedio * c.competidores + c.tu_precio) / (c.competidores + 1)
                ELSE c.promedio END AS promedio_mercado
    FROM con_pvp c
)
SELECT fecha,
       id_interno::text,
       ROUND(tu_precio::numeric, 4),
       CASE WHEN tu_precio IS NULL THEN NULL ELSE fuente END,
       ROUND(minimo::numeric, 4),
       ROUND(promedio_mercado::numeric, 4),
       competidores::int,
       CASE WHEN tu_precio > 0 AND promedio_mercado > 0 THEN ROUND(((tu_precio / promedio_mercado - 1) * 100)::numeric, 2) END,
       CASE WHEN tu_precio > 0 AND minimo > 0 THEN ROUND(((tu_precio / minimo - 1) * 100)::numeric, 2) END
FROM mercado
ORDER BY fecha, id_interno;
$$;

-- COMPROBACION: el ultimo dia de la tendencia (la mediana deberia acercarse
-- a 0 frente a la de antes: tu precio ahora pesa en el promedio).
SELECT * FROM public.fn_tendencia_posicion(7) ORDER BY fecha DESC LIMIT 3;
