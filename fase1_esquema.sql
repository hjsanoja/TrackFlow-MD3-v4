-- ============================================================================
-- TRACKFLOW - DDL FASE 1: ESQUEMA, TRIGGERS Y VISTAS (fase1_esquema.sql)
-- ============================================================================
-- ORDEN DE EJECUCIÓN:
-- 1. Ejecutar este archivo PRIMERO en el SQL Editor de Supabase.
-- 2. No afecta a las tablas viejas ni a la aplicación actual.
-- 3. No contiene políticas RLS (las políticas van en fase1_rls.sql tras validar login).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C5. CONSULTA DE PRE-CHEQUEO (Ejecutar previamente de forma aislada si se desea)
-- ----------------------------------------------------------------------------
-- NOTA: "CREATE TABLE IF NOT EXISTS" no altera tablas que ya existan con esquemas
-- previos. Ejecuta esta consulta antes de correr el script para verificar colisiones:
/*
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN (
    'dim_cadenas', 'dim_laboratorios', 'dim_marcas', 'dim_categorias',
    'dim_unidades_negocio', 'dim_formas_farmaceuticas', 'dim_tipos_promocion',
    'dim_principios_activos', 'dim_tasa_bcv', 'scrape_runs', 'dim_productos',
    'producto_principios', 'pvp_propio', 'producto_equivalencias',
    'publicaciones', 'fact_precios', 'config_calidad', 'audit_log'
  );
*/

-- ----------------------------------------------------------------------------
-- C1. EXTENSIONES EN EL ESQUEMA CORRECTO (extensions)
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. CATÁLOGOS MAESTROS (DIMENSIONES PURAS)
-- ----------------------------------------------------------------------------

-- Cadenas de farmacias monitoreadas
CREATE TABLE IF NOT EXISTS public.dim_cadenas (
    id VARCHAR(50) PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    website VARCHAR(255),
    color_hex VARCHAR(7) DEFAULT '#3B82F6',
    modulo_scraper VARCHAR(50),
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Laboratorios farmacéuticos / Fabricantes
CREATE TABLE IF NOT EXISTS public.dim_laboratorios (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL UNIQUE,
    es_propio BOOLEAN NOT NULL DEFAULT FALSE,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Marcas comerciales
CREATE TABLE IF NOT EXISTS public.dim_marcas (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    laboratorio_id BIGINT NOT NULL REFERENCES dim_laboratorios(id) ON DELETE RESTRICT,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    CONSTRAINT uq_marca_laboratorio UNIQUE (nombre, laboratorio_id)
);

-- Categorías terapéuticas
CREATE TABLE IF NOT EXISTS public.dim_categorias (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Unidades de negocio internas
CREATE TABLE IF NOT EXISTS public.dim_unidades_negocio (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Formas farmacéuticas estandarizadas
CREATE TABLE IF NOT EXISTS public.dim_formas_farmaceuticas (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- B7. Tipos de promociones detectables con cálculo atómico
CREATE TABLE IF NOT EXISTS public.dim_tipos_promocion (
    id BIGSERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    unidades_lleva NUMERIC NOT NULL DEFAULT 1 CHECK (unidades_lleva > 0),
    unidades_paga NUMERIC NOT NULL DEFAULT 1 CHECK (unidades_paga > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Principios activos (DCI) con sinónimos
CREATE TABLE IF NOT EXISTS public.dim_principios_activos (
    id BIGSERIAL PRIMARY KEY,
    nombre_dci VARCHAR(150) NOT NULL UNIQUE,
    sinonimos TEXT[] DEFAULT '{}',
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- Tasas de cambio oficiales diarias
CREATE TABLE IF NOT EXISTS public.dim_tasa_bcv (
    fecha DATE PRIMARY KEY,
    tasa NUMERIC(12, 4) NOT NULL CHECK (tasa > 0),
    fuente VARCHAR(50) DEFAULT 'BCV',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

-- B1. Manejo de compatibilidad: Si existe la tabla scrape_runs antigua de Firestore (cuya PK era 'run_id' y no 'id'),
-- la renombramos a 'scrape_runs_legacy' para preservar sus datos históricos y permitir que el nuevo esquema
-- cree la tabla normalizada con PK UUID id.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'scrape_runs'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'scrape_runs' AND column_name = 'id'
    ) THEN
        ALTER TABLE public.scrape_runs RENAME TO scrape_runs_legacy;
    END IF;
END $$;

-- B1. Registro de ejecuciones de Scraping (PK UUID)
CREATE TABLE IF NOT EXISTS public.scrape_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_run_id VARCHAR(100),
    cadena_id VARCHAR(50) NOT NULL REFERENCES dim_cadenas(id) ON DELETE RESTRICT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    finished_at TIMESTAMPTZ,
    total_urls INT DEFAULT 0,
    exitosos INT DEFAULT 0,
    fallidos INT DEFAULT 0,
    estado VARCHAR(30) NOT NULL DEFAULT 'en_proceso' CHECK (estado IN ('en_proceso', 'completada', 'fallida', 'parcial')),
    trigger_tipo VARCHAR(30) NOT NULL DEFAULT 'cron' CHECK (trigger_tipo IN ('cron', 'manual', 'dispatch'))
);

-- ----------------------------------------------------------------------------
-- 2. ENTIDADES PRINCIPALES (PRODUCTOS Y RELACIONES)
-- ----------------------------------------------------------------------------

-- Catálogo Maestro de Productos (Propios y de la Competencia)
CREATE TABLE IF NOT EXISTS public.dim_productos (
    id BIGSERIAL PRIMARY KEY,
    id_interno VARCHAR(150) NOT NULL UNIQUE, -- C3: UNIQUE ya crea el índice
    codigo_barra VARCHAR(50),
    nombre VARCHAR(255) NOT NULL,
    marca_id BIGINT REFERENCES dim_marcas(id) ON DELETE RESTRICT,
    laboratorio_id BIGINT NOT NULL REFERENCES dim_laboratorios(id) ON DELETE RESTRICT,
    categoria_id BIGINT REFERENCES dim_categorias(id) ON DELETE RESTRICT,
    unidad_negocio_id BIGINT REFERENCES dim_unidades_negocio(id) ON DELETE RESTRICT,
    forma_farmaceutica_id BIGINT REFERENCES dim_formas_farmaceuticas(id) ON DELETE RESTRICT,
    
    -- Contenido atómico (para unidosis exacta)
    cantidad_contenido NUMERIC(10, 2) NOT NULL CHECK (cantidad_contenido > 0),
    unidad_contenido VARCHAR(20) NOT NULL CHECK (unidad_contenido IN ('unidad', 'ml', 'g')),
    
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()  -- A1: UTC
);

CREATE INDEX IF NOT EXISTS idx_productos_laboratorio ON dim_productos(laboratorio_id);

-- Principios activos por producto (Relación N:M atómica para concentraciones)
CREATE TABLE IF NOT EXISTS public.producto_principios (
    id BIGSERIAL PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE CASCADE,
    principio_activo_id BIGINT NOT NULL REFERENCES dim_principios_activos(id) ON DELETE RESTRICT,
    concentracion_valor NUMERIC(10, 2) NOT NULL CHECK (concentracion_valor > 0),
    concentracion_unidad VARCHAR(20) NOT NULL CHECK (concentracion_unidad IN ('mg', 'g', 'mcg', 'UI', '%')),
    por_cantidad NUMERIC(10, 2) DEFAULT 1 CHECK (por_cantidad > 0),
    por_unidad VARCHAR(20) CHECK (por_unidad IN ('ml', 'g', 'dosis')),
    es_principal BOOLEAN NOT NULL DEFAULT FALSE, -- B3
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    CONSTRAINT uq_producto_principio UNIQUE (producto_id, principio_activo_id)
);

-- B3. Índice único parcial: máximo un principio activo rector por producto
CREATE UNIQUE INDEX IF NOT EXISTS uq_un_principal_por_producto 
ON producto_principios (producto_id) WHERE es_principal;

-- B2. Histórico de PVP Propio con rango temporal sin solapamiento
CREATE TABLE IF NOT EXISTS public.pvp_propio (
    id BIGSERIAL PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE RESTRICT,
    pvp_usd NUMERIC(10, 2) NOT NULL CHECK (pvp_usd >= 0),
    vigente_desde DATE NOT NULL,
    vigente_hasta DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    CONSTRAINT chk_pvp_rango_valido CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
    CONSTRAINT excl_pvp_sin_solape EXCLUDE USING gist (
        producto_id WITH =,
        daterange(vigente_desde, vigente_hasta, '[)') WITH &&
    )
);

-- Tabla de Equivalencias Comerciales (N:M Producto Propio vs Competidor)
CREATE TABLE IF NOT EXISTS public.producto_equivalencias (
    id BIGSERIAL PRIMARY KEY,
    producto_propio_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE RESTRICT,
    producto_competidor_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE RESTRICT,
    tipo_equivalencia VARCHAR(50) NOT NULL CHECK (tipo_equivalencia IN ('misma_molecula', 'bioequivalente', 'terapeutico', 'canibalizacion_interna')),
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    CONSTRAINT chk_equivalencia_distinta CHECK (producto_propio_id <> producto_competidor_id),
    CONSTRAINT uq_equivalencia_par UNIQUE (producto_propio_id, producto_competidor_id)
);

-- Publicaciones / URLs de seguimiento en las Cadenas
CREATE TABLE IF NOT EXISTS public.publicaciones (
    id BIGSERIAL PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE RESTRICT,
    cadena_id VARCHAR(50) NOT NULL REFERENCES dim_cadenas(id) ON DELETE RESTRICT,
    url TEXT NOT NULL,
    url_normalizada TEXT NOT NULL,
    sku_cadena VARCHAR(100),
    activo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- A1: UTC
    CONSTRAINT uq_cadena_url_normalizada UNIQUE (cadena_id, url_normalizada)
);

CREATE INDEX IF NOT EXISTS idx_publicaciones_producto ON publicaciones(producto_id);

-- ----------------------------------------------------------------------------
-- B6. TABLA DE CONFIGURACIÓN DE CALIDAD DE DATOS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.config_calidad (
    clave VARCHAR(50) PRIMARY KEY,
    valor NUMERIC(6, 3) NOT NULL,
    descripcion TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

INSERT INTO config_calidad (clave, valor, descripcion)
VALUES 
    ('umbral_similitud_nombre', 0.400, 'Similitud mínima por word_similarity (0 a 1) para aceptar el nombre'),
    ('umbral_variacion_precio', 0.400, 'Variación máxima relativa permitida (±40%) vs última captura válida')
ON CONFLICT (clave) DO NOTHING;

-- ----------------------------------------------------------------------------
-- C6. TABLA DE AUDITORÍA DE CAMBIOS (AUDIT LOG)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
    id BIGSERIAL PRIMARY KEY,
    tabla VARCHAR(100) NOT NULL,
    registro_id TEXT NOT NULL,
    operacion VARCHAR(20) NOT NULL CHECK (operacion IN ('INSERT', 'UPDATE', 'DELETE')),
    campo VARCHAR(100),
    valor_anterior TEXT,
    valor_nuevo TEXT,
    usuario TEXT,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW() -- A1: UTC
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tabla_registro ON audit_log (tabla, registro_id);

-- ----------------------------------------------------------------------------
-- 3. TABLA DE HECHOS (AUDITORÍA HISTÓRICA INMUTABLE)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fact_precios (
    id BIGSERIAL PRIMARY KEY,
    publicacion_id BIGINT NOT NULL REFERENCES publicaciones(id) ON DELETE RESTRICT,
    scrape_run_id UUID REFERENCES scrape_runs(id) ON DELETE SET NULL, -- B1
    fecha_captura TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- A1: UTC
    
    precio_full_bs NUMERIC(12, 2),
    precio_desc_bs NUMERIC(12, 2),
    
    tasa_bcv NUMERIC(12, 4) NOT NULL CHECK (tasa_bcv > 0),
    tasa_origen VARCHAR(30) NOT NULL DEFAULT 'bcv_del_dia' CHECK (tasa_origen IN ('bcv_del_dia', 'ultima_conocida')),
    
    disponible BOOLEAN NOT NULL DEFAULT TRUE,
    estado VARCHAR(30) NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'no_encontrado', 'error', 'agotado')),
    error_mensaje TEXT,
    
    -- Control de calidad del scraping (A4, B5, B6)
    nombre_capturado TEXT,
    similitud_nombre NUMERIC(4, 3),
    sospechoso BOOLEAN NOT NULL DEFAULT FALSE,
    motivo_sospecha TEXT CHECK (motivo_sospecha IN ('nombre', 'variacion_precio', 'ambos', 'legacy')), -- A4
    revisado_manual BOOLEAN NOT NULL DEFAULT FALSE, -- B5
    
    -- Promociones
    tiene_promocion BOOLEAN NOT NULL DEFAULT FALSE,
    tipo_promocion_id BIGINT REFERENCES dim_tipos_promocion(id) ON DELETE SET NULL,
    promo_texto_raw TEXT,
    
    origen VARCHAR(20) NOT NULL DEFAULT 'scraper' CHECK (origen IN ('scraper', 'manual', 'legacy')),
    
    CONSTRAINT uq_captura_por_corrida UNIQUE (publicacion_id, scrape_run_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_precios_ultimo 
ON fact_precios (publicacion_id, fecha_captura DESC);

CREATE INDEX IF NOT EXISTS idx_fact_precios_fecha 
ON fact_precios (fecha_captura DESC);

-- ----------------------------------------------------------------------------
-- 4. TRIGGERS DE VALIDACIÓN, CALIDAD Y AUDITORÍA (C2: search_path declarada)
-- ----------------------------------------------------------------------------

-- Trigger: updated_at en UTC (A1)
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
BEGIN
    NEW.updated_at = NOW(); -- A1: UTC
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dim_productos_updated_at ON dim_productos;
CREATE TRIGGER trg_dim_productos_updated_at
BEFORE UPDATE ON dim_productos
FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_publicaciones_updated_at ON publicaciones;
CREATE TRIGGER trg_publicaciones_updated_at
BEFORE UPDATE ON publicaciones
FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- B4. Trigger: Validar consistencia laboratorio entre dim_marcas y dim_productos
CREATE OR REPLACE FUNCTION fn_validar_laboratorio_marca()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_marca_lab_id BIGINT;
BEGIN
    IF NEW.marca_id IS NOT NULL THEN
        SELECT laboratorio_id INTO v_marca_lab_id 
        FROM dim_marcas 
        WHERE id = NEW.marca_id;

        IF v_marca_lab_id IS DISTINCT FROM NEW.laboratorio_id THEN
            RAISE EXCEPTION 'Inconsistencia: la marca ID % pertenece al laboratorio %, pero el producto tiene asignado el laboratorio %.',
                NEW.marca_id, v_marca_lab_id, NEW.laboratorio_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_laboratorio_marca ON dim_productos;
CREATE TRIGGER trg_validar_laboratorio_marca
BEFORE INSERT OR UPDATE ON dim_productos
FOR EACH ROW EXECUTE FUNCTION fn_validar_laboratorio_marca();

-- Trigger: Validar que PVP Propio solo aplique a productos de laboratorios propios
CREATE OR REPLACE FUNCTION fn_validar_pvp_propio()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_es_propio BOOLEAN;
BEGIN
    SELECT l.es_propio INTO v_es_propio
    FROM dim_productos p
    JOIN dim_laboratorios l ON l.id = p.laboratorio_id
    WHERE p.id = NEW.producto_id;

    IF NOT COALESCE(v_es_propio, FALSE) THEN
        RAISE EXCEPTION 'No se puede registrar PVP Propio para el producto ID % porque no pertenece a un laboratorio propio.', NEW.producto_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_pvp_propio ON pvp_propio;
CREATE TRIGGER trg_validar_pvp_propio
BEFORE INSERT OR UPDATE ON pvp_propio
FOR EACH ROW EXECUTE FUNCTION fn_validar_pvp_propio();

-- Trigger: Validar dirección y sentido de equivalencias comerciales
CREATE OR REPLACE FUNCTION fn_validar_equivalencia_comercial()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_propio_es_propio BOOLEAN;
    v_competidor_es_propio BOOLEAN;
BEGIN
    SELECT l.es_propio INTO v_propio_es_propio
    FROM dim_productos p
    JOIN dim_laboratorios l ON l.id = p.laboratorio_id
    WHERE p.id = NEW.producto_propio_id;

    SELECT l.es_propio INTO v_competidor_es_propio
    FROM dim_productos p
    JOIN dim_laboratorios l ON l.id = p.laboratorio_id
    WHERE p.id = NEW.producto_competidor_id;

    IF NOT COALESCE(v_propio_es_propio, FALSE) THEN
        RAISE EXCEPTION 'El producto_propio_id (%) debe pertenecer a un laboratorio propio.', NEW.producto_propio_id;
    END IF;

    IF v_competidor_es_propio AND NEW.tipo_equivalencia <> 'canibalizacion_interna' THEN
        RAISE EXCEPTION 'Si ambos productos son propios, el tipo_equivalencia debe ser "canibalizacion_interna".';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_equivalencia ON producto_equivalencias;
CREATE TRIGGER trg_validar_equivalencia
BEFORE INSERT OR UPDATE ON producto_equivalencias
FOR EACH ROW EXECUTE FUNCTION fn_validar_equivalencia_comercial();

-- A4, B5, B6, 3.3. Trigger de Control de Calidad del Scraping (Solo BEFORE INSERT)
CREATE OR REPLACE FUNCTION fn_control_calidad_precio()
RETURNS TRIGGER 
SET search_path = public, extensions
AS $$
DECLARE
    v_nombre_esperado TEXT;
    v_similitud NUMERIC;
    v_umbral_similitud NUMERIC;
    v_umbral_variacion NUMERIC;
    v_ultimo_precio NUMERIC;
    v_precio_actual NUMERIC;
    v_variacion NUMERIC;
    v_falla_nombre BOOLEAN := FALSE;
    v_falla_precio BOOLEAN := FALSE;
BEGIN
    -- 3.3. Si el registro proviene de migración de histórico, retornar sin evaluación
    IF NEW.origen = 'legacy' THEN
        RETURN NEW;
    END IF;

    -- B5. Si fue revisado manualmente, no alterar
    IF NEW.revisado_manual THEN
        RETURN NEW;
    END IF;

    -- Leer umbrales configurables (B6)
    SELECT valor INTO v_umbral_similitud FROM config_calidad WHERE clave = 'umbral_similitud_nombre';
    SELECT valor INTO v_umbral_variacion FROM config_calidad WHERE clave = 'umbral_variacion_precio';
    v_umbral_similitud := COALESCE(v_umbral_similitud, 0.40);
    v_umbral_variacion := COALESCE(v_umbral_variacion, 0.40);

    -- 1. Control por Nombre usando word_similarity (B6)
    IF NEW.nombre_capturado IS NOT NULL AND NEW.estado = 'ok' THEN
        SELECT TRIM(COALESCE(m.nombre, '') || ' ' || p.nombre) INTO v_nombre_esperado
        FROM publicaciones pub
        JOIN dim_productos p ON p.id = pub.producto_id
        LEFT JOIN dim_marcas m ON m.id = p.marca_id
        WHERE pub.id = NEW.publicacion_id;

        IF v_nombre_esperado IS NOT NULL AND LENGTH(v_nombre_esperado) > 0 THEN
            v_similitud := word_similarity(LOWER(v_nombre_esperado), LOWER(NEW.nombre_capturado));
            NEW.similitud_nombre := v_similitud;
            IF v_similitud < v_umbral_similitud THEN
                v_falla_nombre := TRUE;
            END IF;
        END IF;
    END IF;

    -- 2. Control por Variación de Precio vs Última Captura Válida (A4)
    v_precio_actual := COALESCE(NEW.precio_desc_bs, NEW.precio_full_bs);
    IF v_precio_actual IS NOT NULL AND v_precio_actual > 0 AND NEW.estado = 'ok' THEN
        SELECT COALESCE(precio_desc_bs, precio_full_bs) INTO v_ultimo_precio
        FROM fact_precios
        WHERE publicacion_id = NEW.publicacion_id
          AND estado = 'ok'
          AND NOT sospechoso
          AND disponible = TRUE
        ORDER BY fecha_captura DESC
        LIMIT 1;

        IF v_ultimo_precio IS NOT NULL AND v_ultimo_precio > 0 THEN
            v_variacion := ABS(v_precio_actual - v_ultimo_precio) / v_ultimo_precio;
            IF v_variacion > v_umbral_variacion THEN
                v_falla_precio := TRUE;
            END IF;
        END IF;
    END IF;

    -- Consolidación de motivos
    IF v_falla_nombre AND v_falla_precio THEN
        NEW.sospechoso := TRUE;
        NEW.motivo_sospecha := 'ambos';
    ELSIF v_falla_nombre THEN
        NEW.sospechoso := TRUE;
        NEW.motivo_sospecha := 'nombre';
    ELSIF v_falla_precio THEN
        NEW.sospechoso := TRUE;
        NEW.motivo_sospecha := 'variacion_precio';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_control_calidad_precio ON fact_precios;
CREATE TRIGGER trg_control_calidad_precio
BEFORE INSERT ON fact_precios -- B5: Exclusivo BEFORE INSERT
FOR EACH ROW EXECUTE FUNCTION fn_control_calidad_precio();

-- 3.1 & 3.2. Trigger Genérico de Auditoría (SECURITY DEFINER + email JWT)
CREATE OR REPLACE FUNCTION fn_audit_log_trigger()
RETURNS TRIGGER 
SECURITY DEFINER -- 3.1
SET search_path = public, extensions -- C2
AS $$
DECLARE
    v_usuario TEXT;
BEGIN
    -- 3.2. Identificar email desde el JWT de Supabase Auth
    v_usuario := COALESCE(auth.jwt() ->> 'email', current_user);

    IF TG_OP = 'UPDATE' THEN
        IF OLD.* IS DISTINCT FROM NEW.* THEN
            INSERT INTO audit_log (tabla, registro_id, operacion, valor_anterior, valor_nuevo, usuario)
            VALUES (TG_TABLE_NAME, OLD.id::TEXT, 'UPDATE', to_jsonb(OLD)::TEXT, to_jsonb(NEW)::TEXT, v_usuario);
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (tabla, registro_id, operacion, valor_anterior, valor_nuevo, usuario)
        VALUES (TG_TABLE_NAME, NEW.id::TEXT, 'INSERT', NULL, to_jsonb(NEW)::TEXT, v_usuario);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log (tabla, registro_id, operacion, valor_anterior, valor_nuevo, usuario)
        VALUES (TG_TABLE_NAME, OLD.id::TEXT, 'DELETE', to_jsonb(OLD)::TEXT, NULL, v_usuario);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_dim_productos ON dim_productos;
CREATE TRIGGER trg_audit_dim_productos AFTER INSERT OR UPDATE OR DELETE ON dim_productos
FOR EACH ROW EXECUTE FUNCTION fn_audit_log_trigger();

DROP TRIGGER IF EXISTS trg_audit_publicaciones ON publicaciones;
CREATE TRIGGER trg_audit_publicaciones AFTER INSERT OR UPDATE OR DELETE ON publicaciones
FOR EACH ROW EXECUTE FUNCTION fn_audit_log_trigger();

DROP TRIGGER IF EXISTS trg_audit_producto_equivalencias ON producto_equivalencias;
CREATE TRIGGER trg_audit_producto_equivalencias AFTER INSERT OR UPDATE OR DELETE ON producto_equivalencias
FOR EACH ROW EXECUTE FUNCTION fn_audit_log_trigger();

DROP TRIGGER IF EXISTS trg_audit_pvp_propio ON pvp_propio;
CREATE TRIGGER trg_audit_pvp_propio AFTER INSERT OR UPDATE OR DELETE ON pvp_propio
FOR EACH ROW EXECUTE FUNCTION fn_audit_log_trigger();

-- B2. Función Auxiliar: Obtener PVP Propio Vigente en una Fecha
CREATE OR REPLACE FUNCTION fn_get_pvp_propio_vigente(p_producto_id BIGINT, p_fecha DATE DEFAULT CURRENT_DATE)
RETURNS NUMERIC
SET search_path = public, extensions
AS $$
DECLARE
    v_pvp NUMERIC(10, 2);
BEGIN
    SELECT pvp_usd INTO v_pvp
    FROM pvp_propio
    WHERE producto_id = p_producto_id
      AND vigente_desde <= p_fecha
      AND (vigente_hasta IS NULL OR vigente_hasta > p_fecha)
    ORDER BY vigente_desde DESC
    LIMIT 1;
    
    RETURN v_pvp;
END;
$$ LANGUAGE plpgsql STABLE;

-- ----------------------------------------------------------------------------
-- 5. VISTAS ANALÍTICAS (A3: security_invoker = true, A1: fechas locales)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_ultimo_precio_valido 
WITH (security_invoker = true) -- A3
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
    -- A1: Conversión a fecha local y cálculo de días sin DATE_PART
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
    -- B7: Cálculo genérico de precio unitario sin CASE por código
    ROUND(
        (COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv) * 
        (COALESCE(tp.unidades_paga, 1) / COALESCE(tp.unidades_lleva, 1)), 
        2
    ) AS precio_efectivo_unidad_usd
FROM fact_precios fp
JOIN publicaciones pub ON pub.id = fp.publicacion_id
JOIN dim_productos p ON p.id = pub.producto_id
JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN dim_marcas m ON m.id = p.marca_id
LEFT JOIN dim_tipos_promocion tp ON tp.id = fp.tipo_promocion_id
WHERE fp.estado = 'ok'
  AND NOT fp.sospechoso
  AND fp.disponible = TRUE
ORDER BY fp.publicacion_id, fp.fecha_captura DESC;


-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACIÓN POST-EJECUCIÓN DEL ESQUEMA
-- ----------------------------------------------------------------------------

-- C7. Consulta de auditoría: detectar equivalencias desfasadas (correr periódicamente)
/*
SELECT 
    pe.id AS equivalencia_id,
    p_propio.id_interno AS sku_propio,
    lab_propio.nombre AS lab_propio_nombre,
    lab_propio.es_propio AS lab_propio_es_propio,
    p_comp.id_interno AS sku_competidor,
    lab_comp.nombre AS lab_comp_nombre,
    lab_comp.es_propio AS lab_comp_es_propio,
    pe.tipo_equivalencia
FROM producto_equivalencias pe
JOIN dim_productos p_propio ON p_propio.id = pe.producto_propio_id
JOIN dim_laboratorios lab_propio ON lab_propio.id = p_propio.laboratorio_id
JOIN dim_productos p_comp ON p_comp.id = pe.producto_competidor_id
JOIN dim_laboratorios lab_comp ON lab_comp.id = p_comp.laboratorio_id
WHERE NOT lab_propio.es_propio
   OR (lab_comp.es_propio AND pe.tipo_equivalencia <> 'canibalizacion_interna');
*/

-- B3. Consulta de auditoría: productos activos sin principio activo principal
/*
SELECT p.id, p.id_interno, p.nombre
FROM dim_productos p
WHERE p.activo = TRUE
  AND NOT EXISTS (
      SELECT 1 FROM producto_principios pp 
      WHERE pp.producto_id = p.id AND pp.es_principal = TRUE
  );
*/

-- Verificación 1: Tablas creadas y número de columnas
/*
SELECT table_name, count(column_name) AS total_columnas
FROM information_schema.columns
WHERE table_schema = 'public'
GROUP BY table_name
ORDER BY table_name;
*/

-- Verificación 4: Triggers activos
/*
SELECT event_object_table AS tabla, trigger_name, action_timing, event_manipulation AS evento
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;
*/

-- Verificación 5: Vista con security_invoker = true
/*
SELECT viewname, reloptions
FROM pg_views v
JOIN pg_class c ON c.relname = v.viewname
WHERE v.schemaname = 'public' AND v.viewname = 'v_ultimo_precio_valido';
*/

-- Verificación 6: Prueba de fecha UTC a fecha local de Caracas
/*
SELECT 
    NOW() AS utc_now,
    (NOW() AT TIME ZONE 'America/Caracas')::date AS caracas_date,
    ((NOW() AT TIME ZONE 'America/Caracas')::date - ((NOW() - INTERVAL '3 days') AT TIME ZONE 'America/Caracas')::date) AS dias_transcurridos;
*/
