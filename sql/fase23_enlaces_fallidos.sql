-- ============================================================================
-- FASE 23: enlaces que el robot no logra leer
-- ============================================================================
-- Cada corrida del robot guarda una fila en fact_precios por enlace, tambien
-- cuando falla (estado <> 'ok'). Esta vista cuenta, por enlace, cuantas
-- lecturas seguidas fallaron desde la ultima buena. El panel marca "Revisar
-- URL" a partir de 3: casi siempre la tienda cambio o quito la pagina.
--
-- Solo crea una vista de lectura; no cambia datos. Se puede correr mas de
-- una vez.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_enlaces_fallidos
WITH (security_invoker = true)
AS
WITH capturas AS (
    SELECT
        f.publicacion_id,
        f.fecha_captura,
        f.estado,
        f.error_mensaje,
        ROW_NUMBER() OVER (PARTITION BY f.publicacion_id
                           ORDER BY f.fecha_captura DESC, f.id DESC) AS n
    FROM public.fact_precios f
    -- Con 90 dias sobra para contar fallos seguidos y no se recorre toda la
    -- historia.
    WHERE f.fecha_captura > NOW() - INTERVAL '90 days'
),
ultima_buena AS (
    SELECT publicacion_id, MIN(n) AS n
    FROM capturas
    WHERE estado = 'ok'
    GROUP BY publicacion_id
)
SELECT
    c.publicacion_id,
    COUNT(*)::int AS fallos_seguidos,
    MAX(c.fecha_captura) AS ultima_falla,
    (ARRAY_AGG(c.error_mensaje ORDER BY c.n))[1] AS ultimo_error
FROM capturas c
LEFT JOIN ultima_buena b ON b.publicacion_id = c.publicacion_id
WHERE c.estado <> 'ok'
  AND c.n < COALESCE(b.n, 2147483647)
GROUP BY c.publicacion_id;

GRANT SELECT ON public.v_enlaces_fallidos TO authenticated;

-- COMPROBACION: cuantos enlaces llevan 3 o mas fallos seguidos.
SELECT COUNT(*) AS enlaces_para_revisar
FROM public.v_enlaces_fallidos
WHERE fallos_seguidos >= 3;
