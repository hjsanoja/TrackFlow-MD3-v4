-- ============================================================================
-- TRACKFLOW - FASE 51: ACTIVIDAD, INVITADOS E HISTORIAL DE PERMISOS
-- ============================================================================
-- 1. Actividad por menu: el panel anota (una vez por menu y sesion) que menu
--    abrio cada persona. accesos acepta el evento 'menu' con su detalle (la
--    ruta). v_actividad_menus lo resume por persona y menu (30 dias).
-- 2. Perfiles con vencimiento: perfiles_usuario.vence_dias. Al aplicar un
--    perfil con dias, el usuario queda con "Acceso hasta" hoy + N. Se suma el
--    perfil "Invitado 30 dias".
-- 3. Historial de permisos (usuarios_bitacora): quien cambio el rol, los
--    menus, "solo ver", que productos ve, el vencimiento o el estado de cada
--    usuario, y cuando. Lo anota un trigger; solo lo leen los administradores.
--
-- ORDEN: despues de fase50. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Actividad por menu
-- ----------------------------------------------------------------------------
ALTER TABLE public.accesos ADD COLUMN IF NOT EXISTS detalle TEXT;
ALTER TABLE public.accesos DROP CONSTRAINT IF EXISTS accesos_evento_check;
ALTER TABLE public.accesos ADD CONSTRAINT accesos_evento_check
    CHECK (evento IN ('ingreso', 'salida', 'clave_cambiada', 'recuperacion', 'menu'));
CREATE INDEX IF NOT EXISTS ix_accesos_evento_fecha ON public.accesos (evento, fecha DESC);

-- Una sola version de la funcion (con detalle opcional): si quedaran dos,
-- PostgREST no sabria cual llamar.
DROP FUNCTION IF EXISTS public.fn_registrar_acceso(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.fn_registrar_acceso(p_evento TEXT, p_agente TEXT DEFAULT NULL, p_detalle TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF public.fn_mi_email() = '' THEN
        RAISE EXCEPTION 'Sin sesion.';
    END IF;
    INSERT INTO public.accesos (email, evento, agente, detalle)
    VALUES (public.fn_mi_email(), p_evento, left(p_agente, 300), left(p_detalle, 120));
    IF p_evento = 'clave_cambiada' THEN
        UPDATE public.usuarios SET debe_cambiar_clave = FALSE WHERE lower(email) = public.fn_mi_email();
    END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_registrar_acceso(TEXT, TEXT, TEXT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_registrar_acceso(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE VIEW public.v_actividad_menus
WITH (security_invoker = true)
AS
SELECT lower(email) AS email, detalle AS menu, COUNT(*) AS veces, MAX(fecha) AS ultima
FROM public.accesos
WHERE evento = 'menu' AND fecha > NOW() - INTERVAL '30 days' AND detalle IS NOT NULL
GROUP BY lower(email), detalle;
GRANT SELECT ON public.v_actividad_menus TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Perfiles con vencimiento
-- ----------------------------------------------------------------------------
ALTER TABLE public.perfiles_usuario ADD COLUMN IF NOT EXISTS vence_dias INT CHECK (vence_dias IS NULL OR vence_dias > 0);
INSERT INTO public.perfiles_usuario (nombre, rol, menus_permitidos, menus_solo_lectura, vence_dias)
VALUES ('Invitado 30 días', 'consulta', ARRAY['/', '/mapa-calor', '/mapa-cadenas'], ARRAY['/', '/mapa-calor', '/mapa-cadenas'], 30)
ON CONFLICT (nombre) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Historial de permisos
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usuarios_bitacora (
    id       BIGSERIAL PRIMARY KEY,
    email    TEXT NOT NULL,          -- a quien
    campo    TEXT NOT NULL,          -- que cambio
    antes    TEXT,
    despues  TEXT,
    quien    TEXT,                   -- quien lo cambio
    fecha    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_usuarios_bitacora_email ON public.usuarios_bitacora (lower(email), fecha DESC);
ALTER TABLE public.usuarios_bitacora ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usuarios_bitacora_leer ON public.usuarios_bitacora;
CREATE POLICY usuarios_bitacora_leer ON public.usuarios_bitacora FOR SELECT TO authenticated USING ((SELECT public.fn_es_admin()));
GRANT SELECT ON public.usuarios_bitacora TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_anotar_permisos()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_quien TEXT := NULLIF(public.fn_mi_email(), '');
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien)
        VALUES (NEW.email, 'creado', NULL, NEW.rol, v_quien);
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien)
        VALUES (OLD.email, 'eliminado', OLD.rol, NULL, v_quien);
        RETURN OLD;
    END IF;
    IF NEW.rol IS DISTINCT FROM OLD.rol THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien) VALUES (NEW.email, 'rol', OLD.rol, NEW.rol, v_quien);
    END IF;
    IF NEW.menus_permitidos IS DISTINCT FROM OLD.menus_permitidos THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien)
        VALUES (NEW.email, 'menus', array_to_string(OLD.menus_permitidos, ', '), array_to_string(NEW.menus_permitidos, ', '), v_quien);
    END IF;
    IF NEW.menus_solo_lectura IS DISTINCT FROM OLD.menus_solo_lectura THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien)
        VALUES (NEW.email, 'solo_ver', array_to_string(OLD.menus_solo_lectura, ', '), array_to_string(NEW.menus_solo_lectura, ', '), v_quien);
    END IF;
    IF NEW.alcance IS DISTINCT FROM OLD.alcance THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien) VALUES (NEW.email, 'alcance', OLD.alcance::text, NEW.alcance::text, v_quien);
    END IF;
    IF NEW.vence_el IS DISTINCT FROM OLD.vence_el THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien) VALUES (NEW.email, 'vence_el', OLD.vence_el::text, NEW.vence_el::text, v_quien);
    END IF;
    IF NEW.activo IS DISTINCT FROM OLD.activo THEN
        INSERT INTO usuarios_bitacora (email, campo, antes, despues, quien) VALUES (NEW.email, 'activo', OLD.activo::text, NEW.activo::text, v_quien);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_anotar_permisos ON public.usuarios;
CREATE TRIGGER trg_anotar_permisos
AFTER INSERT OR DELETE OR UPDATE OF rol, menus_permitidos, menus_solo_lectura, alcance, vence_el, activo ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION public.fn_anotar_permisos();

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT * FROM v_actividad_menus ORDER BY ultima DESC LIMIT 20;
-- SELECT * FROM usuarios_bitacora ORDER BY fecha DESC LIMIT 20;
