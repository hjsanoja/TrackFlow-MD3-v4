-- ============================================================================
-- TRACKFLOW - FASE 47: HISTORIAL DE DECISIONES DE REVISION
-- ============================================================================
-- Quien marco cada captura como valida o erronea (o la devolvio a pendientes)
-- y cuando. Lo anota la base sola, con un trigger, cada vez que el panel
-- cambia revisado_manual (o sospechoso de una captura ya revisada): sirve
-- para Revision de capturas, Precios repetidos y "Deshacer".
-- La sensibilidad (fn_probar_sensibilidad) marca capturas sin revisar: eso no
-- es una decision de una persona y no se anota.
--
-- No cambia datos. ORDEN: despues de fase46. Es idempotente.
-- ============================================================================

SET search_path = public;

CREATE TABLE IF NOT EXISTS public.revision_historial (
    id             BIGSERIAL PRIMARY KEY,
    captura_id     BIGINT NOT NULL REFERENCES public.fact_precios(id) ON DELETE CASCADE,
    publicacion_id BIGINT,
    accion         TEXT NOT NULL CHECK (accion IN ('valida', 'erronea', 'pendiente')),
    motivo         TEXT,
    usuario        TEXT,
    fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revision_historial_captura ON public.revision_historial (captura_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_revision_historial_fecha ON public.revision_historial (fecha DESC);

-- Solo se lee desde el panel; escribe el trigger.
ALTER TABLE public.revision_historial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revision_historial_leer ON public.revision_historial;
CREATE POLICY revision_historial_leer ON public.revision_historial FOR SELECT TO authenticated USING ((SELECT public.fn_usuario_activo()));
GRANT SELECT ON public.revision_historial TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_anotar_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.revisado_manual IS DISTINCT FROM OLD.revisado_manual
       OR (NEW.revisado_manual AND NEW.sospechoso IS DISTINCT FROM OLD.sospechoso) THEN
        INSERT INTO public.revision_historial (captura_id, publicacion_id, accion, motivo, usuario)
        VALUES (NEW.id, NEW.publicacion_id,
                CASE WHEN NOT NEW.revisado_manual THEN 'pendiente'
                     WHEN NEW.sospechoso THEN 'erronea'
                     ELSE 'valida' END,
                NEW.motivo_sospecha,
                NULLIF(public.fn_mi_email(), ''));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_anotar_revision ON public.fact_precios;
CREATE TRIGGER trg_anotar_revision
AFTER UPDATE OF revisado_manual, sospechoso ON public.fact_precios
FOR EACH ROW
EXECUTE FUNCTION public.fn_anotar_revision();

-- Con nombre y cadena, para la lista "Historial" del panel.
CREATE OR REPLACE VIEW public.v_revision_historial
WITH (security_invoker = true)
AS
SELECT h.id, h.captura_id, h.publicacion_id, h.accion, h.motivo, h.usuario, h.fecha,
       COALESCE(u.nombre, h.usuario) AS usuario_nombre,
       pub.cadena_id, pub.url,
       p.nombre AS producto_nombre, lab.nombre AS laboratorio, lab.es_propio,
       COALESCE(pp.id_interno, p.id_interno) AS id_producto_propio,
       COALESCE(pp.nombre, p.nombre) AS producto_propio_nombre,
       fp.fecha_captura, COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_bs, fp.nombre_capturado
FROM public.revision_historial h
JOIN public.fact_precios fp       ON fp.id = h.captura_id
JOIN public.publicaciones pub     ON pub.id = fp.publicacion_id
JOIN public.dim_productos p       ON p.id = pub.producto_id
JOIN public.dim_laboratorios lab  ON lab.id = p.laboratorio_id
LEFT JOIN public.producto_equivalencias pe ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN public.dim_productos pp ON pp.id = pe.producto_propio_id
LEFT JOIN public.usuarios u       ON lower(u.email) = h.usuario;

GRANT SELECT ON public.v_revision_historial TO authenticated;

-- COMPROBACION
/*
SELECT accion, count(*) FROM revision_historial GROUP BY 1;
*/
