-- ============================================================================
-- TRACKFLOW - FASE 10: CIERRE DE LA ESTANDARIZACION DE NOMBRES
-- ============================================================================
-- Cierra las tres desviaciones que quedaban respecto de las reglas de
-- DICCIONARIO_CAMPOS.md.
--
--   1. dim_cadenas.scraper_modulo -> modulo_scraper
--      Regla 4 (sustantivo primero, calificador despues): es el modulo DEL
--      scraper, igual que unidad_contenido o tipo_equivalencia. La Fase 8 lo
--      habia dejado al reves por una decision de coste, eligiendo el nombre
--      que ya usaban la mayoria de los consumidores. Ahora se corrige la
--      columna y se alinean los 22 consumidores.
--
--   2. scrape_runs.trigger_tipo -> tipo_trigger
--      Misma regla 4.
--
--   3. audit_log.fecha -> created_at
--      Regla 6 (las marcas de tiempo de evento terminan en _at). El resto del
--      esquema ya usa created_at para lo mismo.
--
-- ORDEN DE EJECUCION: despues de fase9_enlaces_sin_precio.sql. Es idempotente.
--
-- IMPORTANTE ANTES DE EJECUTAR
--   1. Deten el workflow "Scraper diario" si esta corriendo: push_to_supabase.py
--      escribe trigger_tipo en cada corrida.
--   2. Despliega el codigo de la rama que acompaña a este script. Base y codigo
--      deben ir juntos.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. dim_cadenas.scraper_modulo -> modulo_scraper
-- ----------------------------------------------------------------------------
-- OJO CON LA VISTA 'cadenas': al renombrar una columna, Postgres actualiza la
-- referencia interna de las vistas que dependen de ella, pero NO cambia el
-- nombre de la columna que la vista expone. La vista seguiria publicando
-- 'scraper_modulo' mientras la tabla ya diria 'modulo_scraper'. Por eso hay
-- que recrearla explicitamente, cosa que la Fase 8 no necesito.
DO $cadenas$
DECLARE
    v_es_vista BOOLEAN;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_cadenas'
          AND column_name = 'scraper_modulo'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_cadenas'
          AND column_name = 'modulo_scraper'
    ) THEN
        SELECT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'cadenas' AND c.relkind = 'v'
        ) INTO v_es_vista;

        IF v_es_vista THEN
            DROP VIEW public.cadenas;
        END IF;

        ALTER TABLE public.dim_cadenas RENAME COLUMN scraper_modulo TO modulo_scraper;

        IF v_es_vista THEN
            CREATE VIEW public.cadenas AS
            SELECT
                id,
                nombre,
                website,
                modulo_scraper,
                activo
            FROM public.dim_cadenas;
        END IF;

        RAISE NOTICE 'dim_cadenas.scraper_modulo renombrada a modulo_scraper (y vista cadenas recreada).';
    ELSE
        RAISE NOTICE 'dim_cadenas.modulo_scraper ya existe: nada que renombrar.';
    END IF;
END
$cadenas$;

-- ----------------------------------------------------------------------------
-- 1b. REPARAR LA VISTA 'cadenas' SI QUEDO DESALINEADA
-- ----------------------------------------------------------------------------
-- Caso aparte del anterior: si la columna ya se llama modulo_scraper pero la
-- vista sigue publicando 'scraper_modulo', el bloque 1 no entra (no hay nada
-- que renombrar) y la vista queda con el nombre viejo. Pasa en bases que
-- ejecutaron la Fase 5 original, que creaba la vista con
-- 'modulo_scraper AS scraper_modulo', y que nunca corrieron la Fase 8.
DO $vista_cadenas$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_cadenas'
          AND column_name = 'modulo_scraper'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cadenas'
          AND column_name = 'scraper_modulo'
    ) THEN
        DROP VIEW public.cadenas;

        CREATE VIEW public.cadenas AS
        SELECT
            id,
            nombre,
            website,
            modulo_scraper,
            activo
        FROM public.dim_cadenas;

        RAISE NOTICE 'Vista cadenas realineada: ahora publica modulo_scraper.';
    END IF;
END
$vista_cadenas$;

-- ----------------------------------------------------------------------------
-- 2. scrape_runs.trigger_tipo -> tipo_trigger
-- ----------------------------------------------------------------------------
-- La restriccion CHECK se renombra sola junto con la columna.
DO $runs$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scrape_runs'
          AND column_name = 'trigger_tipo'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scrape_runs'
          AND column_name = 'tipo_trigger'
    ) THEN
        ALTER TABLE public.scrape_runs RENAME COLUMN trigger_tipo TO tipo_trigger;
        RAISE NOTICE 'scrape_runs.trigger_tipo renombrada a tipo_trigger.';
    ELSE
        RAISE NOTICE 'scrape_runs.tipo_trigger ya existe: nada que renombrar.';
    END IF;
END
$runs$;

-- ----------------------------------------------------------------------------
-- 3. audit_log.fecha -> created_at
-- ----------------------------------------------------------------------------
-- fn_audit_log_trigger() no nombra esta columna (se apoya en su DEFAULT NOW()),
-- asi que el renombrado no la afecta.
DO $audit$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_log'
          AND column_name = 'fecha'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_log'
          AND column_name = 'created_at'
    ) THEN
        ALTER TABLE public.audit_log RENAME COLUMN fecha TO created_at;
        RAISE NOTICE 'audit_log.fecha renombrada a created_at.';
    ELSE
        RAISE NOTICE 'audit_log.created_at ya existe: nada que renombrar.';
    END IF;
END
$audit$;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Las tres columnas quedaron con el nombre nuevo y ninguna con el viejo
/*
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN ('modulo_scraper','scraper_modulo',
                      'tipo_trigger','trigger_tipo',
                      'created_at','fecha')
  AND table_name IN ('dim_cadenas','scrape_runs','audit_log')
ORDER BY table_name, column_name;
*/

-- V2. La vista de compatibilidad 'cadenas' expone el nombre nuevo
/*
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'cadenas'
ORDER BY ordinal_position;
*/

-- V3. Los modulos de scraping siguen asignados tras el renombrado
/*
SELECT id, nombre, modulo_scraper FROM dim_cadenas ORDER BY nombre;
*/
