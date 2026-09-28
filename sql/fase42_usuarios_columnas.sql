-- ============================================================================
-- TRACKFLOW - FASE 42: TABLA USUARIOS COMPLETA Y CREAR USUARIOS SIN ERROR
-- ============================================================================
-- La tabla usuarios de este proyecto viene de la migracion de Firebase y no
-- tiene la columna menus_permitidos (ni quizas otras que el panel usa). Por
-- eso "Nuevo usuario" daba: column "menus_permitidos" of relation "usuarios"
-- does not exist, y los menus marcados a un usuario de consulta no se
-- guardaban.
--
-- 1. Agrega las columnas que el panel usa y falten (no toca las que existen).
-- 2. Los usuarios de consulta que no tenian menus quedan con los de siempre
--    (Dashboard y Mapa de Calor), que es lo que el panel ya les mostraba.
-- 3. fn_crear_usuario inserta solo en las columnas que existan.
--
-- ORDEN: despues de fase41. Es idempotente.
-- ============================================================================

ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS nombre TEXT;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS rol TEXT;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS menus_permitidos TEXT[];
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS recibe_alertas_inmediatas BOOLEAN DEFAULT FALSE;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS recibe_resumen_diario BOOLEAN DEFAULT FALSE;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE;

UPDATE public.usuarios
SET menus_permitidos = ARRAY['/', '/mapa-calor']
WHERE menus_permitidos IS NULL AND lower(coalesce(rol, '')) <> 'administrador';

CREATE OR REPLACE FUNCTION public.fn_crear_usuario(
    p_email TEXT,
    p_password TEXT,
    p_nombre TEXT,
    p_rol TEXT,
    p_menus TEXT[],
    p_recibe_alertas BOOLEAN DEFAULT FALSE,
    p_recibe_resumen BOOLEAN DEFAULT FALSE,
    p_activo BOOLEAN DEFAULT TRUE
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_email TEXT := lower(trim(p_email));
    v_rol TEXT := CASE WHEN p_rol = 'administrador' THEN 'administrador' ELSE 'consulta' END;
    v_id UUID;
    v_instancia UUID;
    v_doc TEXT := replace(replace(lower(trim(p_email)), '@', '_at_'), '.', '_');
    v_datos JSONB;
    v_columnas TEXT;
BEGIN
    IF NOT coalesce(public.fn_es_admin(), false) THEN
        RAISE EXCEPTION 'Solo un administrador activo puede crear usuarios.';
    END IF;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'El correo no es válido.';
    END IF;
    IF length(coalesce(p_password, '')) < 8 THEN
        RAISE EXCEPTION 'La contraseña debe tener al menos 8 caracteres.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.usuarios WHERE lower(email) = v_email) THEN
        RAISE EXCEPTION 'Ya existe un usuario con ese correo.';
    END IF;

    -- 1. Cuenta de acceso
    SELECT id INTO v_id FROM auth.users WHERE lower(email) = v_email;
    IF v_id IS NULL THEN
        v_id := gen_random_uuid();
        SELECT instance_id INTO v_instancia FROM auth.users LIMIT 1;
        INSERT INTO auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) VALUES (
            coalesce(v_instancia, '00000000-0000-0000-0000-000000000000'::uuid), v_id,
            'authenticated', 'authenticated', v_email, crypt(p_password, gen_salt('bf')), now(),
            '{"provider": "email", "providers": ["email"]}'::jsonb,
            jsonb_build_object('nombre', trim(coalesce(p_nombre, ''))), now(), now(),
            '', '', '', ''
        );
        INSERT INTO auth.identities (
            id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
        ) VALUES (
            gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
            'email', now(), now(), now()
        );
    ELSE
        UPDATE auth.users
        SET encrypted_password = crypt(p_password, gen_salt('bf')),
            email_confirmed_at = coalesce(email_confirmed_at, now()),
            updated_at = now()
        WHERE id = v_id;
    END IF;

    -- 2. Perfil en usuarios. Solo las columnas que la tabla tiene de verdad
    -- (la de este proyecto viene de la migracion de Firebase), y con
    -- jsonb_populate_record cada valor toma el tipo real de su columna.
    v_datos := jsonb_build_object(
        'id', v_doc,
        '_doc_id', v_doc,
        'email', v_email,
        'nombre', trim(coalesce(p_nombre, '')),
        'rol', v_rol,
        'menus_permitidos', to_jsonb(coalesce(p_menus, ARRAY['/', '/mapa-calor'])),
        'recibe_alertas_inmediatas', coalesce(p_recibe_alertas, false),
        'recibe_resumen_diario', coalesce(p_recibe_resumen, false),
        'activo', coalesce(p_activo, true)
    );
    SELECT string_agg(quote_ident(c.column_name), ', ')
    INTO v_columnas
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'usuarios'
      AND v_datos ? c.column_name;
    EXECUTE format('INSERT INTO public.usuarios (%s) SELECT %s FROM jsonb_populate_record(NULL::public.usuarios, $1)',
                   v_columnas, v_columnas)
    USING v_datos;

    RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_crear_usuario(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, BOOLEAN) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_crear_usuario(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;

-- COMPROBACION: columnas de usuarios
/*
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'usuarios' ORDER BY ordinal_position;
*/
