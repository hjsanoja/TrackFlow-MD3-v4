-- ============================================================================
-- TRACKFLOW - FASE 9: QUE LOS ENLACES NUEVOS SEAN VISIBLES
-- ============================================================================
-- PROBLEMA: agregas un enlace de competencia, el panel dice que lo guardo, no
-- aparece ningun error, pero el enlace no se ve en la lista.
--
-- CAUSA RAIZ: la cadena de vistas parte de los PRECIOS, no de los ENLACES.
--     productos_competencia  ->  v_ultimo_precio_valido  ->  FROM fact_precios
-- Un enlace recien creado todavia no tiene ninguna captura de precio, asi que
-- no existe ninguna fila suya en fact_precios y queda fuera de la vista.
--
-- El enlace SI se guardo: esta en publicaciones, con su producto en
-- dim_productos y su equivalencia en producto_equivalencias. Lo unico que
-- faltaba era poder verlo antes de que el scraper lo visite por primera vez.
--
-- SOLUCION: la vista pasa a partir de publicaciones (el catalogo de enlaces) y
-- engancha el ultimo precio con LEFT JOIN. Asi todo enlace aparece siempre, y
-- los que aun no tienen captura se marcan con estado 'pendiente'.
--
-- ORDEN DE EJECUCION: despues de fase8_nomenclatura.sql. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

DO $vista$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'productos_competencia'
          AND c.relkind = 'v'
    ) THEN
        RAISE NOTICE 'productos_competencia no es una vista: no se toca.';
        RETURN;
    END IF;

    DROP VIEW public.productos_competencia;

    CREATE VIEW public.productos_competencia AS
    SELECT
        -- Mismo criterio de id que la version anterior: unico por
        -- (publicacion, producto propio con el que se compara).
        pub.id::text || '_' ||
            COALESCE(pe.producto_propio_id, pub.producto_id)::text AS id,
        COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
        pub.cadena_id AS cadena,
        p.nombre AS marca,
        CASE WHEN lab.es_propio THEN 'propio' ELSE 'alternativa' END AS tipo,
        pub.url,
        v.fecha_captura AS ultimo_scrape,
        -- 'pendiente' = enlace registrado al que el scraper todavia no llega.
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
        pub.activo
    FROM public.publicaciones pub
    JOIN public.dim_productos p ON p.id = pub.producto_id
    JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN public.producto_equivalencias pe
           ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN public.dim_productos p_propio
           ON p_propio.id = pe.producto_propio_id
    LEFT JOIN public.v_ultimo_precio_valido v
           ON v.publicacion_id = pub.id;

    RAISE NOTICE 'Vista productos_competencia recreada partiendo de publicaciones: los enlaces nuevos ya son visibles.';
END
$vista$;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Enlaces totales y cuantos siguen sin primera captura de precio.
--     Antes de este cambio los 'pendiente' eran invisibles en el panel.
/*
SELECT estado, COUNT(*) AS enlaces
FROM productos_competencia
GROUP BY estado
ORDER BY estado;
*/

-- V2. Los enlaces sin precio, con su URL, para revisarlos o lanzarles el
--     scraper a mano.
/*
SELECT id_producto_propio, cadena, marca, url
FROM productos_competencia
WHERE estado = 'pendiente'
ORDER BY cadena, marca;
*/

-- V3. El total debe coincidir con las publicaciones activas del modelo.
/*
SELECT
  (SELECT COUNT(*) FROM publicaciones)          AS publicaciones,
  (SELECT COUNT(DISTINCT url) FROM productos_competencia) AS urls_en_la_vista;
*/
