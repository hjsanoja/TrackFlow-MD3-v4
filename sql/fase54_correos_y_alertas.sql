-- ============================================================================
-- FASE 54: correos (Brevo) y alertas a la medida
-- ----------------------------------------------------------------------------
-- 1. alertas_usuario: reglas que cada usuario crea en Mi cuenta, p. ej.
--    «avisame si Genven baja mas de 5 % en Farmatodo». Cada quien ve y
--    cambia solo las suyas; no se borran (se pausan), como el resto del panel.
-- 2. alertas_enviadas: que regla ya aviso de que enlace y que dia, para no
--    repetir el mismo correo. Solo la escribe el robot (service role).
-- 3. correos_enviados: bitacora de cada correo (ok o error). La leen los
--    administradores.
-- El envio lo hace scraper/correos.py (GitHub Actions) con la clave de Brevo.
-- usuarios.recibe_resumen_diario pasa a significar «resumen semanal».
--
-- ORDEN: despues de fase53. Es idempotente.
-- ============================================================================

SET search_path = public;

-- ----------------------------------------------------------------------------
-- 1. Alertas de cada usuario
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_usuario (
    id           BIGSERIAL PRIMARY KEY,
    email        TEXT NOT NULL DEFAULT public.fn_mi_email(),
    tipo         TEXT NOT NULL CHECK (tipo IN ('baja', 'sube', 'mas_barato')),
    umbral       NUMERIC(5, 2) NOT NULL DEFAULT 5 CHECK (umbral > 0 AND umbral <= 100),
    producto_id  TEXT,           -- id_interno de tu producto; vacio = todos
    cadena_id    TEXT,           -- vacio = todas las cadenas
    laboratorio  TEXT,           -- laboratorio competidor; vacio = cualquiera
    activa       BOOLEAN NOT NULL DEFAULT TRUE,
    creado       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alertas_usuario_email ON public.alertas_usuario (lower(email));

ALTER TABLE public.alertas_usuario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alertas_usuario_leer ON public.alertas_usuario;
DROP POLICY IF EXISTS alertas_usuario_crear ON public.alertas_usuario;
DROP POLICY IF EXISTS alertas_usuario_cambiar ON public.alertas_usuario;
CREATE POLICY alertas_usuario_leer ON public.alertas_usuario FOR SELECT TO authenticated
    USING (lower(email) = (SELECT public.fn_mi_email()) OR (SELECT public.fn_es_admin()));
CREATE POLICY alertas_usuario_crear ON public.alertas_usuario FOR INSERT TO authenticated
    WITH CHECK (lower(email) = (SELECT public.fn_mi_email()) AND (SELECT public.fn_usuario_activo()));
CREATE POLICY alertas_usuario_cambiar ON public.alertas_usuario FOR UPDATE TO authenticated
    USING (lower(email) = (SELECT public.fn_mi_email()))
    WITH CHECK (lower(email) = (SELECT public.fn_mi_email()));
GRANT SELECT, INSERT, UPDATE ON public.alertas_usuario TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.alertas_usuario_id_seq TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Lo que ya se aviso (solo el robot)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_enviadas (
    alerta_id      BIGINT NOT NULL REFERENCES public.alertas_usuario(id) ON DELETE CASCADE,
    publicacion_id BIGINT NOT NULL,
    fecha          DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Caracas')::date,
    PRIMARY KEY (alerta_id, publicacion_id, fecha)
);
ALTER TABLE public.alertas_enviadas ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Bitacora de correos
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.correos_enviados (
    id       BIGSERIAL PRIMARY KEY,
    email    TEXT NOT NULL,
    tipo     TEXT NOT NULL,     -- alertas | resumen
    asunto   TEXT,
    ok       BOOLEAN NOT NULL,
    detalle  TEXT,
    enviado  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.correos_enviados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS correos_enviados_leer ON public.correos_enviados;
CREATE POLICY correos_enviados_leer ON public.correos_enviados FOR SELECT TO authenticated
    USING ((SELECT public.fn_es_admin()) OR lower(email) = (SELECT public.fn_mi_email()));
GRANT SELECT ON public.correos_enviados TO authenticated;

DO $$
BEGIN
    COMMENT ON COLUMN public.usuarios.recibe_resumen_diario IS 'Recibe el resumen SEMANAL por correo (lunes en la manana).';
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- VERIFICACION (opcional)
-- ----------------------------------------------------------------------------
-- SELECT * FROM alertas_usuario ORDER BY creado DESC;
-- SELECT * FROM correos_enviados ORDER BY enviado DESC LIMIT 20;
