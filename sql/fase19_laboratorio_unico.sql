-- ============================================================================
-- TRACKFLOW - FASE 19: UN SOLO LABORATORIO PROPIO, "LA SANTE"
-- ============================================================================
-- La Sante es el unico fabricante propio. Pharmetique y "La Sante" (la de
-- genericos) son UNIDADES DE NEGOCIO dentro de el, no laboratorios. En la base
-- habia productos propios colgados de "PHARMETIQUELABS", de "BIOQU?MUICA"
-- (nombre danado) e incluso de "CALOX".
--
-- Esta fase:
--   1. deja un unico laboratorio "LA SANTE", sin acento y marcado como propio,
--   2. cuelga de el TODOS los productos propios (los que no empiezan por COMP_),
--   3. borra "PHARMETIQUE...", "BIOQU..." y los duplicados de "LA SANTE"
--      cuando ya nadie los usa.
--
-- Los productos de la competencia (COMP_) no se tocan: sus laboratorios
-- (Calox, Genven...) son los de verdad. Si alguno de los laboratorios a borrar
-- lo usa un producto de la competencia, se conserva y se avisa.
--
-- No toca la unidad de negocio ni el tipo de mercado de ningun producto.
-- Idempotente: se puede correr mas de una vez.
-- ============================================================================

-- VISTA PREVIA (opcional, correr antes): que productos propios cambian.
/*
SELECT p.id_interno, p.nombre, l.nombre AS laboratorio_actual
FROM dim_productos p JOIN dim_laboratorios l ON l.id = p.laboratorio_id
WHERE p.id_interno NOT LIKE 'COMP\_%'
  AND UPPER(TRANSLATE(l.nombre, 'ÉéÁáÍíÓóÚú', 'EeAaIiOoUu')) <> 'LA SANTE'
ORDER BY 1;
*/

DO $$
DECLARE
    v_la_sante BIGINT;
    v_movidos  INT;
    v_borrados INT;
    r          RECORD;
BEGIN
    -- 1. El laboratorio que se queda: el "LA SANTE" mas antiguo, con o sin
    --    acento y en cualquier combinacion de mayusculas.
    SELECT id INTO v_la_sante
    FROM public.dim_laboratorios
    WHERE UPPER(TRANSLATE(nombre, 'ÉéÁáÍíÓóÚú', 'EeAaIiOoUu')) = 'LA SANTE'
    ORDER BY id
    LIMIT 1;

    IF v_la_sante IS NULL THEN
        INSERT INTO public.dim_laboratorios (nombre, es_propio)
        VALUES ('LA SANTE', TRUE)
        RETURNING id INTO v_la_sante;
    END IF;

    -- Candidatos a desaparecer.
    CREATE TEMP TABLE tmp_labs_a_unificar ON COMMIT DROP AS
    SELECT id, nombre
    FROM public.dim_laboratorios
    WHERE id <> v_la_sante
      AND (UPPER(TRANSLATE(nombre, 'ÉéÁáÍíÓóÚú', 'EeAaIiOoUu')) = 'LA SANTE'
           OR UPPER(nombre) LIKE 'PHARMETIQUE%'
           OR UPPER(nombre) LIKE 'BIOQU%');

    -- 2. Sus marcas pasan a La Sante (son marcas propias).
    UPDATE public.dim_marcas
    SET laboratorio_id = v_la_sante
    WHERE laboratorio_id IN (SELECT id FROM tmp_labs_a_unificar);

    -- 3. Todos los productos propios a La Sante. Si alguno tenia una marca de
    --    otro laboratorio (el trigger fn_validar_laboratorio_marca lo
    --    impediria), se le quita la marca: hoy el panel no las usa.
    UPDATE public.dim_productos p
    SET laboratorio_id = v_la_sante,
        marca_id = CASE
            WHEN p.marca_id IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM public.dim_marcas m
                         WHERE m.id = p.marca_id AND m.laboratorio_id = v_la_sante)
                THEN p.marca_id
            ELSE NULL
        END
    WHERE p.id_interno NOT LIKE 'COMP\_%'
      AND p.laboratorio_id <> v_la_sante;
    GET DIAGNOSTICS v_movidos = ROW_COUNT;

    -- 4. Nombre y marca de propio del que se queda.
    UPDATE public.dim_laboratorios
    SET nombre = 'LA SANTE', es_propio = TRUE
    WHERE id = v_la_sante;

    -- 5. Borrar los que ya nadie usa.
    DELETE FROM public.dim_laboratorios l
    WHERE l.id IN (SELECT id FROM tmp_labs_a_unificar)
      AND NOT EXISTS (SELECT 1 FROM public.dim_productos p WHERE p.laboratorio_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM public.dim_marcas m WHERE m.laboratorio_id = l.id);
    GET DIAGNOSTICS v_borrados = ROW_COUNT;

    RAISE NOTICE 'Productos propios pasados a LA SANTE: %. Laboratorios borrados: %.', v_movidos, v_borrados;

    FOR r IN
        SELECT t.nombre, count(p.id) AS productos
        FROM tmp_labs_a_unificar t
        JOIN public.dim_productos p ON p.laboratorio_id = t.id
        GROUP BY t.nombre
    LOOP
        RAISE NOTICE 'Se conserva "%" porque lo usan % productos de la competencia.', r.nombre, r.productos;
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- COMPROBACION: los productos propios deben salir todos con LA SANTE.
-- ----------------------------------------------------------------------------
SELECT l.nombre AS laboratorio, l.es_propio, count(*) AS productos_propios
FROM public.dim_productos p
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
WHERE p.id_interno NOT LIKE 'COMP\_%'
GROUP BY l.nombre, l.es_propio
ORDER BY 3 DESC;
