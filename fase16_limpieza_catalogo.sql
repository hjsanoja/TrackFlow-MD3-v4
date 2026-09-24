-- ============================================================================
-- TRACKFLOW - FASE 16: ARMAR EL CSV DE LIMPIEZA DEL CATALOGO
-- ============================================================================
-- La fase 15 sirvio para VER el problema. Esta sirve para ARREGLARLO sin
-- teclear 200 filas a mano: genera el CSV que se vuelve a subir por la
-- pantalla de Productos, ya con el nombre limpio, la dosis y el empaque
-- separados en su propia columna.
--
-- Reimportar NO borra nada. El alta es un upsert por id_interno: actualiza la
-- fila que ya existe y deja intactos publicaciones y fact_precios, que es
-- donde vive el historico de precios.
--
-- ADEMAS CORRIGE fn_nombre_sin_dosis
-- Probada contra 77 nombres reales del catalogo, la version de la fase 15
-- dejaba basura en 11 (14%):
--
--   "DIANALPER ... GEL X 30 GR"     -> "... GEL GR"     ("gr" no estaba en la
--                                                        lista de unidades)
--   "CROMOLOX 4% OFT FCO X 5ML VZL" -> "... FCO X VZL"  (la "x" se queda
--                                                        huerfana cuando el
--                                                        numero se lo lleva la
--                                                        concentracion)
--   "PROLARDII ... X 1.3 GR"        -> "... .3 GR"      (el patron de empaque
--                                                        se comio "X 1" y
--                                                        partio el numero)
--   "TIDOR 2% - 0.5% SOL OFT ..."   -> "TIDOR - SOL ..." (guion huerfano)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. QUITAR SOLO LA CONCENTRACION
-- ----------------------------------------------------------------------------
-- Se separa en su propia funcion porque hace falta dos veces: para limpiar el
-- nombre y para localizar el empaque sin que la dosis estorbe. En
-- "ALBENDAZOL 400MG/20 ML SUSP" los "20 ML" son parte de la dosis, no el
-- tamano del frasco, y sin quitarlos primero se leen como empaque.
CREATE OR REPLACE FUNCTION public.fn_quitar_concentracion(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT REGEXP_REPLACE(
        p_nombre,
        -- Primero el par: "250 mg/5 ml", "50/12.5MG", "160Mg-12,5Mg",
        -- "10 mg/ml". Va antes que la forma simple para que no se coma solo
        -- la primera mitad y deje colgando un "/ml".
        '[0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|gr|ml)?\s*[/-]\s*([0-9]+([.,][0-9]+)?\s*)?(mg|mcg|ug|ui|g|gr|ml|dosis)\y'
        -- luego la simple: "300mg", "12,5 mg", "30 GR"
        '|[0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|gr|ml)\y'
        -- y los porcentajes: "4%", "1,4%", "0.05%"
        '|[0-9]+([.,][0-9]+)?\s*%',
        ' ', 'gi');
$$;

-- ----------------------------------------------------------------------------
-- 2. EL NOMBRE COMERCIAL LIMPIO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_nombre_sin_dosis(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(TRIM(BOTH ' -,.' FROM
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                REGEXP_REPLACE(
                    public.fn_quitar_concentracion(p_nombre),
                    -- "x 10 tab", "caja x 30 tabletas", "x12", "x 6".
                    -- El (?![.,0-9]) impide partir "X 1.3 GR" en "X 1" + ".3".
                    '\y(caja\s+)?x\s*[0-9]+(?![.,0-9])\s*(tab(letas?|s)?|c[aá]p(sulas?|s)?|comp(rimidos?)?|amp(ollas?)?|sobres?|unidades?|un)?\y'
                    -- y el empaque escrito sin la "x": "14Tabletas". Aqui la
                    -- forma farmaceutica es obligatoria, para no comerse un
                    -- numero que forme parte del nombre ("Complejo B12").
                    '|\y[0-9]+\s*(tab(letas?|s)?|c[aá]p(sulas?|s)?|comp(rimidos?)?|amp(ollas?)?|sobres?)\y',
                    ' ', 'gi'),
                -- Separadores y "x" que quedan huerfanos al borrar lo de al
                -- lado. El "+" entre dos moleculas SI significa algo
                -- ("LOSARTAN + HCTZ"), asi que solo se quita en los bordes.
                '\s+[xX]\s+|\s+[-/]\s+|\s+[/+]\s*$|^[/+]\s+|\s+[xX]\s*$', ' ', 'g'),
            '\s{2,}', ' ', 'g')
    ), '');
$$;

COMMENT ON FUNCTION public.fn_nombre_sin_dosis(TEXT) IS
'Propone un nombre comercial sin la dosis ni el tamano del empaque, que ya viven en producto_principios y dim_productos.cantidad_contenido.';

-- ----------------------------------------------------------------------------
-- 2b. QUITAR SOLO EL EMPAQUE
-- ----------------------------------------------------------------------------
-- El reverso de fn_quitar_concentracion, y hace falta por la misma razon: en
-- "ACETAMINOFEN 150MG/5ML JBE X 120 ML" los 120 ml son el frasco, no una
-- segunda dosis. Sin quitarlos antes, la concentracion sale como
-- "150MG/5ML + 120 ML".
CREATE OR REPLACE FUNCTION public.fn_quitar_empaque(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT REGEXP_REPLACE(
        p_nombre,
        '\y(caja\s+)?x\s*[0-9]+([.,][0-9]+)?\s*(ml|g|gr|tab[a-z]*|c[aá]p[a-z]*|comp[a-z]*|amp[a-z]*|sobres?|unidades?|un)?\y',
        ' ', 'gi');
$$;

-- ----------------------------------------------------------------------------
-- 3. LA DOSIS QUE ESTABA ESCONDIDA EN EL NOMBRE
-- ----------------------------------------------------------------------------
-- Devuelve todas las concentraciones encontradas unidas por " + ", que es el
-- formato que espera la columna `concentracion` del CSV:
--   "TIOCOLFEN 600 MG - 4 MG TAB X 15"  ->  "600 MG + 4 MG"
--   "ACETAMINOFEN 150MG/5ML JBE X 120 ML" -> "150MG/5ML"
CREATE OR REPLACE FUNCTION public.fn_dosis_del_nombre(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(
        (SELECT STRING_AGG(TRIM(m[1]), ' + ')
           FROM REGEXP_MATCHES(
                    public.fn_quitar_empaque(p_nombre),
                    '([0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|gr|ml)?\s*[/-]\s*([0-9]+([.,][0-9]+)?\s*)?(mg|mcg|ug|ui|g|gr|ml|dosis)\y'
                    '|[0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|gr|ml)\y'
                    '|[0-9]+([.,][0-9]+)?\s*%)',
                    'gi') AS m),
        '');
$$;

-- ----------------------------------------------------------------------------
-- 4. EL TAMANO DEL EMPAQUE
-- ----------------------------------------------------------------------------
-- La "x" es lo que desambigua. En "ITISONA CREMA X 30 G" los 30 g son el pote;
-- en "ALBENDAZOL 400MG/20 ML SUSP" los 20 ml son parte de la dosis. Por eso se
-- busca primero un "x <numero> <unidad>" sobre el nombre ORIGINAL, y solo si
-- no aparece se mira el texto ya sin concentraciones.
--
-- Devuelve NULL cuando no puede decidir, en vez de inventar un numero: la
-- vista de abajo marca esos casos para que se revisen a mano.
CREATE OR REPLACE FUNCTION public.fn_tamano_del_nombre(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    WITH por_x AS (
        SELECT (REGEXP_MATCH(
                    p_nombre,
                    '\yx\s*([0-9]+(?:[.,][0-9]+)?)\s*(ml|g|gr|tab[a-z]*|c[aá]p[a-z]*|comp[a-z]*|amp[a-z]*|sobres?|unidades?)?',
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
        -- La unidad se normaliza a lo que admite dim_productos.unidad_contenido.
        WHEN LOWER(COALESCE(m[2], '')) = 'ml'            THEN m[1] || ' ml'
        WHEN LOWER(COALESCE(m[2], '')) IN ('g', 'gr')    THEN m[1] || ' g'
        WHEN m[1] = '1'                                  THEN '1 unidad'
        ELSE m[1] || ' unidades'
    END
    FROM elegido;
$$;

-- ----------------------------------------------------------------------------
-- 5. EL CSV LISTO PARA VOLVER A SUBIR
-- ----------------------------------------------------------------------------
-- Las columnas son exactamente las que exporta y lee la pantalla de Productos.
-- Solo productos propios: las filas COMP_* son publicaciones de la competencia
-- migradas por la fase 2 y no forman parte del catalogo.
DROP VIEW IF EXISTS public.v_csv_productos;
CREATE VIEW public.v_csv_productos
WITH (security_invoker = true) AS
SELECT
    p.id_interno,
    COALESCE(public.fn_nombre_sin_dosis(p.nombre), p.nombre) AS nombre,
    COALESCE(p.codigo_barra, '')                             AS codigo_barra,
    -- La molecula no se puede deducir de un nombre de marca ("ESOZ"), asi que
    -- se deja vacia a proposito en vez de adivinarla.
    ''                                                       AS principio_activo,
    COALESCE(public.fn_dosis_del_nombre(p.nombre), '')       AS concentracion,
    COALESCE(
        public.fn_tamano_del_nombre(p.nombre),
        TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p.cantidad_contenido::text))
            || ' ' || p.unidad_contenido
    )                                                        AS tamano,
    l.nombre                                                 AS laboratorio,
    COALESCE(c.nombre, 'Otros')                              AS categoria,
    CASE WHEN COALESCE(un.nombre, '') ILIKE '%pharmetique%'
              OR l.nombre ILIKE '%pharmetique%'
         THEN 'MARCA' ELSE 'GENERICO' END                    AS market_type,
    COALESCE(un.nombre, 'La Sante')                          AS unidad_negocio,
    -- Columnas de ayuda: NO van en el CSV, sirven para revisar antes.
    p.nombre                                                 AS zz_nombre_original,
    TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p.cantidad_contenido::text))
        || ' ' || p.unidad_contenido                         AS zz_empaque_guardado,
    CASE
        WHEN public.fn_tamano_del_nombre(p.nombre) IS NULL
            THEN 'el nombre no dice el empaque: se conserva el guardado'
        -- El flag 'i' no es opcional: sin el, "X 40 G X 7 APLI" no se parte
        -- porque la "x" del nombre va en mayuscula y el patron no coincide.
        WHEN ARRAY_LENGTH(REGEXP_SPLIT_TO_ARRAY(p.nombre, '\yx\s*[0-9]', 'i'), 1) > 2
            THEN 'el nombre menciona mas de un empaque'
    END                                                      AS zz_revisar
FROM public.dim_productos p
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
LEFT JOIN public.dim_categorias c       ON c.id  = p.categoria_id
LEFT JOIN public.dim_unidades_negocio un ON un.id = p.unidad_negocio_id
WHERE p.id_interno NOT LIKE 'COMP\_%'
ORDER BY p.id_interno;

COMMENT ON VIEW public.v_csv_productos IS
'Catalogo propio con el nombre limpio, la dosis y el empaque separados, en las columnas que lee la pantalla de Productos. Las columnas zz_* son de revision y no se suben.';

-- ----------------------------------------------------------------------------
-- 6. v_nombres_redundantes: SEPARAR LA COMPETENCIA
-- ----------------------------------------------------------------------------
-- En la fase 15 las filas COMP_* salian mezcladas con el catalogo propio y
-- confundian: no son productos que se carguen por CSV, son publicaciones de
-- la competencia migradas por la fase 2.
DROP VIEW IF EXISTS public.v_nombres_redundantes;
CREATE VIEW public.v_nombres_redundantes
WITH (security_invoker = true) AS
SELECT
    p.id_interno,
    (p.id_interno LIKE 'COMP\_%') AS es_competidor,
    p.nombre AS nombre_actual,
    public.fn_nombre_sin_dosis(p.nombre) AS nombre_sugerido,
    public.fn_dosis_del_nombre(p.nombre) AS concentracion_sugerida,
    public.fn_tamano_del_nombre(p.nombre) AS tamano_sugerido,
    p.cantidad_contenido,
    p.unidad_contenido,
    (SELECT STRING_AGG(
                pa.nombre || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pp.concentracion_valor::text))
                || ' ' || pp.concentracion_unidad,
                ' + ' ORDER BY pp.es_principal DESC, pa.nombre)
       FROM public.producto_principios pp
       JOIN public.dim_principios_activos pa ON pa.id = pp.principio_activo_id
      WHERE pp.producto_id = p.id) AS principios_registrados,
    l.es_propio
FROM public.dim_productos p
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
WHERE public.fn_nombre_sin_dosis(p.nombre) IS DISTINCT FROM p.nombre
ORDER BY (p.id_interno LIKE 'COMP\_%'), p.nombre;

COMMENT ON VIEW public.v_nombres_redundantes IS
'Productos cuyo nombre repite la dosis o el empaque. es_competidor distingue el catalogo propio de las publicaciones COMP_* migradas por la fase 2.';

-- ----------------------------------------------------------------------------
-- PERMISOS
-- ----------------------------------------------------------------------------
GRANT SELECT ON public.v_csv_productos        TO anon, authenticated;
GRANT SELECT ON public.v_nombres_redundantes  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_quitar_concentracion(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_quitar_empaque(TEXT)       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_dosis_del_nombre(TEXT)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tamano_del_nombre(TEXT)    TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- COMO USARLO
-- ----------------------------------------------------------------------------
/*
-- 1. Revisar lo dudoso ANTES de exportar (deberian ser pocas filas):
SELECT id_interno, zz_nombre_original, nombre, concentracion, tamano,
       zz_empaque_guardado, zz_revisar
FROM v_csv_productos WHERE zz_revisar IS NOT NULL;

-- 2. El CSV para descargar (sin las columnas zz_*):
SELECT id_interno, nombre, codigo_barra, principio_activo, concentracion,
       tamano, laboratorio, categoria, market_type, unidad_negocio
FROM v_csv_productos;
*/
