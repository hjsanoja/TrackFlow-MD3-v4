-- ============================================================================
-- TRACKFLOW - DDL FASE 2: MIGRACIÓN Y POBLAMIENTO DE DATOS (fase2_migracion_datos.sql)
-- Migra e inicializa catálogos maestros, productos, equivalencias, publicaciones
-- e histórico de precios desde las tablas legacy hacia el modelo relacional.
-- ============================================================================

SET search_path = public, extensions;

-- 0. AJUSTE DE TAMAÑO PARA IDENTIFICADORES DE COMPETENCIA
-- La vista v_ultimo_precio_valido depende de id_interno, por lo que la eliminamos temporalmente
-- y la recreamos al final de la migración.
DROP VIEW IF EXISTS public.v_ultimo_precio_valido CASCADE;

ALTER TABLE public.dim_productos ALTER COLUMN id_interno TYPE VARCHAR(150);

-- Ajustar funciones de validación para ser compatibles con equivalencias internas (canibalización) y maquila
CREATE OR REPLACE FUNCTION fn_validar_equivalencia_comercial()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_propio_es_propio BOOLEAN;
    v_competidor_es_propio BOOLEAN;
BEGIN
    SELECT (l.es_propio OR COALESCE(un.nombre, '') IN ('La Sante', 'Pharmetique')) INTO v_propio_es_propio
    FROM public.dim_productos p
    JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
    LEFT JOIN public.dim_unidades_negocio un ON un.id = p.unidad_negocio_id
    WHERE p.id = NEW.producto_propio_id;

    SELECT (l.es_propio OR COALESCE(un.nombre, '') IN ('La Sante', 'Pharmetique')) INTO v_competidor_es_propio
    FROM public.dim_productos p
    JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
    LEFT JOIN public.dim_unidades_negocio un ON un.id = p.unidad_negocio_id
    WHERE p.id = NEW.producto_competidor_id;

    -- Si ambos productos son del portafolio propio, clasificar automáticamente como canibalizacion_interna
    IF COALESCE(v_competidor_es_propio, FALSE) THEN
        NEW.tipo_equivalencia := 'canibalizacion_interna';
    ELSIF NEW.tipo_equivalencia IS NULL OR NEW.tipo_equivalencia = 'canibalizacion_interna' THEN
        NEW.tipo_equivalencia := 'bioequivalente';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_validar_pvp_propio()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_es_propio BOOLEAN;
BEGIN
    SELECT (l.es_propio OR COALESCE(un.nombre, '') IN ('La Sante', 'Pharmetique')) INTO v_es_propio
    FROM public.dim_productos p
    JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
    LEFT JOIN public.dim_unidades_negocio un ON un.id = p.unidad_negocio_id
    WHERE p.id = NEW.producto_id;

    IF NOT COALESCE(v_es_propio, FALSE) THEN
        RAISE EXCEPTION 'No se puede registrar PVP Propio para el producto ID % porque no pertenece a un laboratorio propio.', NEW.producto_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 1. POBLAR DIMENSIONES MAESTRAS (CATÁLOGOS)
-- ----------------------------------------------------------------------------

-- 1.1 Cadenas de Farmacias
INSERT INTO public.dim_cadenas (id, nombre, website, color_hex, modulo_scraper, activo)
VALUES 
    ('Farmatodo', 'Farmatodo', 'https://www.farmatodo.com.ve', '#002855', 'farmatodo', TRUE),
    ('Locatel', 'Locatel', 'https://www.locatel.com.ve', '#008752', 'locatel', TRUE),
    ('Saas', 'Farmacias SAAS', 'https://www.farmaciasaas.com', '#E30613', 'farmaciasaas', TRUE),
    ('FarmaDON', 'FarmaDON', 'https://www.farmadon.com', '#F97316', 'farmadon', TRUE),
    ('Grupo San Ignacio', 'Grupo San Ignacio', 'https://www.gruposanignacio.com', '#10B981', 'grupo_san_ignacio', TRUE),
    ('Farmacias Xana', 'Farmacias Xana', 'https://www.farmaciasxana.com', '#8B5CF6', 'xana', TRUE),
    ('FarmaGo', 'FarmaGo', 'https://www.farmago.com', '#06B6D4', 'farmago', TRUE)
ON CONFLICT (id) DO UPDATE SET 
    nombre = EXCLUDED.nombre,
    website = EXCLUDED.website,
    modulo_scraper = EXCLUDED.modulo_scraper,
    activo = EXCLUDED.activo;

-- 1.2 Laboratorios (Identificando propios: LA SANTE, PHARMETIQUE)
INSERT INTO public.dim_laboratorios (nombre, es_propio, activo)
VALUES 
    ('LA SANTE', TRUE, TRUE),
    ('PHARMETIQUE', TRUE, TRUE),
    ('PHARMETIQUELABS', TRUE, TRUE),
    ('CALOX', FALSE, TRUE),
    ('LETI', FALSE, TRUE),
    ('ELMOR', FALSE, TRUE),
    ('FARMA', FALSE, TRUE),
    ('LABORATORIOS FARMA', FALSE, TRUE),
    ('GENVEN', FALSE, TRUE),
    ('MEGALABS', FALSE, TRUE),
    ('ROEMMERS', FALSE, TRUE),
    ('ROWE', FALSE, TRUE),
    ('FC PHARMA', FALSE, TRUE),
    ('BIOTECH', FALSE, TRUE),
    ('BEHRENS', FALSE, TRUE),
    ('NORMON', FALSE, TRUE),
    ('MEYER', FALSE, TRUE),
    ('OFTALMI', FALSE, TRUE),
    ('POEN', FALSE, TRUE),
    ('ALESS', FALSE, TRUE),
    ('ANGELUS', FALSE, TRUE),
    ('AVPHARMA', FALSE, TRUE),
    ('BLUEPHARMA', FALSE, TRUE),
    ('COFASA', FALSE, TRUE),
    ('DAC55', FALSE, TRUE),
    ('DOLLDER', FALSE, TRUE),
    ('ELEA', FALSE, TRUE),
    ('GIEMPI', FALSE, TRUE),
    ('GSK', FALSE, TRUE),
    ('KIMICEG', FALSE, TRUE),
    ('LAPROFF', FALSE, TRUE),
    ('MEDIGEN', FALSE, TRUE),
    ('OVEROL', FALSE, TRUE),
    ('PLUSANDEX', FALSE, TRUE),
    ('POLINAC', FALSE, TRUE),
    ('PSICOFARMA', FALSE, TRUE),
    ('REMENY', FALSE, TRUE),
    ('RONAVA', FALSE, TRUE),
    ('SNC PHARMA', FALSE, TRUE),
    ('UNIPHARMA', FALSE, TRUE),
    ('VALMOR', FALSE, TRUE),
    ('VALMORCA', FALSE, TRUE),
    ('VIVAX', FALSE, TRUE),
    ('ZORIAK', FALSE, TRUE),
    ('OTRO', FALSE, TRUE)
ON CONFLICT (nombre) DO UPDATE SET 
    es_propio = EXCLUDED.es_propio;

-- Insertar cualquier otro laboratorio que esté en productos o productos_competencia
INSERT INTO public.dim_laboratorios (nombre, es_propio, activo)
SELECT DISTINCT UPPER(TRIM(laboratorio)), FALSE, TRUE
FROM public.productos
WHERE laboratorio IS NOT NULL AND TRIM(laboratorio) <> ''
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO public.dim_laboratorios (nombre, es_propio, activo)
SELECT DISTINCT UPPER(TRIM(laboratorio)), FALSE, TRUE
FROM public.productos_competencia
WHERE laboratorio IS NOT NULL AND TRIM(laboratorio) <> ''
ON CONFLICT (nombre) DO NOTHING;

-- Asegurar que los propios sigan marcados como es_propio = TRUE
UPDATE public.dim_laboratorios 
SET es_propio = TRUE 
WHERE nombre IN ('LA SANTE', 'PHARMETIQUE', 'PHARMETIQUELABS');

-- 1.3 Categorías
INSERT INTO public.dim_categorias (nombre, descripcion, activo)
VALUES 
    ('Otros', 'Categoría general', TRUE),
    ('Analgesicos', 'Analgésicos y antiinflamatorios', TRUE),
    ('Antibioticos', 'Antibióticos y antibacterianos', TRUE),
    ('Cardiovascular', 'Tratamientos cardiovasculares', TRUE),
    ('Gastrointestinal', 'Tratamientos gastrointestinales', TRUE),
    ('Respiratorio', 'Tratamientos respiratorios', TRUE)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO public.dim_categorias (nombre, descripcion, activo)
SELECT DISTINCT TRIM(categoria), 'Categoría migrada', TRUE
FROM public.productos
WHERE categoria IS NOT NULL AND TRIM(categoria) <> ''
ON CONFLICT (nombre) DO NOTHING;

-- 1.4 Unidades de Negocio
INSERT INTO public.dim_unidades_negocio (nombre, activo)
VALUES 
    ('La Sante', TRUE),
    ('Pharmetique', TRUE),
    ('OTC', TRUE),
    ('Genéricos', TRUE),
    ('Prescripción', TRUE)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO public.dim_unidades_negocio (nombre, activo)
SELECT DISTINCT TRIM(unidad_negocio), TRUE
FROM public.productos
WHERE unidad_negocio IS NOT NULL AND TRIM(unidad_negocio) <> ''
ON CONFLICT (nombre) DO NOTHING;

-- 1.5 Formas Farmacéuticas
INSERT INTO public.dim_formas_farmaceuticas (nombre, activo)
VALUES 
    ('Tabletas', TRUE),
    ('Cápsulas', TRUE),
    ('Jarabe', TRUE),
    ('Suspensión', TRUE),
    ('Solución', TRUE),
    ('Crema', TRUE),
    ('Ungüento', TRUE),
    ('Gotas', TRUE),
    ('Inyectable', TRUE),
    ('Polvo', TRUE),
    ('Óvulo', TRUE),
    ('Otro', TRUE)
ON CONFLICT (nombre) DO NOTHING;

-- 1.6 Tipos de Promoción
INSERT INTO public.dim_tipos_promocion (codigo, nombre, unidades_lleva, unidades_paga)
VALUES 
    ('sin_promocion', 'Sin Promoción', 1, 1),
    ('descuento_directo', 'Descuento Directo', 1, 1),
    ('2x1', 'Lleva 2 Paga 1 (2x1)', 2, 1),
    ('3x2', 'Lleva 3 Paga 2 (3x2)', 3, 2),
    ('segunda_unidad_descuento', 'Segunda unidad con descuento', 2, 1.5)
ON CONFLICT (codigo) DO NOTHING;

-- 1.7 Tasas BCV Históricas
INSERT INTO public.dim_tasa_bcv (fecha, tasa, fuente)
SELECT 
    (updated_at AT TIME ZONE 'America/Caracas')::date AS fecha,
    ROUND(AVG(value)::numeric, 4) AS tasa,
    'BCV' AS fuente
FROM public.bcv_rates
WHERE value > 0 AND updated_at IS NOT NULL
GROUP BY (updated_at AT TIME ZONE 'America/Caracas')::date
ON CONFLICT (fecha) DO UPDATE SET tasa = EXCLUDED.tasa;

-- Asegurar al menos la tasa del día de hoy si no existía
INSERT INTO public.dim_tasa_bcv (fecha, tasa, fuente)
SELECT CURRENT_DATE, COALESCE((SELECT tasa FROM public.dim_tasa_bcv ORDER BY fecha DESC LIMIT 1), 850.0000), 'BCV'
ON CONFLICT (fecha) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. MIGRAR PRODUCTOS PROPIOS A DIM_PRODUCTOS
-- ----------------------------------------------------------------------------

-- Función auxiliar para parsear cantidad y unidad
CREATE OR REPLACE FUNCTION public.fn_parse_tamano(p_tamano TEXT, OUT o_cant NUMERIC, OUT o_unidad VARCHAR)
AS $$
DECLARE
    v_clean TEXT := UPPER(TRIM(COALESCE(p_tamano, '')));
    v_match TEXT[];
BEGIN
    o_cant := 1;
    o_unidad := 'unidad';
    
    IF v_clean = '' THEN
        RETURN;
    END IF;

    -- Detectar ML
    IF v_clean ~ '([0-9]+(\.[0-9]+)?)\s*ML' THEN
        v_match := regexp_matches(v_clean, '([0-9]+(\.[0-9]+)?)\s*ML');
        o_cant := v_match[1]::NUMERIC;
        o_unidad := 'ml';
        RETURN;
    END IF;

    -- Detectar G / GR
    IF v_clean ~ '([0-9]+(\.[0-9]+)?)\s*(G|GR)' THEN
        v_match := regexp_matches(v_clean, '([0-9]+(\.[0-9]+)?)\s*(G|GR)');
        o_cant := v_match[1]::NUMERIC;
        o_unidad := 'g';
        RETURN;
    END IF;

    -- Detectar Tabletas / Cápsulas / Unidades
    IF v_clean ~ '([0-9]+)' THEN
        v_match := regexp_matches(v_clean, '([0-9]+)');
        o_cant := v_match[1]::NUMERIC;
        o_unidad := 'unidad';
        RETURN;
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Insertar productos propios desde public.productos
INSERT INTO public.dim_productos (
    id_interno,
    codigo_barra,
    nombre,
    laboratorio_id,
    categoria_id,
    unidad_negocio_id,
    forma_farmaceutica_id,
    cantidad_contenido,
    unidad_contenido,
    activo
)
SELECT 
    p.id_interno,
    NULLIF(TRIM(p.codigo_barra), ''),
    TRIM(p.nombre),
    lab.id AS laboratorio_id,
    cat.id AS categoria_id,
    un.id AS unidad_negocio_id,
    ff.id AS forma_farmaceutica_id,
    COALESCE(pt.o_cant, 1),
    COALESCE(pt.o_unidad, 'unidad'),
    COALESCE(p.activo, TRUE)
FROM public.productos p
JOIN public.dim_laboratorios lab ON lab.nombre = UPPER(TRIM(COALESCE(NULLIF(p.laboratorio, ''), 'LA SANTE')))
LEFT JOIN public.dim_categorias cat ON cat.nombre = TRIM(COALESCE(NULLIF(p.categoria, ''), 'Otros'))
LEFT JOIN public.dim_unidades_negocio un ON un.nombre = TRIM(COALESCE(NULLIF(p.unidad_negocio, ''), 'La Sante'))
CROSS JOIN LATERAL public.fn_parse_tamano(p.tamano) pt
CROSS JOIN LATERAL (
    SELECT id FROM public.dim_formas_farmaceuticas 
    WHERE nombre = CASE 
        WHEN UPPER(p.nombre) LIKE '%TAB%' OR UPPER(p.tamano) LIKE '%TAB%' THEN 'Tabletas'
        WHEN UPPER(p.nombre) LIKE '%CAP%' THEN 'Cápsulas'
        WHEN UPPER(p.nombre) LIKE '%JBE%' OR UPPER(p.nombre) LIKE '%JARABE%' THEN 'Jarabe'
        WHEN UPPER(p.nombre) LIKE '%SUSP%' THEN 'Suspensión'
        WHEN UPPER(p.nombre) LIKE '%SOL%' THEN 'Solución'
        WHEN UPPER(p.nombre) LIKE '%CRM%' OR UPPER(p.nombre) LIKE '%CREMA%' THEN 'Crema'
        ELSE 'Otro'
    END
    LIMIT 1
) ff
ON CONFLICT (id_interno) DO UPDATE SET 
    nombre = EXCLUDED.nombre,
    codigo_barra = EXCLUDED.codigo_barra,
    laboratorio_id = EXCLUDED.laboratorio_id,
    categoria_id = EXCLUDED.categoria_id,
    unidad_negocio_id = EXCLUDED.unidad_negocio_id,
    forma_farmaceutica_id = EXCLUDED.forma_farmaceutica_id,
    cantidad_contenido = EXCLUDED.cantidad_contenido,
    unidad_contenido = EXCLUDED.unidad_contenido,
    activo = EXCLUDED.activo;

-- ----------------------------------------------------------------------------
-- 3. MIGRAR PRODUCTOS COMPETIDORES (ALTERNATIVAS) A DIM_PRODUCTOS
-- ----------------------------------------------------------------------------
INSERT INTO public.dim_productos (
    id_interno,
    codigo_barra,
    nombre,
    laboratorio_id,
    categoria_id,
    unidad_negocio_id,
    forma_farmaceutica_id,
    cantidad_contenido,
    unidad_contenido,
    activo
)
SELECT DISTINCT ON ('COMP_' || pc.id)
    'COMP_' || pc.id AS id_interno,
    NULL AS codigo_barra,
    SUBSTRING(TRIM(COALESCE(NULLIF(pc.ultimo_nombre, ''), NULLIF(pc.marca, ''), 'Producto Competidor')) FROM 1 FOR 255) AS nombre,
    COALESCE(lab.id, (SELECT id FROM public.dim_laboratorios WHERE nombre = 'OTRO')) AS laboratorio_id,
    (SELECT id FROM public.dim_categorias WHERE nombre = 'Otros') AS categoria_id,
    (SELECT id FROM public.dim_unidades_negocio WHERE nombre = 'La Sante') AS unidad_negocio_id,
    (SELECT id FROM public.dim_formas_farmaceuticas WHERE nombre = 'Otro') AS forma_farmaceutica_id,
    COALESCE(pt.o_cant, 1),
    COALESCE(pt.o_unidad, 'unidad'),
    COALESCE(pc.activo, TRUE)
FROM public.productos_competencia pc
LEFT JOIN public.dim_laboratorios lab ON lab.nombre = UPPER(TRIM(pc.laboratorio))
CROSS JOIN LATERAL public.fn_parse_tamano(pc.tamano) pt
WHERE pc.tipo = 'alternativa'
ON CONFLICT (id_interno) DO UPDATE SET 
    nombre = EXCLUDED.nombre,
    laboratorio_id = EXCLUDED.laboratorio_id,
    activo = EXCLUDED.activo;

-- ----------------------------------------------------------------------------
-- 4. POBLAR EQUIVALENCIAS COMERCIALES
-- ----------------------------------------------------------------------------
INSERT INTO public.producto_equivalencias (
    producto_propio_id,
    producto_competidor_id,
    tipo_equivalencia,
    activo
)
SELECT DISTINCT
    p_propio.id AS producto_propio_id,
    p_comp.id AS producto_competidor_id,
    CASE 
        WHEN (lab_comp.es_propio OR COALESCE(un_comp.nombre, '') IN ('La Sante', 'Pharmetique')) THEN 'canibalizacion_interna'
        ELSE 'bioequivalente'
    END AS tipo_equivalencia,
    TRUE AS activo
FROM public.productos_competencia pc
JOIN public.dim_productos p_propio ON p_propio.id_interno = pc.id_producto_propio
JOIN public.dim_productos p_comp ON p_comp.id_interno = ('COMP_' || pc.id)
JOIN public.dim_laboratorios lab_comp ON lab_comp.id = p_comp.laboratorio_id
LEFT JOIN public.dim_unidades_negocio un_comp ON un_comp.id = p_comp.unidad_negocio_id
WHERE pc.tipo = 'alternativa'
  AND p_propio.id <> p_comp.id
ON CONFLICT (producto_propio_id, producto_competidor_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. POBLAR PUBLICACIONES (URLs DE SCRAPING)
-- ----------------------------------------------------------------------------
INSERT INTO public.publicaciones (
    producto_id,
    cadena_id,
    url,
    url_normalizada,
    sku_cadena,
    activo
)
SELECT DISTINCT ON (c.id, LOWER(REGEXP_REPLACE(TRIM(pc.url), '\?.*$', '')))
    CASE 
        WHEN pc.tipo = 'propio' THEN p_propio.id
        ELSE p_comp.id
    END AS producto_id,
    c.id AS cadena_id,
    TRIM(pc.url) AS url,
    LOWER(REGEXP_REPLACE(TRIM(pc.url), '\?.*$', '')) AS url_normalizada,
    SUBSTRING(pc.url FROM '/producto/([0-9]+)') AS sku_cadena,
    COALESCE(pc.activo, TRUE) AS activo
FROM public.productos_competencia pc
JOIN public.dim_cadenas c ON c.id = pc.cadena OR c.nombre = pc.cadena
LEFT JOIN public.dim_productos p_propio ON p_propio.id_interno = pc.id_producto_propio
LEFT JOIN public.dim_productos p_comp ON p_comp.id_interno = ('COMP_' || pc.id)
WHERE pc.url IS NOT NULL 
  AND TRIM(pc.url) <> ''
  AND (
      (pc.tipo = 'propio' AND p_propio.id IS NOT NULL) OR 
      (pc.tipo <> 'propio' AND p_comp.id IS NOT NULL)
  )
ON CONFLICT (cadena_id, url_normalizada) DO UPDATE SET 
    producto_id = EXCLUDED.producto_id,
    url = EXCLUDED.url,
    sku_cadena = EXCLUDED.sku_cadena,
    activo = EXCLUDED.activo;

-- ----------------------------------------------------------------------------
-- 6. MIGRAR HISTÓRICO DE PRECIOS (HISTORICO_PRECIOS -> FACT_PRECIOS)
-- ----------------------------------------------------------------------------
-- Usamos 'legacy' en origen para que los triggers de calidad no emitan sospechas erróneas
INSERT INTO public.fact_precios (
    publicacion_id,
    scrape_run_id,
    fecha_captura,
    precio_full_bs,
    precio_desc_bs,
    tasa_bcv,
    tasa_origen,
    disponible,
    estado,
    nombre_capturado,
    tiene_promocion,
    origen
)
SELECT 
    pub.id AS publicacion_id,
    NULL AS scrape_run_id,
    hp.scraped_at AS fecha_captura,
    hp.precio_full_bs,
    hp.precio_desc_bs,
    COALESCE(
        tasa_dia.tasa,
        (SELECT tasa FROM public.dim_tasa_bcv ORDER BY ABS(EXTRACT(EPOCH FROM (fecha::timestamp - hp.scraped_at))) LIMIT 1),
        850.0000
    ) AS tasa_bcv,
    'bcv_del_dia' AS tasa_origen,
    TRUE AS disponible,
    'ok' AS estado,
    TRIM(hp.nombre) AS nombre_capturado,
    COALESCE(hp.tiene_descuento, FALSE) AS tiene_promocion,
    'legacy' AS origen
FROM public.historico_precios hp
JOIN public.productos_competencia pc ON pc.id = hp.prod_comp_id
JOIN public.publicaciones pub ON pub.cadena_id = pc.cadena 
    AND pub.url_normalizada = LOWER(REGEXP_REPLACE(TRIM(pc.url), '\?.*$', ''))
LEFT JOIN public.dim_tasa_bcv tasa_dia ON tasa_dia.fecha = (hp.scraped_at AT TIME ZONE 'America/Caracas')::date
WHERE (hp.precio_full_bs > 0 OR hp.precio_desc_bs > 0)
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. REGISTRAR PVP PROPIO BASE
-- ----------------------------------------------------------------------------
-- Para todos los productos propios, asignamos un PVP base si no tienen vigencia
INSERT INTO public.pvp_propio (producto_id, pvp_usd, vigente_desde, vigente_hasta)
SELECT 
    p.id AS producto_id,
    1.00 AS pvp_usd,
    '2026-01-01'::date AS vigente_desde,
    NULL::date AS vigente_hasta
FROM public.dim_productos p
JOIN public.dim_laboratorios l ON l.id = p.laboratorio_id
LEFT JOIN public.dim_unidades_negocio un ON un.id = p.unidad_negocio_id
WHERE (l.es_propio = TRUE OR COALESCE(un.nombre, '') IN ('La Sante', 'Pharmetique'))
  AND NOT EXISTS (
      SELECT 1 FROM public.pvp_propio pv WHERE pv.producto_id = p.id
  )
ON CONFLICT DO NOTHING;

-- Limpieza de la función temporal auxiliar
DROP FUNCTION IF EXISTS public.fn_parse_tamano(TEXT);

-- ----------------------------------------------------------------------------
-- 8. RECREAR LA VISTA ANALÍTICA V_ULTIMO_PRECIO_VALIDO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_ultimo_precio_valido 
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (fp.publicacion_id)
    fp.id AS fact_precio_id,
    fp.publicacion_id,
    pub.producto_id,
    pub.cadena_id,
    p.id_interno,
    p.nombre AS producto_nombre,
    lab.nombre AS laboratorio_nombre,
    lab.es_propio,
    m.nombre AS marca_nombre,
    pub.url,
    fp.fecha_captura,
    (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date AS fecha_local,
    ((NOW() AT TIME ZONE 'America/Caracas')::date - (fp.fecha_captura AT TIME ZONE 'America/Caracas')::date) AS dias_antiguedad,
    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_vigente_bs,
    ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv), 2) AS precio_vigente_usd,
    fp.tasa_bcv,
    fp.tiene_promocion,
    tp.codigo AS tipo_promocion_codigo,
    fp.promo_texto_raw,
    ROUND(
        (COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv) * 
        (COALESCE(tp.unidades_paga, 1) / COALESCE(tp.unidades_lleva, 1)), 
        2
    ) AS precio_efectivo_unidad_usd
FROM public.fact_precios fp
JOIN public.publicaciones pub ON pub.id = fp.publicacion_id
JOIN public.dim_productos p ON p.id = pub.producto_id
JOIN public.dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN public.dim_marcas m ON m.id = p.marca_id
LEFT JOIN public.dim_tipos_promocion tp ON tp.id = fp.tipo_promocion_id
WHERE fp.estado = 'ok'
  AND NOT fp.sospechoso
  AND fp.disponible = TRUE
ORDER BY fp.publicacion_id, fp.fecha_captura DESC;
