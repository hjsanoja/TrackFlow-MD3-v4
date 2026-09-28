-- ============================================================================
-- TRACKFLOW - FASE 41: PERMISOS DE USUARIOS
-- ============================================================================
-- 1. Solo un administrador puede BORRAR datos. Los usuarios de consulta
--    pueden crear y editar, pero todo DELETE que no sea de un administrador
--    lo rechaza la base de datos (no solo el panel). Excepcion:
--    producto_principios, que al editar un producto se borra y se vuelve a
--    guardar.
-- 2. usuarios gana:
--      menus_solo_lectura  menus que ese usuario ve pero no edita
--      debe_cambiar_clave  al entrar tiene que poner una contrasena propia
--      vence_el            fecha hasta la que tiene acceso (vacio = siempre)
--      alcance             que productos ve: {"laboratorios": [...],
--                          "unidades_negocio": [...], "categorias": [...]}
-- 3. Un acceso vencido cuenta como inactivo (fn_usuario_activo y fn_es_admin).
-- 4. fn_admin_cambiar_clave: el administrador pone una contrasena nueva a
--    alguien (sin correo); esa persona tendra que cambiarla al entrar.
-- 5. Al crear un usuario (fn_crear_usuario) queda con debe_cambiar_clave; al
--    cambiar su contrasena (fn_registrar_acceso 'clave_cambiada') se quita.
--
-- ORDEN: despues de fase40. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. COLUMNAS NUEVAS
-- ----------------------------------------------------------------------------
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS menus_solo_lectura TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS debe_cambiar_clave BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS vence_el DATE;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS alcance JSONB;

-- ----------------------------------------------------------------------------
-- 2. ACCESO VENCIDO = INACTIVO
-- ----------------------------------------------------------------------------
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
          AND (u.vence_el IS NULL OR u.vence_el >= (now() AT TIME ZONE 'America/Caracas')::date)
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
          AND (u.vence_el IS NULL OR u.vence_el >= (now() AT TIME ZONE 'America/Caracas')::date)
    );
$$;

-- ----------------------------------------------------------------------------
-- 3. BORRAR: SOLO ADMINISTRADORES
-- ----------------------------------------------------------------------------
-- Cada politica de borrado pasa a exigir administrador. Una politica "ALL"
-- (todas las operaciones) se separa en leer / crear / cambiar (igual que
-- antes) y borrar (solo administrador).
DO $$
DECLARE
    p RECORD;
    base TEXT;
    usar TEXT;
    chequear TEXT;
    borrado INT := 0;
    separadas INT := 0;
BEGIN
    FOR p IN
        SELECT tablename, policyname, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename NOT IN ('usuarios', 'accesos', 'producto_principios')
          AND cmd IN ('DELETE', 'ALL')
          AND (roles && ARRAY['authenticated', 'public']::name[])
    LOOP
        IF p.cmd = 'DELETE' THEN
            EXECUTE format('ALTER POLICY %I ON public.%I TO authenticated USING ((SELECT public.fn_es_admin()))',
                           p.policyname, p.tablename);
            borrado := borrado + 1;
        ELSE
            base := left(p.policyname, 50);
            usar := coalesce(p.qual, 'true');
            chequear := coalesce(p.with_check, p.qual, 'true');
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', base || '_leer', p.tablename);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', base || '_crear', p.tablename);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', base || '_cambiar', p.tablename);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', base || '_borrar', p.tablename);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', base || '_leer', p.tablename, usar);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', base || '_crear', p.tablename, chequear);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', base || '_cambiar', p.tablename, usar, chequear);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT public.fn_es_admin()))', base || '_borrar', p.tablename);
            EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
            separadas := separadas + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'Politicas de borrado que ahora exigen administrador: %; politicas ALL separadas: %', borrado, separadas;
END $$;

-- ----------------------------------------------------------------------------
-- 4. EL ADMINISTRADOR PONE UNA CONTRASENA NUEVA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_admin_cambiar_clave(p_email TEXT, p_password TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_email TEXT := lower(trim(p_email));
BEGIN
    IF NOT coalesce(public.fn_es_admin(), false) THEN
        RAISE EXCEPTION 'Solo un administrador puede cambiar contraseñas de otros.';
    END IF;
    IF v_email = public.fn_mi_email() THEN
        RAISE EXCEPTION 'Tu propia contraseña cámbiala en «Mi cuenta».';
    END IF;
    IF length(coalesce(p_password, '')) < 8 THEN
        RAISE EXCEPTION 'La contraseña debe tener al menos 8 caracteres.';
    END IF;
    UPDATE auth.users
    SET encrypted_password = crypt(p_password, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
    WHERE lower(email) = v_email;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ese usuario no tiene cuenta de acceso.';
    END IF;
    UPDATE public.usuarios SET debe_cambiar_clave = TRUE WHERE lower(email) = v_email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_admin_cambiar_clave(TEXT, TEXT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_admin_cambiar_clave(TEXT, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. CAMBIAR LA CONTRASENA QUITA LA OBLIGACION
-- ----------------------------------------------------------------------------
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
    IF p_evento = 'clave_cambiada' THEN
        UPDATE public.usuarios SET debe_cambiar_clave = FALSE WHERE lower(email) = public.fn_mi_email();
    END IF;
END;
$$;

-- Un usuario nuevo entra con la contrasena que le dio el administrador y la
-- cambia la primera vez.
CREATE OR REPLACE FUNCTION public.fn_marcar_cambio_clave()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.debe_cambiar_clave := TRUE;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_usuario_nuevo_cambia_clave ON public.usuarios;
CREATE TRIGGER trg_usuario_nuevo_cambia_clave
BEFORE INSERT ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION public.fn_marcar_cambio_clave();

-- ----------------------------------------------------------------------------
-- COMPROBACION: politicas de borrado por tabla (deben decir fn_es_admin)
-- ----------------------------------------------------------------------------
/*
SELECT tablename, policyname, cmd, qual FROM pg_policies
WHERE schemaname = 'public' AND cmd IN ('DELETE', 'ALL') ORDER BY tablename;
*/
