-- ============================================================================
-- TRACKFLOW - FASE 11: CALCULO DE VARIACION EN EL SERVIDOR
-- ============================================================================
-- PROBLEMA: el panel tarda en mostrar los datos.
--
-- CAUSA: para dibujar las flechas de variacion, el navegador se descargaba
-- TODO el historico de 180 dias (~18.000 filas en ~18 peticiones encadenadas)
-- y recorria esa lista en memoria buscando, por cada enlace, el precio de hace
-- 1, 7 o 15 dias. Nada se pintaba hasta que terminaba.
--
-- SOLUCION: que Postgres haga ese trabajo. Esta vista devuelve UNA fila por
-- publicacion con el precio actual y los tres precios de referencia ya
-- resueltos. Pasa de ~18.000 filas a ~506: 36 veces menos datos y una sola
-- peticion.
--
-- El historico completo se sigue necesitando para los graficos de evolucion,
-- pero ya no bloquea el primer pintado: el frontend lo carga despues, en
-- segundo plano.
--
-- ORDEN DE EJECUCION: despues de fase10_nomenclatura_final.sql. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE VIEW public.v_variacion
WITH (security_invoker = true)
AS
WITH ultimo AS (
    -- El dia mas reciente con precio de cada publicacion.
    SELECT DISTINCT ON (d.publicacion_id) d.*
    FROM public.v_precio_diario d
    ORDER BY d.publicacion_id, d.fecha_local DESC
)
SELECT
    u.publicacion_id,
    u.id_producto_propio,
    u.id_interno,
    u.cadena_id,
    u.producto_nombre,
    u.laboratorio,
    u.es_propio,

    -- Precio vigente
    u.fecha_local                AS fecha_actual,
    u.precio_full_bs             AS precio_actual_full_bs,
    u.precio_desc_bs             AS precio_actual_desc_bs,
    u.precio_vigente_bs          AS precio_actual_bs,
    u.precio_vigente_usd         AS precio_actual_usd,
    u.tasa_bcv                   AS tasa_actual,

    -- Referencia de hace 1 dia
    r1.fecha_local               AS fecha_1d,
    r1.precio_full_bs            AS precio_1d_full_bs,
    r1.precio_desc_bs            AS precio_1d_desc_bs,
    r1.precio_vigente_bs         AS precio_1d_bs,
    r1.precio_vigente_usd        AS precio_1d_usd,
    r1.tasa_bcv                  AS tasa_1d,

    -- Referencia de hace 7 dias
    r7.fecha_local               AS fecha_7d,
    r7.precio_full_bs            AS precio_7d_full_bs,
    r7.precio_desc_bs            AS precio_7d_desc_bs,
    r7.precio_vigente_bs         AS precio_7d_bs,
    r7.precio_vigente_usd        AS precio_7d_usd,
    r7.tasa_bcv                  AS tasa_7d,

    -- Referencia de hace 15 dias
    r15.fecha_local              AS fecha_15d,
    r15.precio_full_bs           AS precio_15d_full_bs,
    r15.precio_desc_bs           AS precio_15d_desc_bs,
    r15.precio_vigente_bs        AS precio_15d_bs,
    r15.precio_vigente_usd       AS precio_15d_usd,
    r15.tasa_bcv                 AS tasa_15d

FROM ultimo u

-- Se compara por DIA DE CALENDARIO, no por horas: el scraper corre por cron
-- con precision de minutos, asi que la captura de ayer suele quedar a 23 h 58 m
-- de la de hoy. Exigir 24 h exactas dejaba la variacion diaria siempre vacia.
LEFT JOIN LATERAL (
    SELECT d.* FROM public.v_precio_diario d
    WHERE d.publicacion_id = u.publicacion_id
      AND d.fecha_local <= u.fecha_local - 1
    ORDER BY d.fecha_local DESC
    LIMIT 1
) r1 ON TRUE

LEFT JOIN LATERAL (
    SELECT d.* FROM public.v_precio_diario d
    WHERE d.publicacion_id = u.publicacion_id
      AND d.fecha_local <= u.fecha_local - 7
    ORDER BY d.fecha_local DESC
    LIMIT 1
) r7 ON TRUE

LEFT JOIN LATERAL (
    SELECT d.* FROM public.v_precio_diario d
    WHERE d.publicacion_id = u.publicacion_id
      AND d.fecha_local <= u.fecha_local - 15
    ORDER BY d.fecha_local DESC
    LIMIT 1
) r15 ON TRUE;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Cuantas filas devuelve (deberia rondar el numero de publicaciones con
--     al menos un precio capturado) y cuantas tienen referencia en cada ventana
/*
SELECT
  COUNT(*)                                  AS enlaces,
  COUNT(precio_1d_bs)                       AS con_referencia_24h,
  COUNT(precio_7d_bs)                       AS con_referencia_7d,
  COUNT(precio_15d_bs)                      AS con_referencia_15d
FROM v_variacion;
*/

-- V2. Los diez mayores movimientos de las ultimas 24 horas
/*
SELECT id_producto_propio, cadena_id, producto_nombre,
       precio_1d_bs, precio_actual_bs,
       ROUND(((precio_actual_bs - precio_1d_bs) / NULLIF(precio_1d_bs,0)) * 100, 1) AS variacion_pct
FROM v_variacion
WHERE precio_1d_bs IS NOT NULL AND precio_1d_bs > 0
ORDER BY ABS((precio_actual_bs - precio_1d_bs) / NULLIF(precio_1d_bs,0)) DESC
LIMIT 10;
*/
