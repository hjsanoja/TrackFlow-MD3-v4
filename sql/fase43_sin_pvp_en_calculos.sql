-- ============================================================================
-- FASE 43: EL PVP NO ENTRA EN NINGUN CALCULO
-- ============================================================================
-- Hasta ahora, si tu producto no tenia precio leido en ninguna cadena,
-- fn_posicion_productos usaba el PVP de la ficha como "tu precio". El PVP es
-- un precio para otro cliente: movia promedios, diferencias, posiciones y la
-- tendencia. Ahora tu precio es solo el de tus enlaces; sin enlace leido el
-- producto queda sin tu precio (no cuenta en la mediana ni en la posicion).
-- El PVP sigue en Productos y en los reportes.
--
-- Misma firma que la fase 31: se reemplaza en su lugar. Arrastra a
-- fn_tendencia_posicion, fn_comparar_periodos y fn_indice_molecula, que la
-- usan. No cambia datos. ORDEN: despues de fase42. Es idempotente.
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
    fuente TEXT,              -- 'enlace' (el PVP ya no se usa)
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
-- Tu precio es SOLO el de tus enlaces en las cadenas. El PVP no entra en
-- ningun calculo (es un precio para otro cliente): sin enlace leido, ese dia
-- el producto queda sin tu precio.
con_tuyo AS (
    SELECT r.*, r.tuyo AS tu_precio, 'enlace'::text AS fuente
    FROM resumen r
),
-- Promedio del MERCADO: la competencia mas tu precio (el Dashboard y el
-- Mapa de Calor usan el mismo).
mercado AS (
    SELECT c.*,
           CASE WHEN c.tu_precio > 0 AND c.competidores > 0
                THEN (c.promedio * c.competidores + c.tu_precio) / (c.competidores + 1)
                ELSE c.promedio END AS promedio_mercado
    FROM con_tuyo c
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

-- COMPROBACION: ningun dia con fuente distinta de 'enlace'
/*
SELECT fuente, count(*) FROM public.fn_posicion_productos(current_date - 7, current_date) GROUP BY 1;
*/
