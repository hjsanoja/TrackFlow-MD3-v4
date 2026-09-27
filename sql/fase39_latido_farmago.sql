-- ============================================================================
-- TRACKFLOW - FASE 39: SENAL DE VIDA DEL BUSCADOR Y WEB DE FARMAGO
-- ============================================================================
-- 1. corridas_buscador.latido: el robot lo actualiza cada 30 s. Si deja de
--    latir (cancelado en GitHub, maquina caida), el panel cierra la corrida
--    a los pocos minutos. Y "Detener" en el panel marca la corrida como
--    cancelada: el robot lo ve en su siguiente latido y se detiene solo (no
--    hace falta permiso de Actions en el token de GitHub).
-- 2. Se cierran las corridas que quedaron "corriendo" sin latido (de antes).
-- 3. FarmaGo: su web es https://www.farmago.com.ve (estaba farmago.com); se
--    borra la plataforma detectada para que el robot la vuelva a revisar.
--
-- No cambia enlaces ni precios. ORDEN: despues de fase38. Es idempotente.
-- ============================================================================

ALTER TABLE public.corridas_buscador ADD COLUMN IF NOT EXISTS latido TIMESTAMPTZ;

UPDATE public.corridas_buscador
SET estado = 'interrumpida', fin = NOW()
WHERE estado = 'corriendo' AND latido IS NULL;

UPDATE public.dim_cadenas
SET website = 'https://www.farmago.com.ve',
    plataforma = NULL, plataforma_detalle = NULL, plataforma_revisada = NULL
WHERE (lower(id) LIKE '%farmago%' OR lower(nombre) LIKE '%farmago%')
  AND COALESCE(website, '') NOT ILIKE '%farmago.com.ve%';

-- COMPROBACION
/*
SELECT id, nombre, website, plataforma FROM dim_cadenas WHERE lower(nombre) LIKE '%farmago%';
SELECT id, estado, inicio, fin, latido FROM corridas_buscador ORDER BY id DESC LIMIT 3;
*/
