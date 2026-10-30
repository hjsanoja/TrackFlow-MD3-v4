-- ============================================================================
-- FASE 57: buscador, etapa 2 — competidores nuevos
-- ----------------------------------------------------------------------------
-- El robot buscador (scraper/buscar_enlaces.py con MODO=competidores) busca
-- en cada cadena la MOLECULA y la DOSIS de cada producto tuyo («losartan 50
-- mg») y propone lo que encuentra de otros laboratorios que todavia no esta
-- registrado. Nada se crea solo: en el panel (Experimental > Competidores
-- nuevos) se acepta o se descarta.
--   competidores_nuevos: las propuestas.
--   v_competidores_nuevos: con los datos de tu producto, para el panel.
--   fn_aceptar_competidor: crea el producto competidor (con su laboratorio,
--     molecula y dosis), su relacion con tu producto y el enlace en la cadena.
--
-- ORDEN: despues de fase56. Es idempotente.
-- ============================================================================

SET search_path = public;

CREATE TABLE IF NOT EXISTS public.competidores_nuevos (
    id                  BIGSERIAL PRIMARY KEY,
    producto_propio_id  BIGINT NOT NULL REFERENCES public.dim_productos(id) ON DELETE CASCADE,
    cadena_id           VARCHAR(50) NOT NULL REFERENCES public.dim_cadenas(id) ON DELETE CASCADE,
    url                 TEXT NOT NULL,
    nombre_tienda       TEXT,
    marca_tienda        TEXT,
    laboratorio_leido   TEXT,
    precio              NUMERIC(14, 2),
    moneda              VARCHAR(3),
    disponible          BOOLEAN,
    puntaje             INT NOT NULL,
    detalle             JSONB,     -- {dosis, tamano, molecula: 'si'|'no'|'?', tamano_leido, unidad_leida, consulta}
    estado              VARCHAR(12) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'aceptada', 'descartada')),
    publicacion_id      BIGINT REFERENCES public.publicaciones(id) ON DELETE SET NULL,
    creado              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revisado            TIMESTAMPTZ,
    CONSTRAINT uq_competidor_nuevo UNIQUE (producto_propio_id, cadena_id, url)
);
CREATE INDEX IF NOT EXISTS idx_competidores_nuevos_estado ON public.competidores_nuevos (estado, puntaje DESC);

ALTER TABLE public.competidores_nuevos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS competidores_nuevos_leer ON public.competidores_nuevos;
DROP POLICY IF EXISTS competidores_nuevos_cambiar ON public.competidores_nuevos;
CREATE POLICY competidores_nuevos_leer ON public.competidores_nuevos FOR SELECT TO authenticated
    USING ((SELECT public.fn_usuario_activo()));
CREATE POLICY competidores_nuevos_cambiar ON public.competidores_nuevos FOR UPDATE TO authenticated
    USING ((SELECT public.fn_usuario_activo())) WITH CHECK ((SELECT public.fn_usuario_activo()));
GRANT SELECT, UPDATE ON public.competidores_nuevos TO authenticated;

CREATE OR REPLACE VIEW public.v_competidores_nuevos
WITH (security_invoker = true)
AS
SELECT
    c.*,
    p.id_interno AS propio_id,
    p.nombre AS propio_nombre,
    (SELECT pa.nombre FROM producto_principios pp JOIN dim_principios_activos pa ON pa.id = pp.principio_activo_id
      WHERE pp.producto_id = p.id ORDER BY pp.es_principal DESC, pp.id LIMIT 1) AS propio_molecula
FROM public.competidores_nuevos c
JOIN public.dim_productos p ON p.id = c.producto_propio_id;
GRANT SELECT ON public.v_competidores_nuevos TO authenticated;

-- Acepta una propuesta: laboratorio (se crea si no existe), producto
-- competidor COMP_N<id> con la molecula y la dosis de tu producto, relacion
-- y enlace. Devuelve el id del enlace (publicaciones).
CREATE OR REPLACE FUNCTION public.fn_aceptar_competidor(
    p_id BIGINT,
    p_laboratorio TEXT,
    p_nombre TEXT DEFAULT NULL,
    p_tipo_mercado TEXT DEFAULT 'GENERICO'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    s RECORD;
    pr RECORD;
    v_norm TEXT;
    v_lab BIGINT;
    v_comp BIGINT;
    v_pub BIGINT;
    v_cant NUMERIC;
    v_unidad TEXT;
    v_molecula TEXT;
BEGIN
    SELECT * INTO s FROM competidores_nuevos WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'La propuesta % no existe.', p_id; END IF;
    IF s.estado = 'aceptada' THEN RETURN s.publicacion_id; END IF;
    IF coalesce(trim(p_laboratorio), '') = '' THEN RAISE EXCEPTION 'Falta el laboratorio del competidor.'; END IF;

    v_norm := lower(regexp_replace(trim(s.url), '\?.*$', ''));
    IF EXISTS (SELECT 1 FROM publicaciones WHERE cadena_id = s.cadena_id AND url_normalizada = v_norm) THEN
        RAISE EXCEPTION 'Ese enlace ya está registrado en esta cadena.';
    END IF;

    SELECT * INTO pr FROM dim_productos WHERE id = s.producto_propio_id;

    SELECT id INTO v_lab FROM dim_laboratorios WHERE lower(nombre) = lower(trim(p_laboratorio)) LIMIT 1;
    IF v_lab IS NULL THEN
        INSERT INTO dim_laboratorios (nombre, es_propio) VALUES (trim(p_laboratorio), FALSE) RETURNING id INTO v_lab;
    END IF;

    v_cant := COALESCE(NULLIF((s.detalle ->> 'tamano_leido'), '')::NUMERIC, pr.cantidad_contenido);
    v_unidad := COALESCE(NULLIF(s.detalle ->> 'unidad_leida', ''), pr.unidad_contenido);
    IF v_unidad NOT IN ('unidad', 'ml', 'g') THEN v_unidad := pr.unidad_contenido; END IF;
    SELECT pa.nombre INTO v_molecula FROM producto_principios pp JOIN dim_principios_activos pa ON pa.id = pp.principio_activo_id
     WHERE pp.producto_id = pr.id ORDER BY pp.es_principal DESC, pp.id LIMIT 1;

    INSERT INTO dim_productos (id_interno, nombre, laboratorio_id, categoria_id, unidad_negocio_id, forma_farmaceutica_id,
                               cantidad_contenido, unidad_contenido, tipo_mercado, activo, molecula_competidor)
    VALUES ('COMP_N' || p_id, left(coalesce(nullif(trim(p_nombre), ''), s.nombre_tienda, 'Competidor'), 255), v_lab,
            pr.categoria_id, NULL, pr.forma_farmaceutica_id, v_cant, v_unidad,
            CASE WHEN upper(p_tipo_mercado) = 'MARCA' THEN 'MARCA' ELSE 'GENERICO' END, TRUE, v_molecula)
    ON CONFLICT (id_interno) DO UPDATE SET nombre = EXCLUDED.nombre
    RETURNING id INTO v_comp;

    -- La misma molecula y dosis que tu producto (el robot solo propone esa dosis).
    INSERT INTO producto_principios (producto_id, principio_activo_id, concentracion_valor, concentracion_unidad, por_cantidad, por_unidad, es_principal)
    SELECT v_comp, pp.principio_activo_id, pp.concentracion_valor, pp.concentracion_unidad, pp.por_cantidad, pp.por_unidad, pp.es_principal
    FROM producto_principios pp WHERE pp.producto_id = pr.id
    ON CONFLICT (producto_id, principio_activo_id) DO NOTHING;

    INSERT INTO producto_equivalencias (producto_propio_id, producto_competidor_id, tipo_equivalencia, activo)
    VALUES (pr.id, v_comp, 'misma_molecula', TRUE)
    ON CONFLICT (producto_propio_id, producto_competidor_id) DO UPDATE SET activo = TRUE;

    INSERT INTO publicaciones (producto_id, cadena_id, url, url_normalizada, activo)
    VALUES (v_comp, s.cadena_id, trim(s.url), v_norm, TRUE)
    RETURNING id INTO v_pub;

    UPDATE competidores_nuevos
    SET estado = 'aceptada', revisado = NOW(), actualizado = NOW(), publicacion_id = v_pub
    WHERE id = p_id;
    RETURN v_pub;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_aceptar_competidor(BIGINT, TEXT, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- VERIFICACION (opcional)
-- SELECT estado, count(*) FROM competidores_nuevos GROUP BY 1;
