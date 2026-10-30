-- ============================================================================
-- FASE 56: calendario de ofertas (Experimental)
-- ----------------------------------------------------------------------------
-- Que dias y en que cadenas hubo ofertas: precio con descuento o promocion
-- (2x1, 3x2, 2.a unidad...). Una captura por enlace y dia (la ultima).
--   fn_calendario_ofertas(desde, hasta, quien): por dia y cadena, cuantos
--     enlaces leidos y cuantos en oferta, y el descuento promedio.
--     quien: 'competencia' | 'propio' | 'todos'.
--   fn_ofertas_del_dia(fecha, cadena, quien): el detalle de un dia.
-- Son SECURITY INVOKER: respetan las cadenas de baja (fase 53).
--
-- ORDEN: despues de fase55. Es idempotente.
-- ============================================================================

SET search_path = public;

CREATE INDEX IF NOT EXISTS idx_fact_precios_fecha_pub
    ON public.fact_precios (fecha_captura, publicacion_id);

CREATE OR REPLACE FUNCTION public.fn_calendario_ofertas(
    p_desde DATE,
    p_hasta DATE,
    p_quien TEXT DEFAULT 'competencia'
)
RETURNS TABLE (
    fecha DATE,
    cadena_id TEXT,
    enlaces INT,
    en_oferta INT,
    con_promocion INT,
    descuento_promedio NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
    WITH diario AS (
        SELECT DISTINCT ON (fp.publicacion_id, (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date)
            (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha,
            pub.cadena_id::text AS cadena_id,
            fp.precio_full_bs, fp.precio_desc_bs, fp.tiene_promocion
        FROM fact_precios fp
        JOIN publicaciones pub ON pub.id = fp.publicacion_id
        JOIN dim_productos p ON p.id = pub.producto_id
        JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
        WHERE fp.estado = 'ok' AND fp.disponible AND NOT fp.sospechoso
          AND fp.fecha_captura >= (p_desde::timestamp AT TIME ZONE 'America/Caracas')
          AND fp.fecha_captura < ((p_hasta + 1)::timestamp AT TIME ZONE 'America/Caracas')
          AND (p_quien = 'todos' OR (p_quien = 'propio') = lab.es_propio)
        ORDER BY fp.publicacion_id, (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date, fp.fecha_captura DESC
    ), marcado AS (
        SELECT *,
               (precio_desc_bs > 0 AND precio_full_bs > 0 AND precio_desc_bs < precio_full_bs * 0.995) AS con_descuento
        FROM diario
    )
    SELECT fecha, cadena_id,
           count(*)::int AS enlaces,
           count(*) FILTER (WHERE con_descuento OR tiene_promocion)::int AS en_oferta,
           count(*) FILTER (WHERE tiene_promocion)::int AS con_promocion,
           round(avg((1 - precio_desc_bs / precio_full_bs) * 100) FILTER (WHERE con_descuento), 1) AS descuento_promedio
    FROM marcado
    GROUP BY fecha, cadena_id
    ORDER BY fecha, cadena_id;
$$;

CREATE OR REPLACE FUNCTION public.fn_ofertas_del_dia(
    p_fecha DATE,
    p_cadena TEXT DEFAULT NULL,
    p_quien TEXT DEFAULT 'competencia'
)
RETURNS TABLE (
    cadena_id TEXT,
    id_producto_propio TEXT,
    producto_nombre TEXT,
    laboratorio TEXT,
    es_propio BOOLEAN,
    precio_full_bs NUMERIC,
    precio_desc_bs NUMERIC,
    descuento NUMERIC,
    promocion TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (fp.publicacion_id)
        pub.cadena_id::text,
        COALESCE(p_propio.id_interno, p.id_interno)::text,
        p.nombre::text,
        lab.nombre::text,
        lab.es_propio,
        fp.precio_full_bs,
        fp.precio_desc_bs,
        CASE WHEN fp.precio_desc_bs > 0 AND fp.precio_full_bs > 0 AND fp.precio_desc_bs < fp.precio_full_bs
             THEN round((1 - fp.precio_desc_bs / fp.precio_full_bs) * 100, 1) END,
        COALESCE(tp.codigo, fp.promo_texto_raw)::text
    FROM fact_precios fp
    JOIN publicaciones pub ON pub.id = fp.publicacion_id
    JOIN dim_productos p ON p.id = pub.producto_id
    JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
    LEFT JOIN producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
    LEFT JOIN dim_productos p_propio ON p_propio.id = pe.producto_propio_id
    LEFT JOIN dim_tipos_promocion tp ON tp.id = fp.tipo_promocion_id
    WHERE fp.estado = 'ok' AND fp.disponible AND NOT fp.sospechoso
      AND (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date = p_fecha
      AND (p_cadena IS NULL OR lower(pub.cadena_id) = lower(p_cadena))
      AND (p_quien = 'todos' OR (p_quien = 'propio') = lab.es_propio)
      AND (fp.tiene_promocion OR (fp.precio_desc_bs > 0 AND fp.precio_desc_bs < fp.precio_full_bs * 0.995))
    ORDER BY fp.publicacion_id, fp.fecha_captura DESC;
$$;

GRANT EXECUTE ON FUNCTION public.fn_calendario_ofertas(DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ofertas_del_dia(DATE, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFICACION (opcional)
-- SELECT * FROM fn_calendario_ofertas(current_date - 30, current_date) LIMIT 20;
