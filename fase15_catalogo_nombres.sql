-- ============================================================================
-- TRACKFLOW - FASE 15: EL CATALOGO, NO LAS CAPTURAS
-- ============================================================================
-- QUE DESCUBRIO EL DIAGNOSTICO DE LA FASE 13
-- El ensayo marco 738 capturas sospechosas: 649 por nombre y 88 por precio.
-- Al mirar los nombres uno por uno (consulta D2) resulta que NO son paginas
-- rotas ni productos agotados: son nombres de productos perfectamente validos
--
--     "Olmesartan Medoxomil 20 mg La Sante Caja x 30 Tabletas"   x70
--     "Amlodipino 5 mg La Sante Caja x 30 Tabletas"              x39
--     "Rifaximina 400 mg Rixigal Pharmetique Labs Caja x 6 Tab"  x38
--
-- Y cada uno se repite entre 38 y 70 veces, que es aproximadamente el numero
-- de dias de historia. O sea: NO son 649 capturas malas repartidas al azar,
-- son unos POCOS productos cuyo nombre de catalogo no se parece al titulo que
-- publica la tienda, fallando todos los dias desde el primer dia.
--
-- El scraper esta leyendo bien. Lo que esta mal escrito es el catalogo.
--
-- Marcar esas 649 capturas como sospechosas seria tapar el sintoma y ademas
-- borrar historia buena. Lo que hay que arreglar es dim_productos.nombre.
--
-- COMO DEBE CARGARSE EL NOMBRE DE UN PRODUCTO
-- El nombre es SOLO la identidad comercial. La dosis, el tamano del empaque y
-- la molecula tienen su propia columna y el panel las muestra aparte, asi que
-- repetirlas en el nombre las duplica en pantalla:
--
--     MAL   nombre = "Bumetin 300mg x 10tab"
--           -> la tabla pinta "Bumetin 300mg x 10tab | 300 mg | 10 unidad"
--
--     BIEN  nombre                                  = "Bumetin"
--           producto_principios.concentracion_valor = 300  (unidad 'mg')
--           dim_productos.cantidad_contenido        = 10   (unidad 'unidad')
--           -> la tabla pinta "Bumetin | 300 mg | 10 unidad"
--
-- La excepcion son los genericos sin marca, donde la molecula SI es el nombre
-- comercial ("Amlodipino La Sante"). Ahi el nombre lleva la molecula pero
-- sigue sin llevar la dosis ni el empaque.
--
-- Este archivo NO cambia ningun dato. Solo crea tres vistas para ver que hay
-- que corregir y en que orden.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. QUE PRODUCTOS (NO QUE CAPTURAS) TIENEN EL NOMBRE MAL
-- ----------------------------------------------------------------------------
-- Colapsa las capturas fallidas a una fila por producto, con el titulo que mas
-- veces publico la tienda. Esa columna es la respuesta a "entonces, como se
-- llama de verdad": sale del sitio del competidor, no hay que adivinarla.
DROP VIEW IF EXISTS public.v_nombres_a_revisar;
CREATE VIEW public.v_nombres_a_revisar
WITH (security_invoker = true) AS
WITH umbral AS (
    SELECT valor FROM public.config_calidad WHERE clave = 'umbral_similitud_nombre'
),
fallos AS (
    SELECT
        pub.producto_id,
        pub.cadena_id,
        pub.id          AS publicacion_id,
        fp.nombre_capturado
    FROM public.fact_precios fp
    JOIN public.publicaciones pub ON pub.id = fp.publicacion_id
    JOIN public.dim_productos  p  ON p.id  = pub.producto_id
    CROSS JOIN umbral u
    WHERE fp.nombre_capturado IS NOT NULL
      AND word_similarity(LOWER(p.nombre), LOWER(fp.nombre_capturado)) < u.valor
),
agrupado AS (
    SELECT
        producto_id,
        -- mode() devuelve el valor mas frecuente del grupo.
        mode() WITHIN GROUP (ORDER BY nombre_capturado) AS titulo_de_la_tienda,
        COUNT(*)                        AS capturas_afectadas,
        COUNT(DISTINCT publicacion_id)  AS enlaces,
        COUNT(DISTINCT cadena_id)       AS cadenas,
        COUNT(DISTINCT nombre_capturado) AS titulos_distintos
    FROM fallos
    GROUP BY producto_id
)
SELECT
    p.id_interno,
    p.nombre                AS nombre_en_el_catalogo,
    a.titulo_de_la_tienda,
    ROUND(word_similarity(LOWER(p.nombre), LOWER(a.titulo_de_la_tienda))::numeric, 3) AS parecido,
    a.capturas_afectadas,
    a.enlaces,
    a.cadenas,
    a.titulos_distintos,
    l.nombre                AS laboratorio,
    l.es_propio
FROM agrupado a
JOIN public.dim_productos    p ON p.id = a.producto_id
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
ORDER BY a.capturas_afectadas DESC;

COMMENT ON VIEW public.v_nombres_a_revisar IS
'Una fila por producto cuyo nombre de catalogo no coincide con el titulo que publica la tienda. titulo_de_la_tienda es el nombre real a usar.';

-- ----------------------------------------------------------------------------
-- 2. NOMBRES QUE REPITEN LA DOSIS O EL EMPAQUE
-- ----------------------------------------------------------------------------
-- Quita del nombre los pedazos que ya viven en otra columna. El orden importa:
-- primero la concentracion y despues el empaque, porque al reves "500 mg x 12
-- capsulas" se queda pegado como "500 mgcapsulas" y deja de reconocerse.
--
-- Cuidado con dos trampas que costaron un par de intentos:
--   * \y es el limite de palabra en Postgres (\b es un retroceso), y sin el
--     "Cromolox 4%" pierde la x final y queda "Cromolo%".
--   * el limite tras la unidad evita que "5 gotas" se lea como "5 g" + "otas".
CREATE OR REPLACE FUNCTION public.fn_nombre_sin_dosis(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(TRIM(BOTH ' -,.' FROM
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                REGEXP_REPLACE(
                    REGEXP_REPLACE(
                        p_nombre,
                        -- Primero el par "250 mg/5 ml", "50mg/12,5mg",
                        -- "160Mg-12,5Mg", "100/25Mg" (la unidad solo al final)
                        -- y "10 mg/ml" (sin numero tras la barra). Va antes que
                        -- la forma simple para que no se coma solo la primera
                        -- mitad y deje colgando un "/ml".
                        '[0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|ml)?\s*[/-]\s*([0-9]+([.,][0-9]+)?\s*)?(mg|mcg|ug|ui|g|ml|dosis)\y'
                        -- luego la simple: "300mg", "12,5 mg"
                        '|[0-9]+([.,][0-9]+)?\s*(mg|mcg|ug|ui|g|ml)\y'
                        -- y los porcentajes: "4%", "1,4%"
                        '|[0-9]+([.,][0-9]+)?\s*%',
                        ' ', 'gi'),
                    -- "x 10 tab", "caja x 30 tabletas", "x12", "x 6"
                    '\y(caja\s+)?x\s*[0-9]+\s*(tab(letas?|s)?|c[aá]p(sulas?|s)?|comp(rimidos?)?|amp(ollas?)?|sobres?|unidades?|un)?\y'
                    -- y el empaque escrito sin la "x": "14Tabletas". Aqui la
                    -- forma farmaceutica es obligatoria, para no comerse un
                    -- numero que forme parte del nombre ("Complejo B12").
                    '|\y[0-9]+\s*(tab(letas?|s)?|c[aá]p(sulas?|s)?|comp(rimidos?)?|amp(ollas?)?|sobres?)\y',
                    ' ', 'gi'),
                -- separadores que quedan huerfanos al borrar lo de al lado.
                -- El "+" entre dos moleculas SI significa algo ("Losartan +
                -- Hidroclorotiazida"), asi que solo se quita en los bordes.
                '\s+/\s+|\s+[/+]\s*$|^[/+]\s+|\s+x\s*$', ' ', 'gi'),
            '\s{2,}', ' ', 'g')
    ), '');
$$;

COMMENT ON FUNCTION public.fn_nombre_sin_dosis(TEXT) IS
'Propone un nombre comercial sin la dosis ni el tamano del empaque, que ya viven en producto_principios y dim_productos.cantidad_contenido.';

-- La vista solo lista los nombres donde la propuesta cambia algo, y muestra al
-- lado lo que ya estaba guardado aparte para confirmar que no se pierde dato.
DROP VIEW IF EXISTS public.v_nombres_redundantes;
CREATE VIEW public.v_nombres_redundantes
WITH (security_invoker = true) AS
SELECT
    p.id_interno,
    p.nombre AS nombre_actual,
    public.fn_nombre_sin_dosis(p.nombre) AS nombre_sugerido,
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
ORDER BY l.es_propio DESC, p.nombre;

COMMENT ON VIEW public.v_nombres_redundantes IS
'Productos cuyo nombre repite la dosis o el tamano del empaque, que el panel ya muestra en columnas propias. nombre_sugerido es una propuesta a revisar.';

-- ----------------------------------------------------------------------------
-- 3. PRODUCTOS SIN FICHA TECNICA
-- ----------------------------------------------------------------------------
-- El panel lee la molecula y la concentracion de producto_principios. Si un
-- producto no tiene filas ahi, esas columnas salen vacias y la unica forma de
-- saber la dosis vuelve a ser el nombre: es el circulo que hay que romper.
DROP VIEW IF EXISTS public.v_productos_sin_ficha;
CREATE VIEW public.v_productos_sin_ficha
WITH (security_invoker = true) AS
SELECT
    p.id_interno,
    p.nombre,
    l.nombre AS laboratorio,
    l.es_propio,
    p.cantidad_contenido,
    p.unidad_contenido,
    (SELECT COUNT(*) FROM public.publicaciones pub WHERE pub.producto_id = p.id) AS enlaces
FROM public.dim_productos p
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
WHERE NOT EXISTS (
    SELECT 1 FROM public.producto_principios pp WHERE pp.producto_id = p.id
)
ORDER BY l.es_propio DESC, enlaces DESC, p.nombre;

COMMENT ON VIEW public.v_productos_sin_ficha IS
'Productos sin principio activo registrado: el panel no puede mostrarles molecula ni concentracion.';

-- ----------------------------------------------------------------------------
-- PERMISOS
-- ----------------------------------------------------------------------------
-- Supabase ya concede SELECT por defecto sobre lo que se crea en public, pero
-- dejarlo escrito evita depender de esa configuracion. Las tres vistas son
-- security_invoker, asi que ademas siguen respetando las politicas RLS de
-- dim_productos y fact_precios.
GRANT SELECT ON public.v_nombres_a_revisar    TO anon, authenticated;
GRANT SELECT ON public.v_nombres_redundantes  TO anon, authenticated;
GRANT SELECT ON public.v_productos_sin_ficha  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nombre_sin_dosis(TEXT) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- COMO USARLO
-- ----------------------------------------------------------------------------
/*
-- Cuantos PRODUCTOS hay detras de las 649 capturas marcadas por nombre:
SELECT COUNT(*) AS productos, SUM(capturas_afectadas) AS capturas
FROM v_nombres_a_revisar;

-- La lista para corregir, de mayor a menor impacto:
SELECT * FROM v_nombres_a_revisar;

-- Corregir un nombre (uno por uno, revisando el titulo de la tienda antes):
UPDATE dim_productos SET nombre = 'Olmesartan Medoxomil La Sante'
WHERE id_interno = 'P0XX';

-- Nombres que repiten dosis o empaque:
SELECT id_interno, nombre_actual, nombre_sugerido, cantidad_contenido, principios_registrados
FROM v_nombres_redundantes WHERE es_propio;

-- Productos a los que les falta la ficha:
SELECT * FROM v_productos_sin_ficha WHERE es_propio;
*/
