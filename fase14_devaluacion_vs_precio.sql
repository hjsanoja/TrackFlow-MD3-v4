-- ============================================================================
-- TRACKFLOW - FASE 14: SEPARAR DEVALUACION DE SUBIDA REAL DE PRECIO
-- ============================================================================
-- EL PROBLEMA
-- El panel dice "Calox subio 50%". Pero si la tasa BCV paso de 100 a 125 en
-- ese periodo, en dolares paso de 10 a 12: subio un 20% real y el otro 25% fue
-- la moneda. Hoy no hay forma de distinguirlo, asi que cada movimiento de la
-- tasa se lee como si fuera una decision comercial del competidor.
--
-- El caso que mas se escapa es el contrario: un competidor que MANTIENE su
-- precio en bolivares mientras la tasa sube un 25% esta bajando su precio real
-- un 20%. Es una jugada agresiva, y el panel la muestra hoy como "0% de
-- variacion".
--
-- LA DESCOMPOSICION
-- Es multiplicativa, no una resta:
--
--     (1 + variacion_bs) = (1 + devaluacion) x (1 + variacion_real)
--
--     variacion_real = (1 + variacion_bs) / (1 + devaluacion) - 1
--
-- Comprobado: +50% en Bs con +25% de devaluacion da +20% real, porque
-- 1.25 x 1.20 = 1.50. Restar daria 25%, que es incorrecto.
--
-- ORDEN DE EJECUCION: despues de fase13_calidad_historica.sql. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. DESCOMPOSICION POR PUBLICACION Y VENTANA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_descomposicion_precio
WITH (security_invoker = true)
AS
WITH ultimo AS (
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM v_precio_diario d
    ORDER BY d.publicacion_id, d.fecha_local DESC
),
comparacion AS (
    SELECT
        u.publicacion_id,
        u.id_producto_propio,
        u.id_interno,
        u.cadena_id,
        u.producto_nombre,
        u.laboratorio,
        u.es_propio,
        v.dias                    AS ventana_dias,
        u.fecha_local             AS fecha_actual,
        u.precio_vigente_bs       AS precio_actual_bs,
        u.precio_vigente_usd      AS precio_actual_usd,
        u.tasa_bcv                AS tasa_actual,
        r.fecha_local             AS fecha_base,
        r.precio_vigente_bs       AS precio_base_bs,
        r.precio_vigente_usd      AS precio_base_usd,
        r.tasa_bcv                AS tasa_base
    FROM ultimo u
    CROSS JOIN (VALUES (7), (30)) AS v(dias)
    LEFT JOIN LATERAL (
        SELECT d.* FROM v_precio_diario d
        WHERE d.publicacion_id = u.publicacion_id
          AND d.fecha_local <= u.fecha_local - v.dias
        ORDER BY d.fecha_local DESC
        LIMIT 1
    ) r ON TRUE
)
SELECT
    c.*,

    -- Lo que ve el panel hoy
    CASE WHEN c.precio_base_bs > 0
         THEN ROUND((((c.precio_actual_bs - c.precio_base_bs) / c.precio_base_bs) * 100)::numeric, 1)
    END AS variacion_bs_pct,

    -- Cuanto se movio la moneda en el mismo periodo
    CASE WHEN c.tasa_base > 0
         THEN ROUND((((c.tasa_actual - c.tasa_base) / c.tasa_base) * 100)::numeric, 1)
    END AS devaluacion_pct,

    -- La subida real: lo que queda al descontar la moneda.
    -- Equivale a la variacion del precio en dolares.
    CASE WHEN c.precio_base_usd > 0
         THEN ROUND((((c.precio_actual_usd - c.precio_base_usd) / c.precio_base_usd) * 100)::numeric, 1)
    END AS variacion_real_pct,

    -- Lectura en palabras, que es lo que se muestra en el panel
    CASE
      WHEN c.precio_base_usd IS NULL OR c.precio_base_usd = 0 THEN 'sin_referencia'
      -- Margenes de +-2% para no llamar decision a un redondeo
      WHEN ((c.precio_actual_usd - c.precio_base_usd) / c.precio_base_usd) >  0.02 THEN 'subio_real'
      WHEN ((c.precio_actual_usd - c.precio_base_usd) / c.precio_base_usd) < -0.02 THEN 'bajo_real'
      ELSE 'solo_devaluacion'
    END AS lectura
FROM comparacion c;

-- ----------------------------------------------------------------------------
-- 2. RESUMEN DE CARTERA POR VENTANA
-- ----------------------------------------------------------------------------
-- Responde: de todo lo que subio en bolivares, cuanto fue de verdad.
CREATE OR REPLACE VIEW public.v_resumen_devaluacion
WITH (security_invoker = true)
AS
SELECT
    ventana_dias,
    COUNT(*) FILTER (WHERE lectura <> 'sin_referencia')        AS enlaces_comparables,

    -- La devaluacion es la misma para todos, pero se toma la mediana porque
    -- cada enlace puede tener su fecha base distinta segun cuando se capturo.
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY devaluacion_pct)::numeric, 1) AS devaluacion_mediana_pct,

    ROUND(AVG(variacion_bs_pct)   FILTER (WHERE lectura <> 'sin_referencia')::numeric, 1) AS variacion_bs_promedio_pct,
    ROUND(AVG(variacion_real_pct) FILTER (WHERE lectura <> 'sin_referencia')::numeric, 1) AS variacion_real_promedio_pct,

    COUNT(*) FILTER (WHERE lectura = 'subio_real')        AS subieron_de_verdad,
    COUNT(*) FILTER (WHERE lectura = 'bajo_real')         AS bajaron_de_verdad,
    COUNT(*) FILTER (WHERE lectura = 'solo_devaluacion')  AS solo_siguieron_la_tasa,

    -- Los que bajan precio real sin tocar el bolivar: el movimiento que hoy
    -- pasa desapercibido.
    COUNT(*) FILTER (
      WHERE lectura = 'bajo_real'
        AND variacion_bs_pct IS NOT NULL
        AND ABS(variacion_bs_pct) < 2
    ) AS bajaron_sin_mover_el_bolivar
FROM v_descomposicion_precio
GROUP BY ventana_dias;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Resumen de cartera: cuanto de lo que "subio" fue de verdad
/*
SELECT * FROM v_resumen_devaluacion ORDER BY ventana_dias;
*/

-- V2. Los que MAS subieron de verdad en 30 dias (decision comercial real)
/*
SELECT id_producto_propio, cadena_id, producto_nombre, laboratorio,
       variacion_bs_pct AS "subio en Bs",
       devaluacion_pct  AS "de eso, moneda",
       variacion_real_pct AS "subida real"
FROM v_descomposicion_precio
WHERE ventana_dias = 30 AND lectura = 'subio_real'
ORDER BY variacion_real_pct DESC
LIMIT 15;
*/

-- V3. Los que BAJARON precio real sin mover el bolivar.
--     El panel los muestra como "sin cambios". Son los mas agresivos.
/*
SELECT id_producto_propio, cadena_id, producto_nombre, laboratorio,
       variacion_bs_pct AS "en Bs parece",
       variacion_real_pct AS "pero en real bajo"
FROM v_descomposicion_precio
WHERE ventana_dias = 30
  AND lectura = 'bajo_real'
  AND ABS(variacion_bs_pct) < 2
ORDER BY variacion_real_pct
LIMIT 15;
*/
