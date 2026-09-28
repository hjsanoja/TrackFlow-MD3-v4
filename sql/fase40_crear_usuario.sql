-- ============================================================================
-- TRACKFLOW - FASE 40: CREAR USUARIOS DESDE EL PANEL SIN EDGE FUNCTION
-- ============================================================================
-- "Nuevo usuario" llamaba a la Edge Function crear-usuario, que hay que
-- desplegar aparte en Supabase; sin ella el panel da "Failed to send a
-- request to the Edge Function".
--
-- fn_crear_usuario hace lo mismo desde la base de datos, como ya lo hace
-- fn_eliminar_usuario (fase 25): solo un administrador activo puede usarla.
-- Crea la cuenta de acceso (correo confirmado, contrasena cifrada) y la fila
-- en usuarios, todo o nada. Si la cuenta de acceso ya existia sin fila en
-- usuarios (un intento anterior a medias), le pone la contrasena nueva y
-- crea la fila.
--
-- No cambia datos. ORDEN: despues de fase39 (necesita la fase 25). Idempotente.
-- ============================================================================

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

    -- 2. Perfil en usuarios. jsonb_populate_record adapta los valores a los
    -- tipos reales de la tabla (menus como lista, activo como si/no...).
    INSERT INTO public.usuarios (id, email, nombre, rol, menus_permitidos,
                                 recibe_alertas_inmediatas, recibe_resumen_diario, activo)
    SELECT r.id, r.email, r.nombre, r.rol, r.menus_permitidos,
           r.recibe_alertas_inmediatas, r.recibe_resumen_diario, r.activo
    FROM jsonb_populate_record(NULL::public.usuarios, jsonb_build_object(
        'id', replace(replace(v_email, '@', '_at_'), '.', '_'),
        'email', v_email,
        'nombre', trim(coalesce(p_nombre, '')),
        'rol', v_rol,
        'menus_permitidos', to_jsonb(coalesce(p_menus, ARRAY['/', '/mapa-calor'])),
        'recibe_alertas_inmediatas', coalesce(p_recibe_alertas, false),
        'recibe_resumen_diario', coalesce(p_recibe_resumen, false),
        'activo', coalesce(p_activo, true)
    )) r;

    RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_crear_usuario(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, BOOLEAN) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_crear_usuario(TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated;

-- COMPROBACION (debe devolver una fila)
/*
SELECT proname FROM pg_proc WHERE proname = 'fn_crear_usuario';
*/
