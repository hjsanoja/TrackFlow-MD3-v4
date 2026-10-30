-- ============================================================================
-- FASE 55: revision automatica de capturas dudosas
-- ----------------------------------------------------------------------------
-- El control de calidad marca «dudosa» una captura cuyo precio se movio mucho
-- frente al ultimo precio valido. Cuando la subida es real, TODAS las
-- capturas siguientes tambien salen dudosas (se comparan contra el precio
-- viejo) y la bandeja se llena. fn_revision_automatica confirma solas las
-- evidentes, solo por motivo de precio (nombre y presentacion siguen siendo
-- a mano):
--   1. Solo la tasa: en dolares el precio esta a ±2 % del ultimo valido; lo
--      que se movio fue el bolivar.
--   2. Precio sostenido: la tienda mostro el mismo precio nuevo (±1 %) en 2
--      o mas dias distintos seguidos.
-- Quedan como revisadas y validas, con fact_precios.revision_automatica =
-- 'solo_tasa' | 'precio_sostenido' para saber cuales fueron. «Volver a
-- revisar» en la bandeja las deshace como a cualquier otra.
-- La llama el robot al terminar (push_to_supabase.py) y el boton de la
-- bandeja de Revision de capturas.
--
-- ORDEN: despues de fase54. Es idempotente.
-- ============================================================================

SET search_path = public;

ALTER TABLE public.fact_precios ADD COLUMN IF NOT EXISTS revision_automatica TEXT;

CREATE OR REPLACE FUNCTION public.fn_revision_automatica(p_aplicar BOOLEAN DEFAULT TRUE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tasa BIGINT[];
    v_sostenido BIGINT[];
BEGIN
    IF NOT (coalesce(auth.jwt() ->> 'role', '') = 'service_role' OR public.fn_usuario_activo()) THEN
        RAISE EXCEPTION 'Sin permiso';
    END IF;

    -- 1. Solo la tasa
    SELECT coalesce(array_agg(p.id), ARRAY[]::BIGINT[]) INTO v_tasa
    FROM fact_precios p
    CROSS JOIN LATERAL (
        SELECT COALESCE(v.precio_desc_bs, v.precio_full_bs) / v.tasa_bcv AS usd
        FROM fact_precios v
        WHERE v.publicacion_id = p.publicacion_id AND v.estado = 'ok' AND NOT v.sospechoso
          AND v.disponible AND v.fecha_captura < p.fecha_captura
        ORDER BY v.fecha_captura DESC
        LIMIT 1
    ) ref
    WHERE p.sospechoso AND NOT p.revisado_manual AND p.motivo_sospecha = 'variacion_precio'
      AND p.estado = 'ok' AND p.tasa_bcv > 0 AND ref.usd > 0
      AND abs((COALESCE(p.precio_desc_bs, p.precio_full_bs) / p.tasa_bcv) / ref.usd - 1) <= 0.02;

    -- 2. Precio sostenido: las dudosas por precio de cada enlace despues de
    --    su ultimo precio valido, en 2 o mas dias, todas a ±1 % entre si.
    WITH ultima_valida AS (
        SELECT publicacion_id, max(fecha_captura) AS fecha
        FROM fact_precios
        WHERE estado = 'ok' AND NOT sospechoso AND disponible
        GROUP BY publicacion_id
    ), pendientes AS (
        SELECT p.id, p.publicacion_id, COALESCE(p.precio_desc_bs, p.precio_full_bs) AS bs,
               (p.fecha_captura AT TIME ZONE 'America/Caracas')::date AS dia
        FROM fact_precios p
        LEFT JOIN ultima_valida u ON u.publicacion_id = p.publicacion_id
        WHERE p.sospechoso AND NOT p.revisado_manual AND p.motivo_sospecha = 'variacion_precio'
          AND p.estado = 'ok' AND p.disponible
          AND (u.fecha IS NULL OR p.fecha_captura > u.fecha)
          AND NOT (p.id = ANY (v_tasa))
    ), grupos AS (
        SELECT publicacion_id
        FROM pendientes
        GROUP BY publicacion_id
        HAVING count(DISTINCT dia) >= 2 AND min(bs) > 0 AND max(bs) / min(bs) <= 1.01
    )
    SELECT coalesce(array_agg(pe.id), ARRAY[]::BIGINT[]) INTO v_sostenido
    FROM pendientes pe JOIN grupos g ON g.publicacion_id = pe.publicacion_id;

    IF p_aplicar THEN
        UPDATE fact_precios SET sospechoso = FALSE, revisado_manual = TRUE, revision_automatica = 'solo_tasa'
        WHERE id = ANY (v_tasa);
        UPDATE fact_precios SET sospechoso = FALSE, revisado_manual = TRUE, revision_automatica = 'precio_sostenido'
        WHERE id = ANY (v_sostenido);
    END IF;

    RETURN jsonb_build_object(
        'solo_tasa', cardinality(v_tasa),
        'precio_sostenido', cardinality(v_sostenido),
        'aplicado', p_aplicar
    );
END;
$$;

-- La bandeja borra la marca al «Volver a revisar» (permiso de columna como
-- los de la fase 12).
GRANT UPDATE (revision_automatica) ON public.fact_precios TO authenticated;

REVOKE ALL ON FUNCTION public.fn_revision_automatica(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_revision_automatica(BOOLEAN) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional): cuantas confirmaria hoy, sin cambiar nada
-- ----------------------------------------------------------------------------
-- SELECT fn_revision_automatica(FALSE);
-- SELECT revision_automatica, count(*) FROM fact_precios WHERE revision_automatica IS NOT NULL GROUP BY 1;
