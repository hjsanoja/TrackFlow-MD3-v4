-- ============================================================================
-- TRACKFLOW - FASE 50: PERFILES DE PERMISOS Y MAPA DE CALOR EN EL MENU
-- ============================================================================
-- 1. perfiles_usuario: plantillas de permisos (rol, menus, "solo ver" y que
--    productos ve) para aplicar de una vez al crear o editar un usuario en
--    Usuarios. Aplicar un perfil COPIA sus valores al usuario: si despues se
--    cambia el perfil, los usuarios que ya lo usaron no cambian.
--    Solo los administradores los ven y los cambian.
-- 2. El Mapa de calor salio de Experimental a su propio menu (/mapa-cadenas).
--    Se suma a los usuarios de consulta que veian Rango de precios o
--    Experimental, para que nadie lo pierda.
--
-- ORDEN: despues de fase49. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Perfiles
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.perfiles_usuario (
    id                 BIGSERIAL PRIMARY KEY,
    nombre             TEXT NOT NULL UNIQUE,
    rol                TEXT NOT NULL DEFAULT 'consulta' CHECK (rol IN ('consulta', 'administrador')),
    menus_permitidos   TEXT[] NOT NULL DEFAULT ARRAY['/', '/mapa-calor', '/mapa-cadenas'],
    menus_solo_lectura TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    alcance            JSONB,
    creado             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.perfiles_usuario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS perfiles_usuario_leer ON public.perfiles_usuario;
DROP POLICY IF EXISTS perfiles_usuario_crear ON public.perfiles_usuario;
DROP POLICY IF EXISTS perfiles_usuario_cambiar ON public.perfiles_usuario;
DROP POLICY IF EXISTS perfiles_usuario_borrar ON public.perfiles_usuario;
CREATE POLICY perfiles_usuario_leer ON public.perfiles_usuario FOR SELECT TO authenticated USING ((SELECT public.fn_es_admin()));
CREATE POLICY perfiles_usuario_crear ON public.perfiles_usuario FOR INSERT TO authenticated WITH CHECK ((SELECT public.fn_es_admin()));
CREATE POLICY perfiles_usuario_cambiar ON public.perfiles_usuario FOR UPDATE TO authenticated USING ((SELECT public.fn_es_admin())) WITH CHECK ((SELECT public.fn_es_admin()));
CREATE POLICY perfiles_usuario_borrar ON public.perfiles_usuario FOR DELETE TO authenticated USING ((SELECT public.fn_es_admin()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.perfiles_usuario TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.perfiles_usuario_id_seq TO authenticated;

-- Dos perfiles de ejemplo (se pueden cambiar o borrar desde el panel).
INSERT INTO public.perfiles_usuario (nombre, rol, menus_permitidos, menus_solo_lectura)
VALUES
    ('Solo ver precios', 'consulta', ARRAY['/', '/mapa-calor', '/mapa-cadenas'], ARRAY['/', '/mapa-calor', '/mapa-cadenas']),
    ('Analista', 'consulta', ARRAY['/', '/mapa-calor', '/mapa-cadenas', '/productos', '/competencia', '/experimental'], ARRAY[]::TEXT[])
ON CONFLICT (nombre) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Mapa de calor en el menu de quien ya veia precios
-- ----------------------------------------------------------------------------
UPDATE public.usuarios
SET menus_permitidos = array_append(menus_permitidos, '/mapa-cadenas')
WHERE menus_permitidos IS NOT NULL
  AND NOT ('/mapa-cadenas' = ANY (menus_permitidos))
  AND ('/mapa-calor' = ANY (menus_permitidos) OR '/experimental' = ANY (menus_permitidos));

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT nombre, rol, menus_permitidos FROM perfiles_usuario ORDER BY nombre;
-- SELECT email, menus_permitidos FROM usuarios WHERE rol <> 'administrador';
