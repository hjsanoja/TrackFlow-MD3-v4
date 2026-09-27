-- ============================================================================
-- FASE 33: NOMBRE, CONCENTRACION Y TAMANO DEL COMPETIDOR POR SEPARADO
-- ============================================================================
-- El competidor pasa a tener sus datos como un producto propio: nombre corto
-- (dim_productos.nombre, ej. "Acetaminofen Calox"), concentracion
-- (producto_principios, con la molecula del producto propio al que esta
-- vinculado) y tamano (cantidad_contenido + unidad_contenido). El nombre
-- completo se arma en la vista para mostrarlo: "Acetaminofen Calox 500 mg x 10".
--
--   1. Concentracion: a los competidores que no la tienen se les saca del
--      nombre ("... 500 mg ...", "120mg/5ml"), solo si su producto propio
--      tiene UNA molecula.
--   2. Tamano: a los que tienen 1 ("no se sabe") se les saca del nombre
--      ("x 20", "20 tabletas", "x 120 ml").
--   3. La vista productos_competencia agrega nombre_competidor y
--      concentracion, y arma `marca` (el nombre que se muestra).
-- No cambia ningun nombre: acortarlos lo hace Hernando (formulario o
-- plantilla). Correrla otra vez no pisa nada: solo llena lo que falta.
-- ============================================================================

-- 1. CONCENTRACION DESDE EL NOMBRE ---------------------------------------------
WITH candidatos AS (
    SELECT DISTINCT ON (c.id)
           c.id AS producto_id,
           pp.principio_activo_id,
           regexp_match(lower(c.nombre),
               '([0-9]+(?:[.,][0-9]+)?)\s*(mg|mcg|ui|%|g)(?:\s*/\s*([0-9]+(?:[.,][0-9]+)?)?\s*(ml|g|dosis))?') AS m
    FROM public.dim_productos c
    JOIN public.producto_equivalencias pe ON pe.producto_competidor_id = c.id AND pe.activo
    JOIN public.producto_principios pp ON pp.producto_id = pe.producto_propio_id
    WHERE c.id_interno LIKE 'COMP\_%'
      AND NOT EXISTS (SELECT 1 FROM public.producto_principios x WHERE x.producto_id = c.id)
      AND (SELECT count(*) FROM public.producto_principios y WHERE y.producto_id = pe.producto_propio_id) = 1
    ORDER BY c.id
)
INSERT INTO public.producto_principios
    (producto_id, principio_activo_id, concentracion_valor, concentracion_unidad, por_cantidad, por_unidad, es_principal)
SELECT producto_id, principio_activo_id,
       replace(m[1], ',', '.')::numeric,
       CASE m[2] WHEN 'ui' THEN 'UI' ELSE m[2] END,
       CASE WHEN m[4] IS NOT NULL THEN COALESCE(replace(m[3], ',', '.')::numeric, 1) ELSE 1 END,
       m[4],
       TRUE
FROM candidatos
WHERE m IS NOT NULL
  -- "30 g" suele ser el tamano de una crema, no su concentracion.
  AND NOT (m[2] = 'g' AND m[4] IS NULL)
  AND replace(m[1], ',', '.')::numeric > 0;

-- 2. TAMANO DESDE EL NOMBRE ----------------------------------------------------
UPDATE public.dim_productos c
SET cantidad_contenido = t.cantidad, unidad_contenido = t.unidad
FROM (
    SELECT id,
           COALESCE(
             (regexp_match(lower(nombre), 'x\s*([0-9]+(?:[.,][0-9]+)?)\s*(ml|g)\M'))[1],
             (regexp_match(lower(nombre), 'x\s*([0-9]+)'))[1],
             (regexp_match(lower(nombre), '([0-9]+)\s*(tabletas|tableta|tab|comprimidos|capsulas|cápsulas|caps|grageas|sobres|ampollas|ovulos|óvulos)'))[1]
           ) AS texto,
           CASE WHEN lower(nombre) ~ 'x\s*[0-9]+(?:[.,][0-9]+)?\s*ml\M' THEN 'ml'
                WHEN lower(nombre) ~ 'x\s*[0-9]+(?:[.,][0-9]+)?\s*g\M' THEN 'g'
                ELSE 'unidad' END AS unidad
    FROM public.dim_productos
    WHERE id_interno LIKE 'COMP\_%' AND cantidad_contenido <= 1
) t0
CROSS JOIN LATERAL (SELECT replace(t0.texto, ',', '.')::numeric AS cantidad, t0.unidad) t
WHERE c.id = t0.id AND t0.texto IS NOT NULL AND t.cantidad > 1;

-- 3. NOMBRE, CONCENTRACION Y NOMBRE COMPLETO EN productos_competencia ---------
-- Misma vista que la fase 29 con dos columnas mas al final (nombre_competidor
-- y concentracion) y `marca` armada: nombre + concentracion + "x" unidades.
-- Si el nombre ya trae numeros (los nombres largos de antes) se deja tal cual,
-- para no repetir la dosis. CREATE OR REPLACE
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
        CASE WHEN lab.es_propio OR p.nombre ~ '[0-9]' THEN p.nombre
             ELSE concat_ws(' ', p.nombre, cc.concentracion,
                  CASE WHEN p.cantidad_contenido > 1
                       THEN 'x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p.cantidad_contenido::text))
                            || CASE p.unidad_contenido WHEN 'ml' THEN ' ml' WHEN 'g' THEN ' g' ELSE '' END
                  END)
        END::varchar(255) AS marca,
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
        p.tipo_mercado,
        p.nombre AS nombre_competidor,
        cc.concentracion
    FROM public.publicaciones pub
    JOIN public.dim_productos p ON p.id = pub.producto_id
    JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN public.producto_equivalencias pe
           ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN public.dim_productos p_propio
           ON p_propio.id = pe.producto_propio_id
    LEFT JOIN public.v_ultimo_precio_valido v
           ON v.publicacion_id = pub.id
    LEFT JOIN LATERAL (
        -- "500 mg" / "120 mg/5 ml" / "500 mg + 10 mg", como en Productos.
        SELECT string_agg(
                   TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pp.concentracion_valor::text)) || ' ' || pp.concentracion_unidad
                   || CASE WHEN pp.por_unidad IS NOT NULL
                           THEN '/' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pp.por_cantidad::text)) || ' ' || pp.por_unidad
                           ELSE '' END,
                   ' + ' ORDER BY pp.es_principal DESC, pp.id) AS concentracion
        FROM public.producto_principios pp
        WHERE pp.producto_id = p.id
    ) cc ON TRUE;

    IF v_opciones IS NOT NULL THEN
        EXECUTE format('ALTER VIEW public.productos_competencia SET (%s)', array_to_string(v_opciones, ', '));
    END IF;
    RAISE NOTICE 'productos_competencia: nombre_competidor y concentracion listas.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se cambio productos_competencia (%). El panel sigue funcionando con el nombre de antes.', SQLERRM;
END
$vista$;


-- COMPROBACION: cuantos competidores tienen concentracion y tamano, y 8
-- ejemplos del nombre que se muestra.
SELECT count(*) AS competidores,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM producto_principios pp WHERE pp.producto_id = p.id)) AS con_concentracion,
       count(*) FILTER (WHERE p.cantidad_contenido > 1) AS con_tamano
FROM dim_productos p WHERE p.id_interno LIKE 'COMP\_%';
SELECT DISTINCT nombre_competidor, concentracion, unidades_empaque, unidad_contenido, marca
FROM productos_competencia WHERE tipo <> 'propio' ORDER BY 1 LIMIT 8;
