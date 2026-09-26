-- ============================================================================
-- FASE 29: MARCA O GENERICO DE CADA COMPETIDOR
-- ============================================================================
-- dim_productos.tipo_mercado (fase 18) existe para todos los productos, pero
-- a los de la competencia (COMP_) se les puso GENERICO a todos. Esta fase:
--   1. Los clasifica UNA vez por el nombre: si empieza con la molecula del
--      producto propio al que estan vinculados es GENERICO ("Acetaminofen
--      Genven 500 mg"); si no, MARCA ("Atamel", "Tempra").
--      Si ya hay algun competidor en MARCA (clasificado o corregido a mano),
--      no toca nada: correrla otra vez no pisa correcciones.
--   2. Agrega tipo_mercado al final de la vista productos_competencia.
-- Despues se corrige en Competencia (formulario) o con la columna
-- tipo_mercado de la plantilla.
-- ============================================================================

-- 1. CLASIFICACION INICIAL -----------------------------------------------------
DO $clasificar$
DECLARE
    v_cambiados INT;
BEGIN
    IF EXISTS (SELECT 1 FROM public.dim_productos WHERE id_interno LIKE 'COMP\_%' AND tipo_mercado = 'MARCA') THEN
        RAISE NOTICE 'Ya hay competidores en MARCA: no se reclasifica nada.';
        RETURN;
    END IF;

    WITH molecula AS (
        -- Primera palabra de la molecula principal del producto propio, sin acentos.
        SELECT DISTINCT ON (pe.producto_competidor_id)
               pe.producto_competidor_id AS id,
               split_part(lower(translate(pa.nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), ' ', 1) AS palabra
        FROM public.producto_equivalencias pe
        JOIN public.producto_principios pp ON pp.producto_id = pe.producto_propio_id
        JOIN public.dim_principios_activos pa ON pa.id = pp.principio_activo_id
        ORDER BY pe.producto_competidor_id, pp.es_principal DESC, pp.id
    )
    UPDATE public.dim_productos p
    SET tipo_mercado = CASE
            WHEN lower(translate(p.nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')) LIKE m.palabra || '%'
            THEN 'GENERICO' ELSE 'MARCA' END
    FROM molecula m
    WHERE m.id = p.id
      AND p.id_interno LIKE 'COMP\_%'
      AND length(m.palabra) >= 4;
    GET DIAGNOSTICS v_cambiados = ROW_COUNT;
    RAISE NOTICE 'Competidores clasificados: %', v_cambiados;
END
$clasificar$;

-- 2. tipo_mercado EN productos_competencia --------------------------------------
-- Misma vista que la fase 28 con una columna mas al final. CREATE OR REPLACE
-- borra las opciones de la vista (security_invoker...): se leen antes y se
-- vuelven a poner.
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
        p.unidad_contenido,
        p.tipo_mercado
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
    RAISE NOTICE 'productos_competencia: columna tipo_mercado lista.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se cambio productos_competencia (%). El panel sigue funcionando sin marca/generico.', SQLERRM;
END
$vista$;

-- COMPROBACION: cuantos competidores quedaron en cada tipo y 6 ejemplos.
SELECT tipo_mercado, count(*) AS competidores,
       (array_agg(nombre ORDER BY nombre))[1:6] AS ejemplos
FROM public.dim_productos
WHERE id_interno LIKE 'COMP\_%'
GROUP BY tipo_mercado;
