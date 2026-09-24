-- ============================================================================
-- TRACKFLOW - FASE 18: EL TIPO DE MERCADO (MARCA / GENERICO) SE GUARDA
-- ============================================================================
-- Hasta ahora no existia en la base: el panel lo calculaba al leer
-- ("Pharmetique" en la unidad de negocio o en el laboratorio = MARCA, todo lo
-- demas = GENERICO). Asi que no habia forma de marcar como MARCA un producto
-- de La Sante, y cargarlo por CSV no tenia efecto.
--
-- Esta fase crea la columna y la rellena con esa misma regla, de modo que en
-- pantalla no cambia nada hasta que se corrija producto por producto (en el
-- formulario o con la columna tipo_mercado del CSV).
--
-- Idempotente: se puede correr mas de una vez.
-- ============================================================================

ALTER TABLE public.dim_productos
    ADD COLUMN IF NOT EXISTS tipo_mercado VARCHAR(10);

-- Solo las filas sin valor: correrla otra vez no pisa lo corregido a mano.
UPDATE public.dim_productos p
SET tipo_mercado = CASE
        WHEN EXISTS (SELECT 1 FROM public.dim_unidades_negocio un
                     WHERE un.id = p.unidad_negocio_id AND un.nombre ILIKE '%pharmetique%')
          OR EXISTS (SELECT 1 FROM public.dim_laboratorios l
                     WHERE l.id = p.laboratorio_id AND l.nombre ILIKE '%pharmetique%')
        THEN 'MARCA'
        ELSE 'GENERICO'
    END
WHERE p.tipo_mercado IS NULL;

ALTER TABLE public.dim_productos
    ALTER COLUMN tipo_mercado SET DEFAULT 'GENERICO',
    ALTER COLUMN tipo_mercado SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_dim_productos_tipo_mercado'
    ) THEN
        ALTER TABLE public.dim_productos
            ADD CONSTRAINT chk_dim_productos_tipo_mercado
            CHECK (tipo_mercado IN ('MARCA', 'GENERICO'));
    END IF;
END $$;

COMMENT ON COLUMN public.dim_productos.tipo_mercado IS
'MARCA o GENERICO. Se carga en el formulario de producto o con la columna tipo_mercado del CSV.';

-- Que PostgREST vea la columna nueva sin esperar.
NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- COMPROBACION
-- ----------------------------------------------------------------------------
/*
SELECT tipo_mercado, count(*) FROM dim_productos
WHERE id_interno NOT LIKE 'COMP\_%' GROUP BY 1;
*/
