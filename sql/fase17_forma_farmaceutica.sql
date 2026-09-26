-- ============================================================================
-- TRACKFLOW - FASE 17: LA FORMA FARMACEUTICA SALE DEL NOMBRE
-- ============================================================================
-- Tercera y ultima pieza que vivia dentro de dim_productos.nombre. Despues de
-- esto el nombre es solo la identidad comercial y todo lo demas tiene columna:
--
--   "ACETAMINOFEN 500 MG TAB X 20"
--    ^^^^^^^^^^^^  ^^^^^^  ^^^ ^^^^
--    nombre        dosis   forma  empaque
--
-- TAMBIEN LEE LAS ABREVIATURAS DE CAJA Y FRASCO
-- Revisando las 17 filas que la fase 16 marco para revisar, 7 no eran
-- ambiguas: el empaque estaba escrito con las abreviaturas internas, pegado
-- a la "x", y el patron pedia un limite de palabra que ahi no existe.
--
--   "CIPROFIBRATO 100MG TAB CJAX30 VZL"   CJAX30  = caja x 30
--   "ALILUB 1.4%OFT FCOX15ML VEN"         FCOX15  = frasco x 15 ml
--   "NITAX 500MG TAB CJAX6 VEN"           CJAX6   = caja x 6
--
-- Una de ellas destapa un dato mal guardado:
--   "CIPROFLOXACINA 500 MG TAB CJAX10 VEN" dice 10 y hay 12 guardados.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. FORMAS QUE FALTABAN EN EL CATALOGO
-- ----------------------------------------------------------------------------
INSERT INTO public.dim_formas_farmaceuticas (nombre, activo)
VALUES
    ('Tabletas recubiertas', TRUE),
    ('Tabletas masticables', TRUE),
    ('Solución oftálmica', TRUE),
    ('Solución nasal', TRUE),
    ('Solución oral', TRUE),
    ('Polvo para suspensión', TRUE),
    ('Granulado', TRUE),
    ('Sobres', TRUE),
    ('Gel', TRUE),
    ('Comprimidos', TRUE)
ON CONFLICT (nombre) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. LEER EL EMPAQUE PEGADO A CJA/FCO
-- ----------------------------------------------------------------------------
-- El unico cambio respecto a la fase 16 es admitir un prefijo de envase
-- pegado a la "x". El limite de palabra se mueve delante del prefijo, que es
-- donde si existe: en "CJAX30" no hay limite entre "CJA" y "X", pero si antes
-- de la "C".
CREATE OR REPLACE FUNCTION public.fn_quitar_empaque(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT REGEXP_REPLACE(
        p_nombre,
        -- "x 10 tab", "CJAX30", "FCOX15ML", "caja x 30 tabletas", "x12".
        -- El (?![.,0-9]) impide partir "X 1.3 GR" en "X 1" + ".3".
        '\y(caja|cja|cj|fco|frasco|blister|blis)?\s*x\s*[0-9]+([.,][0-9]+)?(?![.,0-9])\s*(ml|g|gr|tab[a-z]*|c[aá]p[a-z]*|comp[a-z]*|amp[a-z]*|sobres?|unidades?|un)?\y'
        -- y el empaque escrito sin la "x": "14Tabletas". Aqui la forma
        -- farmaceutica es obligatoria, para no comerse un numero que forme
        -- parte del nombre ("Complejo B12").
        '|\y[0-9]+\s*(tabletas?|tabs?|tab|c[aá]psulas?|caps?|comprimidos?|comp|ampollas?|amp|sobres?)\y',
        ' ', 'gi');
$$;

CREATE OR REPLACE FUNCTION public.fn_tamano_del_nombre(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    WITH por_x AS (
        SELECT (REGEXP_MATCH(
                    p_nombre,
                    '\y(?:caja|cja|cj|fco|frasco|blister|blis)?\s*x\s*([0-9]+(?:[.,][0-9]+)?)\s*(ml|g|gr|tab[a-z]*|c[aá]p[a-z]*|comp[a-z]*|amp[a-z]*|sobres?|unidades?)?',
                    'i')) AS m
    ),
    sin_dosis AS (
        SELECT (REGEXP_MATCH(
                    public.fn_quitar_concentracion(p_nombre),
                    '([0-9]+(?:[.,][0-9]+)?)\s*(ml|g|gr|tab[a-z]*|c[aá]p[a-z]*|comp[a-z]*|amp[a-z]*|sobres?)',
                    'i')) AS m
    ),
    elegido AS (
        SELECT COALESCE((SELECT m FROM por_x), (SELECT m FROM sin_dosis)) AS m
    )
    SELECT CASE
        WHEN m IS NULL THEN NULL
        WHEN LOWER(COALESCE(m[2], '')) = 'ml'         THEN m[1] || ' ml'
        WHEN LOWER(COALESCE(m[2], '')) IN ('g', 'gr') THEN m[1] || ' g'
        WHEN m[1] = '1'                               THEN '1 unidad'
        ELSE m[1] || ' unidades'
    END
    FROM elegido;
$$;

-- ----------------------------------------------------------------------------
-- 2b. EL NOMBRE, APOYADO EN LAS DOS FUNCIONES ANTERIORES
-- ----------------------------------------------------------------------------
-- En la fase 16 esta funcion repetia el patron de empaque por su cuenta, asi
-- que al ensenarle "CJAX30" a fn_quitar_empaque el nombre seguia saliendo como
-- "CIPROFIBRATO TAB CJAX30 VZL". Ahora las dos leen el mismo patron.
--
-- El empaque se quita ANTES que la concentracion: al reves, en "FCOX15ML" la
-- concentracion se lleva el "15ML" y deja un "FCOX" sin numero que el patron
-- de empaque ya no reconoce.
CREATE OR REPLACE FUNCTION public.fn_nombre_sin_dosis(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(TRIM(BOTH ' -,.' FROM
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                public.fn_quitar_concentracion(public.fn_quitar_empaque(p_nombre)),
                -- Separadores y "x" que quedan huerfanos al borrar lo de al
                -- lado. El "+" entre dos moleculas SI significa algo
                -- ("LOSARTAN + HCTZ"), asi que solo se quita en los bordes.
                '\s+[xX]\s+|\s+[-/]\s+|\s+[/+]\s*$|^[/+]\s+|\s+[xX]\s*$', ' ', 'g'),
            '\s{2,}', ' ', 'g')
    ), '');
$$;

-- ----------------------------------------------------------------------------
-- 3. QUE FORMA FARMACEUTICA DICE EL NOMBRE
-- ----------------------------------------------------------------------------
-- El orden de los CASE importa: "TAB REC" tiene que resolverse como tableta
-- recubierta ANTES de que "TAB" a secas lo capture como tableta normal.
--
-- Todas las abreviaturas se comparan como palabra completa (\y a los dos
-- lados) y NO con \w*. Con \w* "CAP" se comeria "CAPTOPRIL" y "TAB" se
-- comeria cualquier nombre que empiece igual.
CREATE OR REPLACE FUNCTION public.fn_forma_del_nombre(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_nombre ~* '\y(oft[aáAÁ]lmicas?|oft)\y'        THEN 'Solución oftálmica'
        WHEN p_nombre ~* '\y(nasal|spray)\y'                      THEN 'Solución nasal'
        WHEN p_nombre ~* '\y(tabletas?|tabs?|tab)\y\s*\y(masticables?|mast)\y' THEN 'Tabletas masticables'
        WHEN p_nombre ~* '\y(tabletas?|tabs?|tab)\y\s*\y(recubiertas?|rec|r)\y' THEN 'Tabletas recubiertas'
        WHEN p_nombre ~* '\y(tabletas?|tabs?|tab)\y'        THEN 'Tabletas'
        WHEN p_nombre ~* '\y(c[aáAÁ]psulas?|caps?)\y' THEN 'Cápsulas'
        WHEN p_nombre ~* '\y(comprimidos?|comp)\y'                THEN 'Comprimidos'
        WHEN p_nombre ~* '\y(jarabe|jbe)\y'                       THEN 'Jarabe'
        WHEN p_nombre ~* '\y(pps|pprso|pso)\y'                    THEN 'Polvo para suspensión'
        WHEN p_nombre ~* '\y(suspensi[oóOÓ]n|susp)\y'       THEN 'Suspensión'
        WHEN p_nombre ~* '\y(soluci[oóOÓ]n|sol)\y\s*\y(oral)\y'                 THEN 'Solución oral'
        WHEN p_nombre ~* '\y(soluci[oóOÓ]n|sol)\y'            THEN 'Solución'
        WHEN p_nombre ~* '\y(cremas?|crem|cre)\y'                   THEN 'Crema'
        WHEN p_nombre ~* '\y(gel)\y'                              THEN 'Gel'
        WHEN p_nombre ~* '\y(granulados?|gran)\y'                   THEN 'Granulado'
        WHEN p_nombre ~* '\y(sobres?|sob)\y'                      THEN 'Sobres'
        WHEN p_nombre ~* '\y(gotas)\y'                            THEN 'Gotas'
        WHEN p_nombre ~* '\y([oóOÓ]vulos?)\y'                  THEN 'Óvulo'
        ELSE NULL
    END;
$$;

COMMENT ON FUNCTION public.fn_forma_del_nombre(TEXT) IS
'Deduce la forma farmaceutica a partir de las abreviaturas del nombre. NULL cuando el nombre no la dice.';

-- ----------------------------------------------------------------------------
-- 4. QUITAR LA FORMA DEL NOMBRE
-- ----------------------------------------------------------------------------
-- Se quitan solo los tokens de forma. Lo demas se respeta aunque parezca
-- ruido, porque distingue productos de verdad:
--   "BROXOL FLEM AD" y "BROXOL FLEM PED" son dos productos, no uno.
--   "VZL", "VEN", "VNZ" marcan el pais y tampoco se tocan.
CREATE OR REPLACE FUNCTION public.fn_nombre_sin_forma(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(TRIM(BOTH ' -,.' FROM
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                p_nombre,
                -- Siempre de la variante mas larga a la mas corta: la
                -- alternancia de Postgres se queda con la PRIMERA que encaja,
                -- no con la mas larga, asi que con "oft" delante de
                -- "oftalmica" el nombre "SOLUCION OFTALMICA" acaba como
                -- "SOLUCION ALMICA".
                '\y(tabletas?|tabs?|tab|c[aáAÁ]psulas?|caps?'
                '|comprimidos?|comp|jarabe|jbe|pprso|pps|pso'
                '|suspensi[oóOÓ]n|susp|soluci[oóOÓ]n|sol|oral'
                '|cremas?|crem|cre|gel|granulados?|gran|sobres?|sob'
                '|oft[aáAÁ]lmicas?|oft|nasal|spray'
                '|masticables?|mast|recubiertas?|rec'
                '|gotas|[oóOÓ]vulos?'
                -- nombres de envase: tampoco son identidad comercial
                '|frascos?|fco|cajas?|cja|cj|blisters?|blis)\y',
                ' ', 'gi'),
            '\s{2,}', ' ', 'g')
    ), '');
$$;

-- ----------------------------------------------------------------------------
-- 5. EL CSV, AHORA CON forma_farmaceutica
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_csv_productos;
CREATE VIEW public.v_csv_productos
WITH (security_invoker = true) AS
WITH base AS (
    SELECT
        p.id,
        p.id_interno,
        p.nombre AS nombre_original,
        p.codigo_barra,
        p.cantidad_contenido,
        p.unidad_contenido,
        l.nombre  AS laboratorio,
        c.nombre  AS categoria,
        un.nombre AS unidad_negocio,
        ff.nombre AS forma_guardada,
        COALESCE(public.fn_nombre_sin_dosis(p.nombre), p.nombre) AS nombre_sin_dosis,
        public.fn_forma_del_nombre(p.nombre)  AS forma_detectada,
        public.fn_dosis_del_nombre(p.nombre)  AS dosis,
        public.fn_tamano_del_nombre(p.nombre) AS tamano_detectado
    FROM public.dim_productos p
    JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
    LEFT JOIN public.dim_categorias          c  ON c.id  = p.categoria_id
    LEFT JOIN public.dim_unidades_negocio    un ON un.id = p.unidad_negocio_id
    LEFT JOIN public.dim_formas_farmaceuticas ff ON ff.id = p.forma_farmaceutica_id
    WHERE p.id_interno NOT LIKE 'COMP\_%'
)
SELECT
    b.id_interno,
    -- Si quitar la forma dejara el nombre vacio se conserva el anterior:
    -- "GOTAS" como nombre completo de producto es raro, pero pasa.
    COALESCE(public.fn_nombre_sin_forma(b.nombre_sin_dosis), b.nombre_sin_dosis) AS nombre,
    COALESCE(b.codigo_barra, '')        AS codigo_barra,
    -- La molecula no se puede deducir de un nombre de marca ("ESOZ"), asi que
    -- se deja vacia a proposito en vez de adivinarla.
    ''                                  AS principio_activo,
    COALESCE(b.dosis, '')               AS concentracion,
    COALESCE(
        b.tamano_detectado,
        TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM b.cantidad_contenido::text))
            || ' ' || b.unidad_contenido
    )                                   AS tamano,
    COALESCE(b.forma_detectada, b.forma_guardada, '') AS forma_farmaceutica,
    b.laboratorio,
    COALESCE(b.categoria, 'Otros')      AS categoria,
    CASE WHEN COALESCE(b.unidad_negocio, '') ILIKE '%pharmetique%'
              OR b.laboratorio ILIKE '%pharmetique%'
         THEN 'MARCA' ELSE 'GENERICO' END AS market_type,
    COALESCE(b.unidad_negocio, 'La Sante') AS unidad_negocio,
    -- Columnas de ayuda: NO van en el CSV, sirven para revisar antes.
    b.nombre_original                   AS zz_nombre_original,
    TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM b.cantidad_contenido::text))
        || ' ' || b.unidad_contenido    AS zz_empaque_guardado,
    CASE
        WHEN b.tamano_detectado IS NULL
            THEN 'el nombre no dice el empaque: se conserva el guardado'
        WHEN b.tamano_detectado IS DISTINCT FROM (
                 TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM b.cantidad_contenido::text))
                 || ' ' || CASE b.unidad_contenido WHEN 'unidad' THEN
                     CASE WHEN b.cantidad_contenido = 1 THEN 'unidad' ELSE 'unidades' END
                     ELSE b.unidad_contenido END)
            THEN 'el nombre y lo guardado no coinciden: gana el nombre'
        -- El flag 'i' no es opcional: sin el, "X 40 G X 7 APLI" no se parte
        -- porque la "x" del nombre va en mayuscula y el patron no coincide.
        WHEN ARRAY_LENGTH(REGEXP_SPLIT_TO_ARRAY(b.nombre_original, '\yx\s*[0-9]', 'i'), 1) > 2
            THEN 'el nombre menciona mas de un empaque'
    END                                 AS zz_revisar
FROM base b
ORDER BY b.id_interno;

COMMENT ON VIEW public.v_csv_productos IS
'Catalogo propio con nombre, dosis, forma farmaceutica y empaque separados, en las columnas que lee la pantalla de Productos. Las columnas zz_* son de revision y no se suben.';

-- ----------------------------------------------------------------------------
-- PERMISOS
-- ----------------------------------------------------------------------------
GRANT SELECT ON public.v_csv_productos TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_forma_del_nombre(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nombre_sin_forma(TEXT) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- COMO USARLO
-- ----------------------------------------------------------------------------
/*
-- 1. Revisar lo dudoso antes de exportar:
SELECT id_interno, zz_nombre_original, nombre, concentracion, forma_farmaceutica,
       tamano, zz_empaque_guardado, zz_revisar
FROM v_csv_productos WHERE zz_revisar IS NOT NULL;

-- 2. El CSV para descargar:
SELECT id_interno, nombre, codigo_barra, principio_activo, concentracion,
       tamano, forma_farmaceutica, laboratorio, categoria, market_type, unidad_negocio
FROM v_csv_productos;
*/
