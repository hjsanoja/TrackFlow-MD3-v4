-- ============================================================================
-- TRACKFLOW - FASE 45: TU POSICION POR CADENA Y COMPETIDORES SIN UNIDAD
-- ============================================================================
-- 1. Los productos de la competencia (COMP_) no tienen unidad de negocio: la
--    unidad de negocio es tuya (La Sante, Pharmetique, OTC). La fase 2 le puso
--    'La Sante' a todos los competidores que migro; por eso en Dimensiones
--    solo La Sante contaba productos de la competencia. Se les quita. Los
--    competidores creados desde el panel ya nacian sin unidad.
--
-- 2. fn_posicion_por_cadena: dia a dia y por cadena, en cuantos de tus
--    productos eres el mas barato, el mas caro o quedas en medio DENTRO de esa
--    cadena (tu enlace en esa cadena frente a los competidores en esa misma
--    cadena). Mismo criterio de precios que fn_posicion_productos (fase 43):
--    el ultimo precio de cada enlace, hasta 7 dias atras, en dolares a la tasa
--    de ese dia. Empate = hasta 0,5 % (como el panel):
--      mas barato: tu precio <= el mas barato de la competencia + 0,5 %
--      mas caro:   tu precio >  el mas caro de la competencia + 0,5 %
--      en medio:   el resto
--
-- ORDEN: despues de fase44. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Competidores sin unidad de negocio
-- ----------------------------------------------------------------------------
UPDATE public.dim_productos
SET unidad_negocio_id = NULL
WHERE id_interno LIKE 'COMP\_%'
  AND unidad_negocio_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Tu posicion por cadena, dia a dia
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_posicion_por_cadena(
    p_dias INT DEFAULT 30,
    p_con_descuento BOOLEAN DEFAULT FALSE,
    p_por_unidad BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    fecha DATE,
    cadena_id TEXT,
    productos INT,      -- con tu precio y al menos un competidor en la cadena
    mas_barato INT,
    en_medio INT,
    mas_caro INT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH hoy AS (
    SELECT (now() AT TIME ZONE 'America/Caracas')::date AS d
),
dias AS (
    SELECT g::date AS fecha
    FROM hoy, generate_series(hoy.d - (LEAST(GREATEST(p_dias, 1), 180) - 1), hoy.d, INTERVAL '1 day') g
),
propios AS (
    SELECT p.id, p.id_interno, COALESCE(NULLIF(p.cantidad_contenido, 0), 1) AS unidades
    FROM dim_productos p
    WHERE p.id_interno NOT LIKE 'COMP\_%'
      AND p.activo
),
-- Enlaces de cada producto propio (los suyos y los de sus equivalentes),
-- como en fn_posicion_productos.
enlaces AS (
    SELECT pr.id_interno,
           pub.id AS publicacion_id,
           pub.cadena_id,
           lab.es_propio,
           CASE WHEN NOT p_por_unidad THEN 1
                WHEN p.cantidad_contenido > 1 THEN p.cantidad_contenido
                ELSE pr.unidades END AS divisor
    FROM publicaciones pub
    JOIN dim_productos p ON p.id = pub.producto_id
    JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
    JOIN propios pr ON pr.id = COALESCE(pe.producto_propio_id, p.id)
    WHERE pub.activo
),
-- Ultimo precio conocido de cada enlace cada dia (hasta 7 dias atras).
precios AS (
    SELECT d.fecha, e.id_interno, e.cadena_id, e.es_propio,
           (CASE WHEN p_con_descuento THEN COALESCE(f.precio_desc_bs, f.precio_full_bs) ELSE f.precio_full_bs END)
             / f.tasa_bcv / e.divisor AS usd
    FROM dias d
    CROSS JOIN enlaces e
    JOIN LATERAL (
        SELECT fp.precio_full_bs, fp.precio_desc_bs, fp.tasa_bcv
        FROM fact_precios fp
        WHERE fp.publicacion_id = e.publicacion_id
          AND fp.estado = 'ok' AND fp.disponible
          AND NOT fp.sospechoso
          AND fp.fecha_captura <  ((d.fecha + 1)::timestamp AT TIME ZONE 'America/Caracas')
          AND fp.fecha_captura >= ((d.fecha - 6)::timestamp AT TIME ZONE 'America/Caracas')
        ORDER BY fp.fecha_captura DESC
        LIMIT 1
    ) f ON TRUE
    WHERE f.tasa_bcv > 0 AND f.precio_full_bs > 0
),
por_cadena AS (
    SELECT fecha, cadena_id, id_interno,
           MIN(usd) FILTER (WHERE es_propio)     AS tuyo,
           MIN(usd) FILTER (WHERE NOT es_propio) AS minimo,
           MAX(usd) FILTER (WHERE NOT es_propio) AS maximo
    FROM precios
    GROUP BY fecha, cadena_id, id_interno
)
SELECT fecha,
       cadena_id::text,
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE tuyo <= minimo * 1.005)::int,
       COUNT(*) FILTER (WHERE tuyo > minimo * 1.005 AND tuyo <= maximo * 1.005)::int,
       COUNT(*) FILTER (WHERE tuyo > maximo * 1.005)::int
FROM por_cadena
WHERE tuyo > 0 AND minimo > 0
GROUP BY fecha, cadena_id
ORDER BY fecha, cadena_id;
$$;

GRANT EXECUTE ON FUNCTION public.fn_posicion_por_cadena(INT, BOOLEAN, BOOLEAN) TO authenticated;

-- COMPROBACION
/*
-- Debe dar 0: ningun competidor con unidad de negocio
SELECT count(*) FROM dim_productos WHERE id_interno LIKE 'COMP\_%' AND unidad_negocio_id IS NOT NULL;
-- Hoy, por cadena
SELECT * FROM fn_posicion_por_cadena(1);
*/
