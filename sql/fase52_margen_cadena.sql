-- ============================================================================
-- FASE 52: Margen por cadena
-- ----------------------------------------------------------------------------
-- 1. Menu nuevo «Margen por cadena» (/margen-cadena): se suma UNA VEZ a todos
--    los usuarios que ya existen y a los perfiles guardados. A los usuarios
--    nuevos se les elige como a cualquier otro menu (Usuarios o perfiles).
-- 2. preferencias_usuario: lo que cada usuario deja elegido en una pantalla
--    (cadena, factor, laboratorios...). Cada quien ve y cambia SOLO lo suyo,
--    y lo encuentra igual desde cualquier equipo.
--
-- ORDEN: despues de fase51. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Menu para los usuarios y perfiles que ya existen
-- ----------------------------------------------------------------------------
UPDATE public.usuarios
SET menus_permitidos = array_append(menus_permitidos, '/margen-cadena')
WHERE menus_permitidos IS NOT NULL
  AND cardinality(menus_permitidos) > 0
  AND NOT ('/margen-cadena' = ANY (menus_permitidos));

UPDATE public.perfiles_usuario
SET menus_permitidos = array_append(menus_permitidos, '/margen-cadena')
WHERE NOT ('/margen-cadena' = ANY (menus_permitidos));

-- ----------------------------------------------------------------------------
-- 2. Preferencias de cada usuario
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.preferencias_usuario (
    email       TEXT NOT NULL DEFAULT public.fn_mi_email(),
    clave       TEXT NOT NULL,
    valor       JSONB NOT NULL DEFAULT '{}'::jsonb,
    actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (email, clave)
);

ALTER TABLE public.preferencias_usuario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS preferencias_usuario_leer ON public.preferencias_usuario;
DROP POLICY IF EXISTS preferencias_usuario_crear ON public.preferencias_usuario;
DROP POLICY IF EXISTS preferencias_usuario_cambiar ON public.preferencias_usuario;
CREATE POLICY preferencias_usuario_leer ON public.preferencias_usuario FOR SELECT TO authenticated
    USING (email = (SELECT public.fn_mi_email()));
CREATE POLICY preferencias_usuario_crear ON public.preferencias_usuario FOR INSERT TO authenticated
    WITH CHECK (email = (SELECT public.fn_mi_email()) AND (SELECT public.fn_usuario_activo()));
CREATE POLICY preferencias_usuario_cambiar ON public.preferencias_usuario FOR UPDATE TO authenticated
    USING (email = (SELECT public.fn_mi_email()))
    WITH CHECK (email = (SELECT public.fn_mi_email()));
-- Sin politica de DELETE: nadie borra (se cambia el valor).

GRANT SELECT, INSERT, UPDATE ON public.preferencias_usuario TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT email, menus_permitidos FROM usuarios WHERE rol <> 'administrador';
-- SELECT nombre, menus_permitidos FROM perfiles_usuario ORDER BY nombre;
-- SELECT email, clave, valor, actualizado FROM preferencias_usuario;
