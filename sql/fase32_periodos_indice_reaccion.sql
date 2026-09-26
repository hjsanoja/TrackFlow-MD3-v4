-- ============================================================================
-- FASE 32: COMPARADOR DE PERIODOS, INDICE POR MOLECULA Y VELOCIDAD DE REACCION
-- ============================================================================
-- Tres funciones de lectura para las pestanas nuevas de Experimental. Todo se
-- calcula aqui y al navegador llega un resumen (una fila por producto,
-- molecula o cadena). Requiere las fases 28 a 31.
--
--   fn_comparar_periodos   tu posicion en los ultimos N dias frente a los N
--                          anteriores, por producto.
--   fn_indice_molecula     como se movio el precio del mercado de cada
--                          molecula (por unidad, en dolares a la tasa de cada
--                          dia), base 100 al inicio del periodo.
--   fn_velocidad_reaccion  cuando una cadena cambia un precio, cuantos dias
--                          tardan las demas en mover el mismo producto.
-- ============================================================================

-- 1. COMPARADOR DE PERIODOS --------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_comparar_periodos(
    p_dias INT DEFAULT 7,
    p_con_descuento BOOLEAN DEFAULT FALSE,
    p_por_unidad BOOLEAN DEFAULT FALSE,
    p_cadena TEXT DEFAULT NULL,
    p_tipo_mercado TEXT DEFAULT NULL
)
RETURNS TABLE (
    id_interno TEXT,
    tu_antes NUMERIC,        -- promedio de tu precio en el periodo anterior
    tu_ahora NUMERIC,
    prom_antes NUMERIC,      -- promedio del mercado (competencia + tu precio)
    prom_ahora NUMERIC,
    dif_antes NUMERIC,       -- tu precio frente al promedio, en %
    dif_ahora NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH lim AS (
    SELECT timezone('America/Caracas', now())::date AS hoy,
           LEAST(GREATEST(p_dias, 1), 180) AS n
),
pos AS (
    SELECT f.*, CASE WHEN f.fecha > l.hoy - l.n THEN 'ahora' ELSE 'antes' END AS periodo
    FROM lim l,
         public.fn_posicion_productos(l.hoy - 2 * l.n + 1, l.hoy, p_con_descuento, p_por_unidad,
                                      p_cadena, NULL, p_tipo_mercado) f
    WHERE f.dif_promedio IS NOT NULL
)
SELECT id_interno,
       ROUND(AVG(tu_precio_usd) FILTER (WHERE periodo = 'antes'), 4),
       ROUND(AVG(tu_precio_usd) FILTER (WHERE periodo = 'ahora'), 4),
       ROUND(AVG(promedio_usd) FILTER (WHERE periodo = 'antes'), 4),
       ROUND(AVG(promedio_usd) FILTER (WHERE periodo = 'ahora'), 4),
       ROUND(AVG(dif_promedio) FILTER (WHERE periodo = 'antes'), 2),
       ROUND(AVG(dif_promedio) FILTER (WHERE periodo = 'ahora'), 2)
FROM pos
GROUP BY id_interno;
$$;

-- 2. INDICE POR MOLECULA -----------------------------------------------------
-- Por producto: precio promedio del mercado POR UNIDAD cada dia, dividido
-- por el del primer dia con dato (asi un empaque grande no pesa mas que uno
-- chico). La molecula promedia los indices de sus productos.
CREATE OR REPLACE FUNCTION public.fn_indice_molecula(p_dias INT DEFAULT 90)
RETURNS TABLE (
    molecula TEXT,
    productos INT,           -- productos propios de esa molecula con datos
    precio_unidad_inicio NUMERIC,
    precio_unidad_fin NUMERIC,
    variacion NUMERIC,       -- indice final - 100, en %
    serie NUMERIC[]          -- el indice dia por dia (base 100)
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH lim AS (
    SELECT timezone('America/Caracas', now())::date AS hoy,
           LEAST(GREATEST(p_dias, 7), 365) AS n
),
pos AS (
    SELECT f.fecha, f.id_interno, f.promedio_usd
    FROM lim l, public.fn_posicion_productos(l.hoy - l.n + 1, l.hoy, FALSE, TRUE) f
    WHERE f.promedio_usd > 0
),
mol AS (
    -- Molecula principal del producto propio; sin ficha, su nombre.
    SELECT p.id_interno,
           COALESCE((SELECT pa.nombre FROM producto_principios pp
                     JOIN dim_principios_activos pa ON pa.id = pp.principio_activo_id
                     WHERE pp.producto_id = p.id
                     ORDER BY pp.es_principal DESC, pp.id LIMIT 1), p.nombre) AS molecula
    FROM dim_productos p
    WHERE p.id_interno NOT LIKE 'COMP\_%'
),
base AS (
    SELECT DISTINCT ON (id_interno) id_interno, promedio_usd AS inicio
    FROM pos ORDER BY id_interno, fecha
),
indices AS (
    SELECT pos.fecha, m.molecula, pos.id_interno, pos.promedio_usd,
           pos.promedio_usd / b.inicio * 100 AS indice
    FROM pos
    JOIN base b USING (id_interno)
    JOIN mol m USING (id_interno)
),
diario AS (
    SELECT molecula, fecha, AVG(indice) AS indice, AVG(promedio_usd) AS precio
    FROM indices GROUP BY molecula, fecha
)
SELECT d.molecula,
       (SELECT COUNT(DISTINCT i.id_interno) FROM indices i WHERE i.molecula = d.molecula)::int,
       ROUND((array_agg(d.precio ORDER BY d.fecha))[1]::numeric, 4),
       ROUND((array_agg(d.precio ORDER BY d.fecha DESC))[1]::numeric, 4),
       ROUND(((array_agg(d.indice ORDER BY d.fecha DESC))[1] - 100)::numeric, 2),
       array_agg(ROUND(d.indice::numeric, 1) ORDER BY d.fecha)
FROM diario d
GROUP BY d.molecula
HAVING COUNT(*) >= 2;
$$;

-- 3. VELOCIDAD DE REACCION ---------------------------------------------------
-- Un "movimiento" es un cambio de mas de 0,5 % en dolares (cada precio a la
-- tasa de su dia) entre dos dias con lectura del mismo enlace. Un movimiento
-- de una cadena es una REACCION si el movimiento anterior en ese mismo
-- producto lo hizo OTRA cadena en los 30 dias previos; los dias entre uno y
-- otro son lo que tardo en reaccionar. Se calcula con una sola pasada
-- ordenada (sin cruzar cada cambio con todos los demas).
DROP FUNCTION IF EXISTS public.fn_velocidad_reaccion(INT);
CREATE OR REPLACE FUNCTION public.fn_velocidad_reaccion(p_dias INT DEFAULT 90)
RETURNS TABLE (
    cadena TEXT,
    movimientos INT,         -- cambios de precio de la cadena en el periodo
    seguidos INT,            -- de esos, cuantos respondio otra cadena
    reacciones INT,          -- veces que respondio a un cambio de otra cadena
    mediana_dias NUMERIC,    -- dias tipicos que tarda en responder
    promedio_dias NUMERIC,
    misma_direccion INT      -- reacciones en la misma direccion (subio/bajo igual)
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH lim AS (
    SELECT timezone('America/Caracas', now())::date AS hoy,
           LEAST(GREATEST(p_dias, 14), 365) AS n
),
diario AS (
    -- Ultima lectura valida de cada enlace por dia, en dolares.
    SELECT DISTINCT ON (fp.publicacion_id, (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date)
           fp.publicacion_id,
           (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS dia,
           fp.precio_full_bs / fp.tasa_bcv AS usd
    FROM fact_precios fp, lim l
    WHERE fp.estado = 'ok' AND fp.disponible AND fp.tasa_bcv > 0 AND fp.precio_full_bs > 0
      AND fp.fecha_captura >= ((l.hoy - l.n - 30)::timestamp AT TIME ZONE 'America/Caracas')
    ORDER BY fp.publicacion_id, (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date, fp.fecha_captura DESC
),
cambios AS (
    SELECT d.publicacion_id, d.dia, d.usd, LAG(d.usd) OVER (PARTITION BY d.publicacion_id ORDER BY d.dia) AS antes
    FROM diario d
),
movs AS (
    -- Un movimiento por producto, cadena y dia (una cadena puede tener
    -- varios enlaces del mismo producto).
    SELECT DISTINCT ON (COALESCE(pe.producto_propio_id, pub.producto_id), pub.cadena_id, c.dia)
           COALESCE(pe.producto_propio_id, pub.producto_id) AS producto,
           pub.cadena_id AS cadena, c.dia, SIGN(c.usd - c.antes) AS direccion
    FROM cambios c
    JOIN publicaciones pub ON pub.id = c.publicacion_id
    LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = pub.producto_id AND pe.activo
    WHERE c.antes > 0 AND ABS(c.usd / c.antes - 1) > 0.005
    ORDER BY COALESCE(pe.producto_propio_id, pub.producto_id), pub.cadena_id, c.dia
),
ordenados AS (
    SELECT m.*,
           LAG(m.cadena)    OVER w AS cadena_antes,
           LAG(m.dia)       OVER w AS dia_antes,
           LAG(m.direccion) OVER w AS direccion_antes
    FROM movs m
    WINDOW w AS (PARTITION BY m.producto ORDER BY m.dia, m.cadena)
),
periodo AS (
    SELECT o.*,
           (o.cadena_antes IS NOT NULL AND o.cadena_antes <> o.cadena
            AND o.dia - o.dia_antes BETWEEN 1 AND 30) AS es_reaccion
    FROM ordenados o, lim l
    WHERE o.dia > l.hoy - l.n
)
SELECT c.cadena::text,
       (SELECT COUNT(*) FROM periodo p WHERE p.cadena = c.cadena)::int,
       (SELECT COUNT(*) FROM periodo p WHERE p.es_reaccion AND p.cadena_antes = c.cadena)::int,
       COUNT(*) FILTER (WHERE c.es_reaccion)::int,
       ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY c.dia - c.dia_antes)
              FILTER (WHERE c.es_reaccion))::numeric, 1),
       ROUND((AVG(c.dia - c.dia_antes) FILTER (WHERE c.es_reaccion))::numeric, 1),
       COUNT(*) FILTER (WHERE c.es_reaccion AND c.direccion = c.direccion_antes)::int
FROM periodo c
GROUP BY c.cadena
ORDER BY 5 NULLS LAST, 1;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_comparar_periodos(INT, BOOLEAN, BOOLEAN, TEXT, TEXT) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_indice_molecula(INT) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_velocidad_reaccion(INT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_comparar_periodos(INT, BOOLEAN, BOOLEAN, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_indice_molecula(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_velocidad_reaccion(INT) TO authenticated;

-- COMPROBACION: cuantas filas da cada una y la velocidad por cadena.
SELECT 'comparar_periodos (7 dias)' AS funcion, count(*) AS filas FROM public.fn_comparar_periodos(7)
UNION ALL SELECT 'indice_molecula (90 dias)', count(*) FROM public.fn_indice_molecula(90)
UNION ALL SELECT 'velocidad_reaccion (90 dias)', count(*) FROM public.fn_velocidad_reaccion(90);
SELECT * FROM public.fn_velocidad_reaccion(90);
