-- ============================================================================
-- TRACKFLOW - FASE 8: UNIFICACION DE NOMENCLATURA DE CAMPOS
-- ============================================================================
-- Estandariza los nombres de columna que no seguian la convencion del resto
-- del esquema. El diccionario completo esta en DICCIONARIO_CAMPOS.md.
--
-- NO ES SOLO COSMETICO. El caso de dim_cadenas es un bug real:
--   * la columna en la base se llama          modulo_scraper
--   * el frontend (Cadenas.jsx, DataContext)  escribe scraper_modulo
--   * el scraper (seed_from_csv.py y la
--     migracion de Firestore)                 escribe scraper_modulo
--   * cadenas.csv trae la cabecera            scraper_modulo
-- Es decir, hoy ese campo NO se guarda: PostgREST descarta la columna que no
-- existe. Al renombrar la columna, los cuatro lados pasan a coincidir.
--
-- CRITERIO DE ELECCION DEL NOMBRE GANADOR: gana el nombre ya usado por la
-- mayoria de los consumidores, para cambiar lo menos posible y no arriesgar
-- datos.
--
-- ORDEN DE EJECUCION: despues de fase7_historico_compat.sql.
-- Es idempotente: se puede ejecutar varias veces.
--
-- IMPORTANTE ANTES DE EJECUTAR
--   1. Detén el workflow "Scraper diario" si esta corriendo en ese momento
--      (pestaña Actions de GitHub). Una corrida a mitad del renombrado
--      escribiria contra nombres viejos.
--   2. Despues de ejecutar este script hay que desplegar el codigo de la rama
--      que lo acompaña. Base y codigo deben ir juntos.
--
-- NOTA SOBRE INSTALACIONES NUEVAS
--   fase1_esquema.sql y fase5_archivo_deprecacion.sql ya fueron actualizados
--   para crear la columna directamente como scraper_modulo. En una base nueva
--   este script no encuentra nada que renombrar y lo informa, que es lo
--   correcto. En una base existente, Postgres actualiza sola la definicion de
--   la vista 'cadenas' al renombrar la columna: no hay que recrearla.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. dim_cadenas.modulo_scraper -> scraper_modulo
-- ----------------------------------------------------------------------------
-- Postgres actualiza solas las vistas que dependen de la columna (la vista
-- 'cadenas' creada por la Fase 5 la proyecta como scraper_modulo), asi que no
-- hay que recrearlas.
DO $cadenas$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_cadenas'
          AND column_name = 'modulo_scraper'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_cadenas'
          AND column_name = 'scraper_modulo'
    ) THEN
        -- SUPERSEDIDO POR fase10_nomenclatura_final.sql
        -- Este paso renombraba a scraper_modulo, que viola la regla 4 del
        -- diccionario (sustantivo primero: es el modulo DEL scraper). La
        -- Fase 10 lo deja en modulo_scraper y alinea los 22 consumidores, y
        -- fase1_esquema.sql ya crea la columna con el nombre correcto. Se
        -- conserva el bloque para no alterar el historial de migraciones.
        RAISE NOTICE 'Paso supersedido por fase10_nomenclatura_final.sql: no se renombra nada.';
    ELSE
        RAISE NOTICE 'dim_cadenas.scraper_modulo ya existe: nada que renombrar.';
    END IF;
END
$cadenas$;

-- ----------------------------------------------------------------------------
-- 2. dim_principios_activos.nombre_dci -> nombre
-- ----------------------------------------------------------------------------
-- Todas las demas dimensiones exponen su descripcion como 'nombre'. Esta era
-- la unica excepcion. (DCI = Denominacion Comun Internacional; el dato no
-- cambia, solo el nombre de la columna.)
DO $principios$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_principios_activos'
          AND column_name = 'nombre_dci'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_principios_activos'
          AND column_name = 'nombre'
    ) THEN
        ALTER TABLE public.dim_principios_activos RENAME COLUMN nombre_dci TO nombre;
        RAISE NOTICE 'dim_principios_activos.nombre_dci renombrada a nombre.';
    ELSE
        RAISE NOTICE 'dim_principios_activos.nombre ya existe: nada que renombrar.';
    END IF;
END
$principios$;

-- ----------------------------------------------------------------------------
-- 3. COLUMNAS QUE NO SE RENOMBRAN, Y POR QUE
-- ----------------------------------------------------------------------------
-- dim_productos.id_interno
--     Es el SKU de negocio y ya es el nombre canonico: lo usan las 4 vistas
--     analiticas, el scraper, la migracion de la Fase 2 y 13 archivos del
--     frontend (205 referencias). Renombrarlo no aporta nada funcional y
--     rompe todo a la vez. Lo que se corrige es el otro lado: las plantillas
--     CSV y las etiquetas de pantalla pasan a decir 'id_interno' en vez de
--     'Codigo ID' o 'id_producto_propio' cuando hablan del mismo dato.
--
-- dim_productos.codigo_barra
--     31 referencias contra 4 de 'codigo_barras'. Se conserva el nombre de la
--     base y se alinea el frontend, que es el cambio mas pequeño.
--
-- dim_tipos_promocion.codigo y dim_cadenas.id
--     No son inconsistencias: son claves de negocio en texto, igual que el
--     'id' de dim_cadenas. Conviven con 'nombre', que es la descripcion.
--
-- dim_tasa_bcv.fecha y config_calidad.clave
--     Son PKs naturales deliberadas, no un 'id' que falte.

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Las columnas quedaron con el nombre nuevo
/*
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
      (table_name = 'dim_cadenas' AND column_name IN ('scraper_modulo','modulo_scraper'))
   OR (table_name = 'dim_principios_activos' AND column_name IN ('nombre','nombre_dci'))
  )
ORDER BY table_name, column_name;
*/

-- V2. La vista de compatibilidad 'cadenas' sigue respondiendo
/*
SELECT * FROM cadenas ORDER BY nombre;
*/

-- V3. Cadenas sin modulo de scraping asignado.
--     Antes del renombrado salian TODAS, porque el valor nunca se guardaba.
/*
SELECT id, nombre, scraper_modulo
FROM dim_cadenas
WHERE scraper_modulo IS NULL OR TRIM(scraper_modulo) = ''
ORDER BY nombre;
*/
