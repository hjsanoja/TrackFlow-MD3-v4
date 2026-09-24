-- ============================================================================
-- TRACKFLOW - FASE 20: UNIFICAR MOLECULAS DUPLICADAS
-- ============================================================================
-- dim_principios_activos tenia la misma molecula escrita de varias formas
-- ("Acetaminofen" / "Acetaminofén" / "ACETAMINOFEN"). El panel buscaba por
-- nombre sin distinguir mayusculas pero SI tildes, asi que cada carga con otra
-- ortografia creaba una molecula nueva, y los analisis por molecula las
-- trataban como distintas.
--
-- Esta fase agrupa las moleculas cuyo nombre es igual sin mayusculas, tildes
-- ni signos, y deja una por grupo:
--   - se queda la mas usada (a igualdad, la mas antigua); con las variantes de
--     la tabla de abajo, la ortografia a la que apuntan,
--   - los productos que usaban las otras pasan a la que se queda,
--   - los otros nombres quedan guardados como sinonimos,
--   - las duplicadas se borran.
--
-- Y despues, TODAS las moleculas quedan escritas igual: sin tildes y con la
-- primera letra en mayuscula ("Acetaminofen", "Losartan potasico"). Es la
-- misma regla que "La Sante": evita diferencias y que Excel rompa las tildes
-- al editar un CSV. El nombre anterior queda como sinonimo, asi que escrito
-- con tildes se sigue reconociendo.
--
-- Tambien une variantes que no son solo de tildes (tabla de abajo, ampliable).
-- Solo cambia nombres de moleculas: productos, dosis e historial no se tocan.
-- Idempotente: se puede correr mas de una vez.
-- ============================================================================

-- VISTA PREVIA (opcional, correr antes): que grupos se van a unir.
/*
WITH n AS (
  SELECT id, nombre,
         TRIM(REGEXP_REPLACE(LOWER(TRANSLATE(nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]+', ' ', 'g')) AS clave
  FROM dim_principios_activos
)
SELECT clave, array_agg(nombre ORDER BY id) AS variantes, count(*) AS cuantas
FROM n GROUP BY clave HAVING count(*) > 1 ORDER BY clave;
*/

CREATE OR REPLACE FUNCTION public.fn_clave_molecula(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT TRIM(REGEXP_REPLACE(
        LOWER(TRANSLATE(COALESCE(p_nombre, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')),
        '[^a-z0-9]+', ' ', 'g'));
$$;

-- Como se escribe una molecula: sin tildes (la n tambien pierde la tilde),
-- espacios simples y la primera letra en mayuscula. Si estaba TODA en
-- mayusculas pasa a minusculas; si no, se respeta el resto
-- ("Extracto de Hedera helix" conserva la H del nombre cientifico).
CREATE OR REPLACE FUNCTION public.fn_nombre_molecula(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    WITH limpio AS (
        SELECT REGEXP_REPLACE(TRIM(TRANSLATE(COALESCE(p_nombre, ''),
                   'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '\s+', ' ', 'g') AS t
    )
    SELECT UPPER(LEFT(t, 1)) || CASE WHEN t = UPPER(t) THEN LOWER(SUBSTRING(t FROM 2)) ELSE SUBSTRING(t FROM 2) END
    FROM limpio;
$$;

COMMENT ON FUNCTION public.fn_nombre_molecula(TEXT) IS
'Forma canonica del nombre de una molecula: sin tildes y con la primera letra en mayuscula.';

COMMENT ON FUNCTION public.fn_clave_molecula(TEXT) IS
'Nombre de molecula sin mayusculas, tildes ni signos. Dos moleculas con la misma clave son la misma.';

DO $$
DECLARE
    v_grupos    INT := 0;
    v_movidas   INT := 0;
    v_renombradas INT := 0;
    v_borradas  INT := 0;
    n           INT;
    r           RECORD;
BEGIN
    -- Variantes que no son solo de tildes o mayusculas. Clave -> clave.
    -- Ampliable: (variante, como debe quedar), ambas ya en forma de clave.
    CREATE TEMP TABLE tmp_equivalencias (desde TEXT PRIMARY KEY, hacia TEXT NOT NULL) ON COMMIT DROP;
    INSERT INTO tmp_equivalencias VALUES
        ('diclofenac potasico', 'diclofenaco potasico'),
        ('diclofenac sodico',   'diclofenaco sodico'),
        ('diclofenac',          'diclofenaco'),
        ('paracetamol',         'acetaminofen'),
        ('hctz',                'hidroclorotiazida'),
        ('glimepiride',         'glimepirida');

    -- Grupo de cada molecula y cual se queda.
    CREATE TEMP TABLE tmp_moleculas ON COMMIT DROP AS
    WITH base AS (
        SELECT m.id,
               m.nombre,
               COALESCE(e.hacia, public.fn_clave_molecula(m.nombre)) AS clave,
               (SELECT count(*) FROM public.producto_principios pp WHERE pp.principio_activo_id = m.id) AS usos
        FROM public.dim_principios_activos m
        LEFT JOIN tmp_equivalencias e ON e.desde = public.fn_clave_molecula(m.nombre)
    )
    SELECT b.*,
           FIRST_VALUE(b.id) OVER (
               PARTITION BY b.clave
               -- con variantes de la tabla, gana la ortografia a la que apunta
               ORDER BY (public.fn_clave_molecula(b.nombre) = b.clave) DESC, b.usos DESC, b.id
           ) AS id_final,
           count(*) OVER (PARTITION BY b.clave) AS en_grupo
    FROM base b;

    SELECT count(DISTINCT clave) INTO v_grupos FROM tmp_moleculas WHERE en_grupo > 1;

    CREATE TEMP TABLE tmp_principal (producto_id BIGINT) ON COMMIT DROP;

    FOR r IN SELECT * FROM tmp_moleculas WHERE id <> id_final ORDER BY clave, id LOOP
        -- Si el producto ya tenia la que se queda, sobra la fila duplicada.
        -- Si la duplicada era la principal, la principal pasa a ser la otra
        -- (el indice unico parcial solo admite una principal por producto,
        -- asi que primero se borra y luego se marca).
        DELETE FROM tmp_principal;
        INSERT INTO tmp_principal
        SELECT dup.producto_id
        FROM public.producto_principios dup
        JOIN public.producto_principios keep
          ON keep.producto_id = dup.producto_id AND keep.principio_activo_id = r.id_final
        WHERE dup.principio_activo_id = r.id AND dup.es_principal;

        DELETE FROM public.producto_principios dup
        USING public.producto_principios keep
        WHERE dup.principio_activo_id = r.id
          AND keep.producto_id = dup.producto_id
          AND keep.principio_activo_id = r.id_final;

        UPDATE public.producto_principios pp
        SET es_principal = TRUE
        WHERE pp.principio_activo_id = r.id_final
          AND pp.producto_id IN (SELECT producto_id FROM tmp_principal);

        -- El resto de productos solo cambia de molecula.
        UPDATE public.producto_principios
        SET principio_activo_id = r.id_final
        WHERE principio_activo_id = r.id;
        GET DIAGNOSTICS n = ROW_COUNT;
        v_movidas := v_movidas + n;

        -- El nombre descartado se guarda como sinonimo.
        UPDATE public.dim_principios_activos f
        SET sinonimos = (
            SELECT ARRAY(SELECT DISTINCT s FROM unnest(
                COALESCE(f.sinonimos, '{}') || r.nombre || COALESCE(d.sinonimos, '{}')) s
                WHERE s IS NOT NULL AND s <> f.nombre ORDER BY s))
        FROM public.dim_principios_activos d
        WHERE f.id = r.id_final AND d.id = r.id;

        DELETE FROM public.dim_principios_activos WHERE id = r.id;
        v_borradas := v_borradas + 1;
    END LOOP;

    -- Todas las moleculas: sin tildes y con la primera letra en mayuscula.
    -- El nombre anterior, si cambia, se guarda como sinonimo.
    UPDATE public.dim_principios_activos m
    SET sinonimos = (
            SELECT ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(m.sinonimos, '{}') || m.nombre) x
                         WHERE x IS NOT NULL AND x <> public.fn_nombre_molecula(m.nombre) ORDER BY x)),
        nombre = public.fn_nombre_molecula(m.nombre)
    WHERE m.nombre <> public.fn_nombre_molecula(m.nombre);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_renombradas := n;

    -- Un sinonimo igual al nombre no aporta nada.
    UPDATE public.dim_principios_activos m
    SET sinonimos = ARRAY(SELECT x FROM unnest(m.sinonimos) x WHERE x <> m.nombre ORDER BY x)
    WHERE m.nombre = ANY(m.sinonimos);

    RAISE NOTICE 'Grupos unificados: %. Moleculas borradas: %. Filas de productos reasignadas: %. Nombres escritos sin tildes: %.',
        v_grupos, v_borradas, v_movidas, v_renombradas;
END $$;

-- ----------------------------------------------------------------------------
-- COMPROBACION: no debe devolver filas.
-- ----------------------------------------------------------------------------
SELECT public.fn_clave_molecula(nombre) AS clave, array_agg(nombre) AS variantes
FROM public.dim_principios_activos
GROUP BY 1
HAVING count(*) > 1;

GRANT EXECUTE ON FUNCTION public.fn_clave_molecula(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nombre_molecula(TEXT) TO anon, authenticated;

-- Como quedaron (opcional):
/*
SELECT nombre, sinonimos FROM dim_principios_activos ORDER BY nombre;
*/
