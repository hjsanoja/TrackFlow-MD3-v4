-- ============================================================================
-- FASE 27: unir elementos de las dimensiones (laboratorios, categorias...)
-- ============================================================================
-- Un laboratorio (o categoria, unidad, forma, molecula) que usan productos no
-- se puede borrar: la base lo impide para no dejar productos sin laboratorio.
-- Por eso "Eliminar" fallaba en casi todos los laboratorios (cada competidor
-- tiene el suyo). La salida correcta es UNIR: los productos pasan a otro
-- elemento y el viejo se borra.
--
-- Esta fase:
--   1. Columna `sinonimos` en laboratorios, categorias, unidades de negocio y
--      formas farmaceuticas (las moleculas ya la tienen). Al unir, el nombre
--      viejo queda como sinonimo: una carga futura con ese nombre ira al
--      elemento que quedo, en vez de volver a crearlo.
--   2. Vista v_uso_dimensiones: cuantos productos (propios y competidores)
--      usan cada elemento.
--   3. fn_unir_dimension(tabla, origen, destino): mueve todo al destino y
--      borra el origen. Solo un administrador.
--
-- No cambia datos al correrla. Se puede correr mas de una vez.
-- ============================================================================

ALTER TABLE public.dim_laboratorios ADD COLUMN IF NOT EXISTS sinonimos TEXT[] DEFAULT '{}';
ALTER TABLE public.dim_categorias ADD COLUMN IF NOT EXISTS sinonimos TEXT[] DEFAULT '{}';
ALTER TABLE public.dim_unidades_negocio ADD COLUMN IF NOT EXISTS sinonimos TEXT[] DEFAULT '{}';
ALTER TABLE public.dim_formas_farmaceuticas ADD COLUMN IF NOT EXISTS sinonimos TEXT[] DEFAULT '{}';

-- ----------------------------------------------------------------------------
-- 2. USO DE CADA ELEMENTO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_uso_dimensiones
WITH (security_invoker = true)
AS
SELECT 'dim_laboratorios'::text AS tabla, laboratorio_id AS id,
       count(*) FILTER (WHERE id_interno NOT LIKE 'COMP\_%') AS propios,
       count(*) FILTER (WHERE id_interno LIKE 'COMP\_%') AS competidores
FROM public.dim_productos WHERE laboratorio_id IS NOT NULL GROUP BY laboratorio_id
UNION ALL
SELECT 'dim_categorias', categoria_id,
       count(*) FILTER (WHERE id_interno NOT LIKE 'COMP\_%'), count(*) FILTER (WHERE id_interno LIKE 'COMP\_%')
FROM public.dim_productos WHERE categoria_id IS NOT NULL GROUP BY categoria_id
UNION ALL
SELECT 'dim_unidades_negocio', unidad_negocio_id,
       count(*) FILTER (WHERE id_interno NOT LIKE 'COMP\_%'), count(*) FILTER (WHERE id_interno LIKE 'COMP\_%')
FROM public.dim_productos WHERE unidad_negocio_id IS NOT NULL GROUP BY unidad_negocio_id
UNION ALL
SELECT 'dim_formas_farmaceuticas', forma_farmaceutica_id,
       count(*) FILTER (WHERE id_interno NOT LIKE 'COMP\_%'), count(*) FILTER (WHERE id_interno LIKE 'COMP\_%')
FROM public.dim_productos WHERE forma_farmaceutica_id IS NOT NULL GROUP BY forma_farmaceutica_id
UNION ALL
SELECT 'dim_principios_activos', pp.principio_activo_id,
       count(*) FILTER (WHERE p.id_interno NOT LIKE 'COMP\_%'), count(*) FILTER (WHERE p.id_interno LIKE 'COMP\_%')
FROM public.producto_principios pp JOIN public.dim_productos p ON p.id = pp.producto_id
GROUP BY pp.principio_activo_id;

GRANT SELECT ON public.v_uso_dimensiones TO authenticated;
REVOKE ALL ON public.v_uso_dimensiones FROM anon;

-- ----------------------------------------------------------------------------
-- 3. UNIR
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_unir_dimension(p_tabla TEXT, p_origen BIGINT, p_destino BIGINT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_nombre_origen TEXT;
    v_sin_origen TEXT[];
    v_movidos INT := 0;
    v_n INT;
BEGIN
    IF NOT public.fn_es_admin() THEN
        RAISE EXCEPTION 'Solo un administrador puede unir elementos.';
    END IF;
    IF p_tabla NOT IN ('dim_laboratorios', 'dim_categorias', 'dim_unidades_negocio',
                       'dim_formas_farmaceuticas', 'dim_principios_activos') THEN
        RAISE EXCEPTION 'No se puede unir en %.', p_tabla;
    END IF;
    IF p_origen = p_destino THEN
        RAISE EXCEPTION 'Elige un elemento distinto para unir.';
    END IF;

    EXECUTE format('SELECT nombre, coalesce(sinonimos, ''{}'') FROM public.%I WHERE id = $1', p_tabla)
        INTO v_nombre_origen, v_sin_origen USING p_origen;
    IF v_nombre_origen IS NULL THEN RAISE EXCEPTION 'El elemento a unir ya no existe.'; END IF;
    EXECUTE format('SELECT 1 FROM public.%I WHERE id = $1', p_tabla) INTO v_n USING p_destino;
    IF v_n IS NULL THEN RAISE EXCEPTION 'El elemento destino no existe.'; END IF;

    IF p_tabla = 'dim_laboratorios' THEN
        -- Marcas: las que no chocan pasan al destino; los productos de las que
        -- chocan (mismo nombre en el destino) se apuntan a la del destino.
        UPDATE public.dim_marcas m SET laboratorio_id = p_destino
        WHERE m.laboratorio_id = p_origen
          AND NOT EXISTS (SELECT 1 FROM public.dim_marcas d WHERE d.laboratorio_id = p_destino AND d.nombre = m.nombre);
        UPDATE public.dim_productos p
        SET laboratorio_id = p_destino,
            marca_id = coalesce((
                SELECT d.id FROM public.dim_marcas o JOIN public.dim_marcas d
                  ON d.nombre = o.nombre AND d.laboratorio_id = p_destino
                WHERE o.id = p.marca_id AND o.laboratorio_id = p_origen), p.marca_id)
        WHERE p.laboratorio_id = p_origen;
        GET DIAGNOSTICS v_movidos = ROW_COUNT;
        DELETE FROM public.dim_marcas WHERE laboratorio_id = p_origen;
    ELSIF p_tabla = 'dim_categorias' THEN
        UPDATE public.dim_productos SET categoria_id = p_destino WHERE categoria_id = p_origen;
        GET DIAGNOSTICS v_movidos = ROW_COUNT;
    ELSIF p_tabla = 'dim_unidades_negocio' THEN
        UPDATE public.dim_productos SET unidad_negocio_id = p_destino WHERE unidad_negocio_id = p_origen;
        GET DIAGNOSTICS v_movidos = ROW_COUNT;
    ELSIF p_tabla = 'dim_formas_farmaceuticas' THEN
        UPDATE public.dim_productos SET forma_farmaceutica_id = p_destino WHERE forma_farmaceutica_id = p_origen;
        GET DIAGNOSTICS v_movidos = ROW_COUNT;
    ELSE
        -- Moleculas: si un producto ya tiene la molecula destino, se queda esa
        -- fila (y hereda "principal" si la del origen lo era).
        CREATE TEMP TABLE tmp_principal ON COMMIT DROP AS
            SELECT o.producto_id FROM public.producto_principios o
            WHERE o.principio_activo_id = p_origen AND o.es_principal
              AND EXISTS (SELECT 1 FROM public.producto_principios d
                          WHERE d.producto_id = o.producto_id AND d.principio_activo_id = p_destino);
        DELETE FROM public.producto_principios o
        WHERE o.principio_activo_id = p_origen
          AND EXISTS (SELECT 1 FROM public.producto_principios d
                      WHERE d.producto_id = o.producto_id AND d.principio_activo_id = p_destino);
        UPDATE public.producto_principios SET es_principal = TRUE
        WHERE principio_activo_id = p_destino AND producto_id IN (SELECT producto_id FROM tmp_principal);
        UPDATE public.producto_principios SET principio_activo_id = p_destino WHERE principio_activo_id = p_origen;
        GET DIAGNOSTICS v_movidos = ROW_COUNT;
    END IF;

    -- El nombre viejo (y sus sinonimos) quedan como sinonimos del destino.
    EXECUTE format(
        'UPDATE public.%I SET sinonimos = ARRAY(
             SELECT DISTINCT x FROM unnest(coalesce(sinonimos, ''{}'') || $1 || $2) x
             WHERE lower(x) <> lower(nombre))
         WHERE id = $3', p_tabla)
        USING v_nombre_origen, v_sin_origen, p_destino;

    EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_tabla) USING p_origen;
    RETURN v_movidos;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_unir_dimension(TEXT, BIGINT, BIGINT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_unir_dimension(TEXT, BIGINT, BIGINT) TO authenticated;

-- COMPROBACION: los laboratorios mas usados.
SELECT l.nombre, coalesce(u.propios, 0) AS productos_propios, coalesce(u.competidores, 0) AS competidores
FROM public.dim_laboratorios l
LEFT JOIN public.v_uso_dimensiones u ON u.tabla = 'dim_laboratorios' AND u.id = l.id
ORDER BY coalesce(u.propios, 0) + coalesce(u.competidores, 0) DESC
LIMIT 10;
