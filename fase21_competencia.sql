-- ============================================================================
-- TRACKFLOW - FASE 21: COMPETENCIA - HUERFANOS Y PRECIO MANUAL
-- ============================================================================
-- 1. Borra los productos competidores (COMP_) que ya no tienen ninguna URL.
--    Los dejo el panel al editar enlaces: cada edicion creaba un competidor
--    nuevo y le pasaba la URL, y el anterior quedaba sin publicaciones. No
--    tienen precios (los precios cuelgan de las publicaciones), asi que no se
--    pierde historial.
-- 2. Crea fn_registrar_precio_manual: el panel no puede insertar en
--    fact_precios (RLS: solo el scraper), y la correccion manual de precio
--    escribia en una vista y no guardaba nada.
--
-- Idempotente: se puede correr mas de una vez.
-- ============================================================================

-- VISTA PREVIA (opcional): los competidores que se van a borrar.
/*
SELECT p.id, p.id_interno, p.nombre, l.nombre AS laboratorio
FROM dim_productos p
JOIN dim_laboratorios l ON l.id = p.laboratorio_id
WHERE p.id_interno LIKE 'COMP\_%'
  AND NOT EXISTS (SELECT 1 FROM publicaciones pub WHERE pub.producto_id = p.id)
ORDER BY p.nombre;
*/

-- ----------------------------------------------------------------------------
-- 1. COMPETIDORES SIN URL
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_equivalencias INT;
    v_borrados INT;
BEGIN
    CREATE TEMP TABLE tmp_huerfanos ON COMMIT DROP AS
    SELECT p.id
    FROM public.dim_productos p
    WHERE p.id_interno LIKE 'COMP\_%'
      AND NOT EXISTS (SELECT 1 FROM public.publicaciones pub WHERE pub.producto_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.pvp_propio pv WHERE pv.producto_id = p.id)
      -- nunca un competidor que figure como producto propio de una equivalencia
      AND NOT EXISTS (SELECT 1 FROM public.producto_equivalencias e WHERE e.producto_propio_id = p.id);

    DELETE FROM public.producto_equivalencias
    WHERE producto_competidor_id IN (SELECT id FROM tmp_huerfanos);
    GET DIAGNOSTICS v_equivalencias = ROW_COUNT;

    -- producto_principios se borra solo (ON DELETE CASCADE).
    DELETE FROM public.dim_productos WHERE id IN (SELECT id FROM tmp_huerfanos);
    GET DIAGNOSTICS v_borrados = ROW_COUNT;

    RAISE NOTICE 'Competidores sin URL borrados: %. Equivalencias suyas borradas: %.', v_borrados, v_equivalencias;
END $$;

-- ----------------------------------------------------------------------------
-- 2. PRECIO MANUAL
-- ----------------------------------------------------------------------------
-- Registra una captura con origen 'manual' para una publicacion, con la tasa
-- BCV mas reciente. SECURITY DEFINER porque fact_precios solo admite
-- escrituras del scraper; por eso la funcion exige un usuario autenticado y
-- valida lo que recibe.
CREATE OR REPLACE FUNCTION public.fn_registrar_precio_manual(
    p_publicacion_id BIGINT,
    p_precio_full_bs NUMERIC,
    p_precio_desc_bs NUMERIC DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tasa   NUMERIC;
    v_fecha  DATE;
    v_nombre TEXT;
    v_id     BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Hace falta iniciar sesión para registrar un precio.';
    END IF;
    IF p_precio_full_bs IS NULL OR p_precio_full_bs <= 0 THEN
        RAISE EXCEPTION 'El precio tiene que ser mayor que cero.';
    END IF;
    IF p_precio_desc_bs IS NOT NULL AND (p_precio_desc_bs <= 0 OR p_precio_desc_bs > p_precio_full_bs) THEN
        RAISE EXCEPTION 'El precio de oferta tiene que ser mayor que cero y no mayor que el precio normal.';
    END IF;

    SELECT p.nombre INTO v_nombre
    FROM publicaciones pub JOIN dim_productos p ON p.id = pub.producto_id
    WHERE pub.id = p_publicacion_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe la publicación %.', p_publicacion_id;
    END IF;

    SELECT fecha, tasa INTO v_fecha, v_tasa
    FROM dim_tasa_bcv ORDER BY fecha DESC LIMIT 1;
    IF v_tasa IS NULL THEN
        RAISE EXCEPTION 'No hay ninguna tasa BCV registrada.';
    END IF;

    INSERT INTO fact_precios (
        publicacion_id, scrape_run_id, fecha_captura,
        precio_full_bs, precio_desc_bs,
        tasa_bcv, tasa_origen,
        disponible, estado, nombre_capturado,
        sospechoso, revisado_manual,
        tiene_promocion, origen
    ) VALUES (
        p_publicacion_id, NULL, NOW(),
        p_precio_full_bs, p_precio_desc_bs,
        v_tasa, CASE WHEN v_fecha = CURRENT_DATE THEN 'bcv_del_dia' ELSE 'ultima_conocida' END,
        TRUE, 'ok', v_nombre || ' (manual)',
        FALSE, TRUE,
        p_precio_desc_bs IS NOT NULL AND p_precio_desc_bs < p_precio_full_bs, 'manual'
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.fn_registrar_precio_manual(BIGINT, NUMERIC, NUMERIC) IS
'Registra a mano el precio de una publicacion (origen manual) con la ultima tasa BCV. La usa Competencia cuando el robot falla.';

REVOKE ALL ON FUNCTION public.fn_registrar_precio_manual(BIGINT, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_registrar_precio_manual(BIGINT, NUMERIC, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- COMPROBACION: debe dar 0.
-- ----------------------------------------------------------------------------
SELECT count(*) AS competidores_sin_url
FROM public.dim_productos p
WHERE p.id_interno LIKE 'COMP\_%'
  AND NOT EXISTS (SELECT 1 FROM public.publicaciones pub WHERE pub.producto_id = p.id);
