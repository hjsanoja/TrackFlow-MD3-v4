-- ============================================================================
-- TRACKFLOW VENEZUELA - FASE 5: SCRIPT DE ARCHIVADO Y DEPRECACIÓN DE TABLAS LEGACY
-- ============================================================================
-- Este script proporciona los comandos para archivar o eliminar de forma segura
-- las tablas legacy una vez finalizado el período de convivencia (Dual-Write).
--
-- Tablas Legacy a gestionar:
--   1. historico_precios    (20.153 registros ya migrados a fact_precios)
--   2. productos_competencia(537 registros ya migrados a dim_productos y publicaciones)
--   3. bcv_rates            (155 registros ya migrados a dim_tasa_bcv)
--   4. cadenas              (3 registros ya migrados a dim_cadenas)
--   5. productos            (245 registros ya migrados a dim_productos)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- OPCIÓN A: ARCHIVADO SEGURO (RECOMENDADA)
-- Renombra las tablas con el prefijo 'legacy_' para liberar los nombres principales
-- pero conservando el 100% de la data histórica intacta como respaldo frío.
-- ----------------------------------------------------------------------------

-- 1. Renombrar tablas legacy a esquema de respaldo:
ALTER TABLE IF EXISTS public.historico_precios RENAME TO legacy_historico_precios;
ALTER TABLE IF EXISTS public.productos_competencia RENAME TO legacy_productos_competencia;
ALTER TABLE IF EXISTS public.bcv_rates RENAME TO legacy_bcv_rates;
ALTER TABLE IF EXISTS public.cadenas RENAME TO legacy_cadenas;
ALTER TABLE IF EXISTS public.productos RENAME TO legacy_productos;

-- 2. Crear Vistas de Compatibilidad hacia atrás (Backward Compatibility Views)
-- Si algún reporte externo o herramienta de terceros consulta las tablas viejas,
-- estas vistas redirigen automáticamente al nuevo modelo dimensional sin errores.

CREATE OR REPLACE VIEW public.cadenas AS
SELECT 
    id,
    nombre,
    website,
    modulo_scraper,
    activo
FROM public.dim_cadenas;

CREATE OR REPLACE VIEW public.bcv_rates AS
SELECT 
    fecha AS updated_at,
    tasa AS value,
    fuente AS source
FROM public.dim_tasa_bcv;

CREATE OR REPLACE VIEW public.productos_competencia AS
SELECT 
    v.id_interno AS id,
    v.id_interno AS id_producto_propio,
    v.cadena_id AS cadena,
    v.laboratorio_nombre AS marca,
    CASE WHEN v.es_propio THEN 'propio' ELSE 'alternativa' END AS tipo,
    v.url,
    v.fecha_captura AS ultimo_scrape,
    'ok' AS estado,
    NULL::text AS ultimo_error,
    v.precio_full_bs AS ultimo_precio_full_bs,
    v.precio_desc_bs AS ultimo_precio_desc_bs,
    CASE WHEN v.tasa_bcv > 0 THEN ROUND((v.precio_full_bs / v.tasa_bcv)::numeric, 2) ELSE NULL END AS ultimo_precio_full_usd,
    CASE WHEN v.tasa_bcv > 0 AND v.precio_desc_bs IS NOT NULL THEN ROUND((v.precio_desc_bs / v.tasa_bcv)::numeric, 2) ELSE NULL END AS ultimo_precio_desc_usd,
    v.producto_nombre AS ultimo_nombre,
    v.tiene_promocion AS tiene_descuento,
    v.promo_texto_raw AS tipo_promo,
    v.laboratorio_nombre AS laboratorio,
    TRUE AS activo
FROM public.v_ultimo_precio_valido v;

-- ----------------------------------------------------------------------------
-- OPCIÓN B: ELIMINACIÓN DEFINITIVA (SOLO CUANDO ESTÉS 100% SEGURO)
-- Ejecutar únicamente cuando hayas validado que no requieres copias de respaldo
-- en las tablas legacy dentro de Supabase.
-- ----------------------------------------------------------------------------
/*
DROP TABLE IF EXISTS public.legacy_historico_precios CASCADE;
DROP TABLE IF EXISTS public.legacy_productos_competencia CASCADE;
DROP TABLE IF EXISTS public.legacy_bcv_rates CASCADE;
DROP TABLE IF EXISTS public.legacy_cadenas CASCADE;
DROP TABLE IF EXISTS public.legacy_productos CASCADE;
*/
