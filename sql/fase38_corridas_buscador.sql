-- ============================================================================
-- TRACKFLOW - FASE 38: EL PANEL PUEDE CERRAR UNA BUSQUEDA CANCELADA
-- ============================================================================
-- Si la busqueda de enlaces se cancela en GitHub (o se corta), su fila en
-- corridas_buscador se quedaba "corriendo" y el panel seguia mostrando la
-- barra. Ahora el panel la cierra (cancelada / interrumpida) al detectarlo o
-- al pulsar "Detener". Solo puede cambiar el estado y la hora de fin.
--
-- No cambia datos. ORDEN DE EJECUCION: despues de fase37. Es idempotente.
-- ============================================================================

GRANT UPDATE (estado, fin) ON public.corridas_buscador TO authenticated;

DROP POLICY IF EXISTS "auth_update_corridas_buscador" ON public.corridas_buscador;
CREATE POLICY "auth_update_corridas_buscador" ON public.corridas_buscador
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- La que hoy quedo colgada (cancelada en GitHub): se cierra.
UPDATE public.corridas_buscador
SET estado = 'interrumpida', fin = NOW()
WHERE estado = 'corriendo' AND inicio < NOW() - INTERVAL '3 hours';
