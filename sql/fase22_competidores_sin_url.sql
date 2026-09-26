-- ============================================================================
-- FASE 22: los competidores sin URL que la fase 21 no pudo borrar
-- ============================================================================
-- La fase 21 no borra un competidor (COMP_) que tenga PVP propio, por
-- prudencia. Resultado: quedaron 20 sin URL, todos con PVP. Ese PVP no es
-- real: lo puso la fase 2 de migracion (un PVP base de $1.00 para todo lo que
-- parecia producto propio por su laboratorio o unidad de negocio), y alcanzo
-- a competidores de Pharmetique y La Sante. Un competidor no tiene PVP
-- propio; el panel ya no se lo crea (el PVP solo se guarda desde Productos).
--
-- Esta fase:
--   1. Borra el PVP de TODOS los productos COMP_ (tengan URL o no).
--   2. Repite la limpieza de la fase 21: borra los COMP_ sin URL y sus
--      equivalencias.
--
-- No toca productos propios, publicaciones ni precios capturados. Se puede
-- correr mas de una vez.
-- ============================================================================

-- VISTA PREVIA (opcional): cuantos PVP de competidores hay y de cuanto son.
/*
SELECT pv.pvp_usd, COUNT(*) AS filas, COUNT(DISTINCT pv.producto_id) AS competidores
FROM pvp_propio pv
JOIN dim_productos p ON p.id = pv.producto_id
WHERE p.id_interno LIKE 'COMP\_%'
GROUP BY pv.pvp_usd
ORDER BY filas DESC;
*/

DO $$
DECLARE
    v_pvp INT;
    v_equivalencias INT;
    v_borrados INT;
BEGIN
    -- 1. PVP de competidores
    DELETE FROM public.pvp_propio pv
    USING public.dim_productos p
    WHERE p.id = pv.producto_id
      AND p.id_interno LIKE 'COMP\_%';
    GET DIAGNOSTICS v_pvp = ROW_COUNT;

    -- 2. Competidores sin URL (misma regla que la fase 21, ahora sin el PVP
    --    de por medio). Nunca uno que figure como producto propio de una
    --    equivalencia.
    CREATE TEMP TABLE tmp_huerfanos ON COMMIT DROP AS
    SELECT p.id
    FROM public.dim_productos p
    WHERE p.id_interno LIKE 'COMP\_%'
      AND NOT EXISTS (SELECT 1 FROM public.publicaciones pub WHERE pub.producto_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.pvp_propio pv WHERE pv.producto_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.producto_equivalencias e WHERE e.producto_propio_id = p.id);

    DELETE FROM public.producto_equivalencias
    WHERE producto_competidor_id IN (SELECT id FROM tmp_huerfanos);
    GET DIAGNOSTICS v_equivalencias = ROW_COUNT;

    -- producto_principios se borra solo (ON DELETE CASCADE).
    DELETE FROM public.dim_productos WHERE id IN (SELECT id FROM tmp_huerfanos);
    GET DIAGNOSTICS v_borrados = ROW_COUNT;

    RAISE NOTICE 'PVP de competidores borrados: %. Competidores sin URL borrados: %. Equivalencias suyas borradas: %.',
        v_pvp, v_borrados, v_equivalencias;
END $$;

-- COMPROBACION: las dos cifras deben dar 0.
SELECT
  (SELECT COUNT(*) FROM dim_productos p
    WHERE p.id_interno LIKE 'COMP\_%'
      AND NOT EXISTS (SELECT 1 FROM publicaciones pub WHERE pub.producto_id = p.id)) AS competidores_sin_url,
  (SELECT COUNT(*) FROM pvp_propio pv JOIN dim_productos p ON p.id = pv.producto_id
    WHERE p.id_interno LIKE 'COMP\_%') AS pvp_de_competidores;
