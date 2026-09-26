-- ============================================================================
-- FASE 25: seguridad de usuarios y accesos
-- ============================================================================
-- La tabla usuarios estaba sin RLS y con permisos para el rol publico (anon):
-- con la clave publica del panel cualquiera podia leerla y hacerse
-- administrador. Ademas, las politicas de las tablas de datos dejaban todo a
-- cualquier sesion iniciada, aunque la persona no estuviera en usuarios o
-- estuviera inactiva.
--
-- Esta fase:
--   1. Funciones fn_usuario_activo() y fn_es_admin(): la sesion pertenece a
--      alguien de la tabla usuarios, activo (y administrador).
--   2. usuarios con RLS: cada quien ve su fila; el administrador ve y cambia
--      todas. Nadie mas.
--   3. Las politicas "abiertas" (USING true) de las demas tablas pasan a
--      exigir un usuario activo: desactivar a alguien le corta el acceso a los
--      datos al instante, tambien por la API.
--   4. Quita todos los permisos al rol publico (anon). El inicio de sesion no
--      los necesita.
--   5. Registro de accesos (tabla accesos) y funciones para "Mi cuenta" y para
--      eliminar un usuario de verdad (tambien su cuenta de acceso).
--
-- Antes de cambiar nada comprueba que haya un administrador activo, para que
-- nadie se quede fuera. Se puede correr mas de una vez.
-- ============================================================================

-- 0. Seguro: sin un administrador activo no se toca nada.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.usuarios
        WHERE lower(coalesce(rol, '')) = 'administrador'
          AND lower(coalesce(activo::text, '')) IN ('true', 't', 'si', 'sí', '1')
          AND coalesce(email, '') <> ''
    ) THEN
        RAISE EXCEPTION 'No hay ningun administrador activo en usuarios. No se cambio nada.';
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. QUIEN ES LA SESION
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mi_email()
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- SECURITY DEFINER: lee usuarios sin pasar por su RLS (si no, la politica de
-- usuarios se llamaria a si misma).
CREATE OR REPLACE FUNCTION public.fn_usuario_activo()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.usuarios u
        WHERE lower(u.email) = public.fn_mi_email()
          AND public.fn_mi_email() <> ''
          AND lower(coalesce(u.activo::text, '')) IN ('true', 't', 'si', 'sí', '1')
    );
$$;

CREATE OR REPLACE FUNCTION public.fn_es_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.usuarios u
        WHERE lower(u.email) = public.fn_mi_email()
          AND public.fn_mi_email() <> ''
          AND lower(coalesce(u.rol, '')) = 'administrador'
          AND lower(coalesce(u.activo::text, '')) IN ('true', 't', 'si', 'sí', '1')
    );
$$;

-- ----------------------------------------------------------------------------
-- 2. TABLA USUARIOS
-- ----------------------------------------------------------------------------
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'usuarios' LOOP
        EXECUTE format('DROP POLICY %I ON public.usuarios', p.policyname);
    END LOOP;
END $$;

CREATE POLICY usuarios_ver ON public.usuarios FOR SELECT TO authenticated
    USING (lower(email) = (SELECT public.fn_mi_email()) OR (SELECT public.fn_es_admin()));
CREATE POLICY usuarios_crear ON public.usuarios FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.fn_es_admin()));
CREATE POLICY usuarios_cambiar ON public.usuarios FOR UPDATE TO authenticated
    USING ((SELECT public.fn_es_admin())) WITH CHECK ((SELECT public.fn_es_admin()));
CREATE POLICY usuarios_borrar ON public.usuarios FOR DELETE TO authenticated
    USING ((SELECT public.fn_es_admin()));

-- ----------------------------------------------------------------------------
-- 3. LAS DEMAS TABLAS: SOLO USUARIOS ACTIVOS
-- ----------------------------------------------------------------------------
-- Solo se cambian las politicas que dejaban pasar a cualquiera (USING true /
-- WITH CHECK true). Las que tienen una condicion propia no se tocan. Las que
-- eran para "public" pasan a "authenticated".
DO $$
DECLARE
    p RECORD;
    abierto_using BOOLEAN;
    abierto_check BOOLEAN;
    cambiadas INT := 0;
BEGIN
    FOR p IN
        SELECT tablename, policyname, cmd, qual, with_check, roles
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename NOT IN ('usuarios', 'accesos')
          AND (roles && ARRAY['authenticated', 'public', 'anon']::name[])
    LOOP
        abierto_using := coalesce(p.qual, '') = 'true';
        abierto_check := coalesce(p.with_check, '') = 'true';

        IF p.cmd IN ('SELECT', 'DELETE') AND abierto_using THEN
            EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated USING ((SELECT public.fn_usuario_activo()))',
                           p.policyname, p.tablename);
            cambiadas := cambiadas + 1;
        ELSIF p.cmd = 'INSERT' AND abierto_check THEN
            EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated WITH CHECK ((SELECT public.fn_usuario_activo()))',
                           p.policyname, p.tablename);
            cambiadas := cambiadas + 1;
        ELSIF p.cmd IN ('UPDATE', 'ALL') AND abierto_using AND (p.with_check IS NULL OR abierto_check) THEN
            EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated USING ((SELECT public.fn_usuario_activo())) WITH CHECK ((SELECT public.fn_usuario_activo()))',
                           p.policyname, p.tablename);
            cambiadas := cambiadas + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'Politicas que ahora exigen un usuario activo: %', cambiadas;
END $$;

-- ----------------------------------------------------------------------------
-- 4. FUERA EL ROL PUBLICO
-- ----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
-- Lo que se cree en adelante tampoco queda abierto.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;

-- ----------------------------------------------------------------------------
-- 5. ACCESOS, MI CUENTA Y ELIMINAR USUARIO
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accesos (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    evento TEXT NOT NULL CHECK (evento IN ('ingreso', 'salida', 'clave_cambiada', 'recuperacion')),
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agente TEXT
);
CREATE INDEX IF NOT EXISTS ix_accesos_email_fecha ON public.accesos (email, fecha DESC);

ALTER TABLE public.accesos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accesos FROM anon;
GRANT SELECT ON public.accesos TO authenticated;
DROP POLICY IF EXISTS accesos_ver ON public.accesos;
CREATE POLICY accesos_ver ON public.accesos FOR SELECT TO authenticated
    USING (email = (SELECT public.fn_mi_email()) OR (SELECT public.fn_es_admin()));

-- Se anota con el correo de la sesion; el panel no puede escribir otro.
CREATE OR REPLACE FUNCTION public.fn_registrar_acceso(p_evento TEXT, p_agente TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF public.fn_mi_email() = '' THEN
        RAISE EXCEPTION 'Sin sesion.';
    END IF;
    INSERT INTO public.accesos (email, evento, agente)
    VALUES (public.fn_mi_email(), p_evento, left(p_agente, 300));
END;
$$;

-- Mi cuenta: cada quien cambia su nombre y sus correos, nada mas (ni rol, ni
-- menus, ni estado).
CREATE OR REPLACE FUNCTION public.fn_actualizar_mi_cuenta(
    p_nombre TEXT,
    p_recibe_alertas BOOLEAN,
    p_recibe_resumen BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.fn_usuario_activo() THEN
        RAISE EXCEPTION 'Tu usuario no esta activo.';
    END IF;
    IF coalesce(trim(p_nombre), '') = '' THEN
        RAISE EXCEPTION 'El nombre no puede quedar vacio.';
    END IF;
    UPDATE public.usuarios
    SET nombre = trim(p_nombre),
        recibe_alertas_inmediatas = coalesce(p_recibe_alertas, recibe_alertas_inmediatas),
        recibe_resumen_diario = coalesce(p_recibe_resumen, recibe_resumen_diario)
    WHERE lower(email) = public.fn_mi_email();
END;
$$;

-- Eliminar de verdad: la fila de usuarios y la cuenta de acceso. Solo un
-- administrador, y nunca a si mismo.
CREATE OR REPLACE FUNCTION public.fn_eliminar_usuario(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT := lower(trim(p_email));
BEGIN
    IF NOT public.fn_es_admin() THEN
        RAISE EXCEPTION 'Solo un administrador puede eliminar usuarios.';
    END IF;
    IF v_email = public.fn_mi_email() THEN
        RAISE EXCEPTION 'No puedes eliminar tu propio usuario.';
    END IF;
    DELETE FROM public.usuarios WHERE lower(email) = v_email;
    DELETE FROM auth.users WHERE lower(email) = v_email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_registrar_acceso(TEXT, TEXT) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_actualizar_mi_cuenta(TEXT, BOOLEAN, BOOLEAN) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_eliminar_usuario(TEXT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_registrar_acceso(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_actualizar_mi_cuenta(TEXT, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminar_usuario(TEXT) TO authenticated;

-- COMPROBACION: usuarios con RLS y sin permisos publicos; tu fila de
-- administrador.
SELECT c.relname AS tabla,
       c.relrowsecurity AS rls_activo,
       has_table_privilege('anon', c.oid, 'SELECT') AS publico_puede_leer,
       has_table_privilege('anon', c.oid, 'UPDATE') AS publico_puede_cambiar,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS politicas
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('usuarios', 'accesos');
