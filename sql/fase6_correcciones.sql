-- ============================================================================
-- TRACKFLOW - FASE 6: CORRECCIONES DE BORRADO Y RELACIONES
-- ============================================================================
-- PROBLEMA 1: "Eliminar en Dimensiones Maestras no funciona"
--   CAUSA RAIZ: fase1_rls.sql habilita RLS en las 18 tablas y crea UNICAMENTE
--   politicas SELECT / INSERT / UPDATE para el rol 'authenticated'
--   (ver comentario original: "sin DELETE por borrado logico").
--   En PostgREST, un DELETE sin politica que lo permita NO devuelve error:
--   responde 204 No Content habiendo borrado 0 filas. Por eso el frontend
--   mostraba "Registro eliminado" y la fila seguia ahi al recargar.
--
-- PROBLEMA 2: Escrituras manuales de tasa BCV que nunca se guardaban
--   CAUSA RAIZ: dim_tasa_bcv solo tenia politica SELECT, pero la pantalla de
--   Dimensiones y useBcvRate.js intentan INSERT/UPDATE sobre ella.
--
-- ORDEN DE EJECUCION: correr DESPUES de fase1_esquema.sql y fase1_rls.sql.
-- Es idempotente: se puede ejecutar varias veces sin efectos secundarios.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. POLITICAS DELETE PARA CATALOGOS Y TABLAS DE RELACION
-- ----------------------------------------------------------------------------
-- Nota: todas las FK del esquema son ON DELETE RESTRICT, asi que una politica
-- DELETE NO permite borrar un padre con hijos: Postgres seguira devolviendo el
-- error 23503 (foreign key violation), que ahora el frontend si muestra.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'dim_cadenas', 'dim_laboratorios', 'dim_marcas', 'dim_categorias',
            'dim_unidades_negocio', 'dim_formas_farmaceuticas', 'dim_tipos_promocion',
            'dim_principios_activos', 'dim_productos', 'producto_principios',
            'pvp_propio', 'producto_equivalencias', 'publicaciones', 'config_calidad'
        ])
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_delete_%I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "auth_delete_%I" ON %I FOR DELETE TO authenticated USING (true)', t, t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. dim_tasa_bcv: ALTA/EDICION/BORRADO MANUAL DESDE EL PANEL
-- ----------------------------------------------------------------------------
-- La serie oficial la escribe el scraper con service_role, pero el panel debe
-- poder corregir una tasa cargada mal.
DROP POLICY IF EXISTS "auth_insert_dim_tasa_bcv" ON dim_tasa_bcv;
CREATE POLICY "auth_insert_dim_tasa_bcv" ON dim_tasa_bcv
    FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_dim_tasa_bcv" ON dim_tasa_bcv;
CREATE POLICY "auth_update_dim_tasa_bcv" ON dim_tasa_bcv
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_dim_tasa_bcv" ON dim_tasa_bcv;
CREATE POLICY "auth_delete_dim_tasa_bcv" ON dim_tasa_bcv
    FOR DELETE TO authenticated USING (true);

-- ----------------------------------------------------------------------------
-- 3. TABLAS DE HECHOS: BORRADO PARA "LIMPIAR DATOS DE PRUEBA"
-- ----------------------------------------------------------------------------
-- DECISION DE SEGURIDAD EXPLICITA: se concede DELETE (no INSERT ni UPDATE) a
-- 'authenticated' sobre fact_precios y scrape_runs para que la herramienta de
-- limpieza del panel funcione. La escritura de capturas sigue siendo exclusiva
-- del scraper via service_role.
-- Si prefieres que NADIE pueda vaciar los hechos desde el navegador, comenta
-- este bloque y haz las limpiezas desde el SQL Editor de Supabase.
DROP POLICY IF EXISTS "auth_delete_fact_precios" ON fact_precios;
CREATE POLICY "auth_delete_fact_precios" ON fact_precios
    FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_delete_scrape_runs" ON scrape_runs;
CREATE POLICY "auth_delete_scrape_runs" ON scrape_runs
    FOR DELETE TO authenticated USING (true);

-- ----------------------------------------------------------------------------
-- 4. BORRADO EN CASCADA TRANSACCIONAL DE UN PRODUCTO
-- ----------------------------------------------------------------------------
-- Con FKs RESTRICT, borrar un producto desde el navegador exige 6 llamadas en
-- el orden exacto; si una falla a medias queda todo inconsistente. Esta funcion
-- lo hace en UNA transaccion y devuelve el conteo de filas borradas por tabla.
CREATE OR REPLACE FUNCTION public.fn_eliminar_producto(p_id_interno TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_producto_id BIGINT;
    v_facts INT := 0;
    v_pubs INT := 0;
    v_pvp INT := 0;
    v_equiv INT := 0;
    v_prod INT := 0;
BEGIN
    SELECT id INTO v_producto_id
    FROM dim_productos
    WHERE id_interno = p_id_interno;

    IF v_producto_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', FALSE,
            'motivo', format('No existe dim_productos.id_interno = %L', p_id_interno)
        );
    END IF;

    -- 1. Hechos que cuelgan de las publicaciones del producto
    DELETE FROM fact_precios
    WHERE publicacion_id IN (SELECT id FROM publicaciones WHERE producto_id = v_producto_id);
    GET DIAGNOSTICS v_facts = ROW_COUNT;

    -- 2. Publicaciones (URLs monitoreadas)
    DELETE FROM publicaciones WHERE producto_id = v_producto_id;
    GET DIAGNOSTICS v_pubs = ROW_COUNT;

    -- 3. PVP propio vigente e historico
    DELETE FROM pvp_propio WHERE producto_id = v_producto_id;
    GET DIAGNOSTICS v_pvp = ROW_COUNT;

    -- 4. Equivalencias en ambos sentidos (propio <-> competidor)
    DELETE FROM producto_equivalencias
    WHERE producto_propio_id = v_producto_id
       OR producto_competidor_id = v_producto_id;
    GET DIAGNOSTICS v_equiv = ROW_COUNT;

    -- 5. Principios activos asociados (FK CASCADE, pero explicito es mas claro)
    DELETE FROM producto_principios WHERE producto_id = v_producto_id;

    -- 6. El producto
    DELETE FROM dim_productos WHERE id = v_producto_id;
    GET DIAGNOSTICS v_prod = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', v_prod > 0,
        'producto_id', v_producto_id,
        'fact_precios', v_facts,
        'publicaciones', v_pubs,
        'pvp_propio', v_pvp,
        'producto_equivalencias', v_equiv,
        'dim_productos', v_prod
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_eliminar_producto(TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. HIGIENE DE DATOS: LABORATORIOS PROPIOS MAL MARCADOS
-- ----------------------------------------------------------------------------
-- dbClient.js creaba todo laboratorio nuevo con es_propio = TRUE, lo que hace
-- que laboratorios de la competencia (Calox, Genven, Megalabs...) se cuenten
-- como marca propia en los analisis. Se re-marca segun la lista real.
--
-- IMPORTANTE: esta lista es la fuente de verdad y tambien esta replicada en
-- web/src/utils/dbClient.js (constante LABS_PROPIOS). Si tienes mas
-- laboratorios propios, agregalos en AMBOS lugares antes de ejecutar: el
-- segundo UPDATE pone es_propio = FALSE en todo lo que no este aqui.
UPDATE dim_laboratorios
SET es_propio = TRUE
WHERE UPPER(TRIM(nombre)) IN ('LA SANTE', 'LA SANTÉ', 'PHARMETIQUE', 'PHARMETIQUE LABS', 'PHARMETIQUELABS')
  AND es_propio IS DISTINCT FROM TRUE;

UPDATE dim_laboratorios
SET es_propio = FALSE
WHERE UPPER(TRIM(nombre)) NOT IN ('LA SANTE', 'LA SANTÉ', 'PHARMETIQUE', 'PHARMETIQUE LABS', 'PHARMETIQUELABS')
  AND es_propio IS DISTINCT FROM FALSE;

-- ----------------------------------------------------------------------------
-- 6. HIGIENE DE DATOS: NOMBRES CAPTURADOS CON PREFIJO DECORATIVO "//"
-- ----------------------------------------------------------------------------
-- El <h1> de Farmatodo trae un separador decorativo que el scraper guardaba
-- literal ("//Cefotas 250mg/5ml ...").
UPDATE dim_productos
SET nombre = TRIM(REGEXP_REPLACE(nombre, '^[\s/|·•-]+', ''))
WHERE nombre ~ '^[\s/|·•-]+';

-- OJO: despues de fase5_archivo_deprecacion.sql, 'productos_competencia' ya no
-- es una tabla sino una VISTA sobre v_ultimo_precio_valido, y esa vista usa
-- DISTINCT ON, asi que no es actualizable:
--   ERROR 55000: cannot update view "v_ultimo_precio_valido"
-- Por eso el UPDATE se aplica solo si sigue siendo una tabla real. Si ya es
-- vista, el nombre se limpia solo, porque la vista lee de dim_productos.
DO $limpieza$
DECLARE
    v_relkind "char";
BEGIN
    SELECT c.relkind INTO v_relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'productos_competencia';

    IF v_relkind = 'r' THEN
        EXECUTE $sql$
            UPDATE productos_competencia
            SET ultimo_nombre = TRIM(REGEXP_REPLACE(ultimo_nombre, '^[\s/|·•-]+', ''))
            WHERE ultimo_nombre ~ '^[\s/|·•-]+'
        $sql$;
        RAISE NOTICE 'productos_competencia es tabla: nombres limpiados.';
    ELSIF v_relkind = 'v' THEN
        RAISE NOTICE 'productos_competencia es una vista de compatibilidad: se omite el UPDATE (se corrige en el paso 7).';
    ELSE
        RAISE NOTICE 'productos_competencia no existe en este proyecto: se omite.';
    END IF;
END
$limpieza$;

-- Misma situacion para la tabla legacy archivada por la Fase 5.
DO $limpieza_legacy$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'legacy_productos_competencia'
          AND c.relkind = 'r'
    ) THEN
        EXECUTE $sql$
            UPDATE legacy_productos_competencia
            SET ultimo_nombre = TRIM(REGEXP_REPLACE(ultimo_nombre, '^[\s/|·•-]+', ''))
            WHERE ultimo_nombre ~ '^[\s/|·•-]+'
        $sql$;
    END IF;
END
$limpieza_legacy$;

-- ----------------------------------------------------------------------------
-- 7. CORRECCION DE LA VISTA DE COMPATIBILIDAD productos_competencia
-- ----------------------------------------------------------------------------
-- ESTA ES LA CAUSA REAL DE QUE EL PANEL MUESTRE LOS DATOS MAL RELACIONADOS.
--
-- La vista creada por fase5_archivo_deprecacion.sql hace:
--     v.id_interno AS id,
--     v.id_interno AS id_producto_propio,   <-- el mismo valor en ambas
--
-- Es decir, cada producto de la competencia queda apuntando A SI MISMO como si
-- fuera su propio "producto propio". El frontend cruza
-- productos_competencia.id_producto_propio contra dim_productos.id_interno, asi
-- que los COMP_* se emparejaban consigo mismos y aparecian como filas propias
-- con "Rank: 1°/1". La relacion verdadera vive en producto_equivalencias y la
-- vista nunca la consultaba.
--
-- Otros dos defectos que se corrigen aqui:
--   * 'marca' devolvia el nombre del LABORATORIO, no el del producto.
--   * 'id' no era unico: un competidor con URL en dos cadenas producia dos
--     filas con el mismo id.
DO $vista$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'productos_competencia'
          AND c.relkind = 'v'
    ) THEN
        -- DROP + CREATE (no CREATE OR REPLACE): cambian nombres y tipos de
        -- columnas, y CREATE OR REPLACE VIEW no lo permite.
        DROP VIEW public.productos_competencia;

        CREATE VIEW public.productos_competencia AS
        SELECT
            -- Unico por (publicacion, producto propio al que se compara)
            v.publicacion_id::text || '_' ||
                COALESCE(pe.producto_propio_id, v.producto_id)::text AS id,
            -- La relacion real: competidor -> producto propio equivalente
            COALESCE(p_propio.id_interno, v.id_interno) AS id_producto_propio,
            v.cadena_id AS cadena,
            v.producto_nombre AS marca,
            CASE WHEN v.es_propio THEN 'propio' ELSE 'alternativa' END AS tipo,
            v.url,
            v.fecha_captura AS ultimo_scrape,
            'ok'::text AS estado,
            NULL::text AS ultimo_error,
            v.precio_full_bs AS ultimo_precio_full_bs,
            v.precio_desc_bs AS ultimo_precio_desc_bs,
            CASE WHEN v.tasa_bcv > 0
                 THEN ROUND((v.precio_full_bs / v.tasa_bcv)::numeric, 2)
                 ELSE NULL END AS ultimo_precio_full_usd,
            CASE WHEN v.tasa_bcv > 0 AND v.precio_desc_bs IS NOT NULL
                 THEN ROUND((v.precio_desc_bs / v.tasa_bcv)::numeric, 2)
                 ELSE NULL END AS ultimo_precio_desc_usd,
            v.producto_nombre AS ultimo_nombre,
            v.tiene_promocion AS tiene_descuento,
            v.promo_texto_raw AS tipo_promo,
            v.laboratorio_nombre AS laboratorio,
            TRUE AS activo
        FROM public.v_ultimo_precio_valido v
        LEFT JOIN public.producto_equivalencias pe
               ON pe.producto_competidor_id = v.producto_id
              AND pe.activo
        LEFT JOIN public.dim_productos p_propio
               ON p_propio.id = pe.producto_propio_id;

        RAISE NOTICE 'Vista productos_competencia recreada con la relacion correcta via producto_equivalencias.';
    ELSE
        RAISE NOTICE 'productos_competencia no es una vista (Fase 5 no aplicada): no hay nada que corregir aqui.';
    END IF;
END
$vista$;

-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACION
-- ----------------------------------------------------------------------------

-- V1. Confirmar que ahora existen politicas DELETE (debe listar ~17 filas)
/*
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND cmd = 'DELETE'
ORDER BY tablename;
*/

-- V2. Productos competidores que viven en dim_productos (se esperan ~311).
--     El panel NO debe listarlos como productos propios.
/*
SELECT COUNT(*) FILTER (WHERE id_interno LIKE 'COMP\_%') AS competidores,
       COUNT(*) FILTER (WHERE id_interno NOT LIKE 'COMP\_%') AS propios
FROM dim_productos;
*/

-- V3. Productos propios marcados con laboratorio de la competencia
/*
SELECT p.id_interno, p.nombre, l.nombre AS laboratorio, l.es_propio
FROM dim_productos p
JOIN dim_laboratorios l ON l.id = p.laboratorio_id
WHERE p.id_interno NOT LIKE 'COMP\_%' AND NOT l.es_propio
ORDER BY p.id_interno;
*/

-- V4. Publicaciones duplicadas apuntando a la misma URL real
/*
SELECT url_normalizada, COUNT(*) AS veces, ARRAY_AGG(producto_id)
FROM publicaciones
GROUP BY url_normalizada
HAVING COUNT(*) > 1;
*/

-- V5. Competidores SIN equivalencia hacia un producto propio.
--     Estos siguen sin poder compararse con nada: sus precios no apareceran
--     en ninguna fila del Dashboard. Si la lista no esta vacia, hay que
--     poblar producto_equivalencias para ellos.
/*
SELECT p.id_interno, p.nombre, l.nombre AS laboratorio
FROM dim_productos p
JOIN dim_laboratorios l ON l.id = p.laboratorio_id
WHERE p.id_interno LIKE 'COMP\_%'
  AND NOT EXISTS (
      SELECT 1 FROM producto_equivalencias pe
      WHERE pe.producto_competidor_id = p.id AND pe.activo
  )
ORDER BY p.id_interno;
*/

-- V6. Que es cada objeto hoy (tabla 'r' o vista 'v'), tras la Fase 5
/*
SELECT c.relname,
       CASE c.relkind WHEN 'r' THEN 'tabla' WHEN 'v' THEN 'vista' ELSE c.relkind::text END AS tipo
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('productos', 'productos_competencia', 'historico_precios',
                    'cadenas', 'bcv_rates', 'legacy_productos',
                    'legacy_productos_competencia', 'legacy_historico_precios')
ORDER BY c.relname;
*/
