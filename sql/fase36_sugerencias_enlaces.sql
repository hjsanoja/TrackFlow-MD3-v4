-- ============================================================================
-- TRACKFLOW - FASE 36: SUGERENCIAS DE ENLACES (BUSCADOR, BETA)
-- ============================================================================
-- El robot buscador (scraper/buscar_enlaces.py, GitHub Actions) toma los
-- productos que ya estan en Competencia y busca ese mismo producto en las
-- cadenas donde todavia no tiene enlace. Lo que encuentra NO se vuelve un
-- enlace: queda como sugerencia hasta que alguien la acepta en el panel.
--
-- Esta fase agrega:
--   1. dim_cadenas.plataforma: como busca el robot en cada tienda (vtex,
--      woocommerce, shopify, magento o 'sin_buscador'); la detecta el robot.
--   2. Las cadenas Farmadon, Farmago, Farmabien y Farmatina (si no existen).
--   3. sugerencias_enlaces: lo encontrado, con su puntaje, pendiente de
--      aceptar o descartar.
--   4. busquedas_enlaces: la ultima busqueda de cada producto en cada cadena
--      (para no repetirla cada vez).
--   5. corridas_buscador: cada corrida del robot, con su avance y resumen.
--   6. v_buscar_enlaces: los productos a buscar, con dosis, tamano,
--      laboratorio y sus sinonimos. v_sugerencias_enlaces: para el panel.
--   7. fn_aceptar_sugerencia: crea el enlace (publicacion) y marca la
--      sugerencia como aceptada.
--
-- No cambia enlaces, productos ni precios existentes.
-- ORDEN DE EJECUCION: despues de fase35. Es idempotente.
-- Para deshacerla, al final del archivo esta el bloque "DESHACER".
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. PLATAFORMA DE CADA CADENA
-- ----------------------------------------------------------------------------
ALTER TABLE public.dim_cadenas ADD COLUMN IF NOT EXISTS plataforma VARCHAR(20);
ALTER TABLE public.dim_cadenas ADD COLUMN IF NOT EXISTS plataforma_detalle JSONB;
ALTER TABLE public.dim_cadenas ADD COLUMN IF NOT EXISTS plataforma_revisada TIMESTAMPTZ;
-- Por si la fase 27 no se corrio: los sinonimos ayudan a reconocer el laboratorio.
ALTER TABLE public.dim_laboratorios ADD COLUMN IF NOT EXISTS sinonimos TEXT[] DEFAULT '{}';

-- ----------------------------------------------------------------------------
-- 1b. LECTOR DE PRESENTACION, AJUSTADO
-- ----------------------------------------------------------------------------
-- Igual que la fase 35, con dos arreglos (el robot buscador usa la misma
-- regla): "400mgx20" ahora lee la dosis, y la "x" de un nombre ("Dolex 500
-- x 10") ya no se confunde con el tamano.
CREATE OR REPLACE FUNCTION public.fn_leer_presentacion(p_texto TEXT)
RETURNS TABLE (dosis_mg NUMERIC, tamano NUMERIC, unidad TEXT)
LANGUAGE sql IMMUTABLE
AS $$
    WITH t AS (
        SELECT regexp_replace(lower(COALESCE(p_texto, '')), '([0-9]),([0-9])', '\1.\2', 'g') AS s
    ), d AS (
        SELECT s,
               regexp_match(s, '([0-9]+(?:\.[0-9]+)?)\s*(mg|mcg|g)(?![a-wyz])') AS m,
               regexp_match(s, '(?:^|[^a-z]|mg|mcg)x\s*([0-9]+(?:\.[0-9]+)?)\s*(ml|g)\M') AS xv,
               regexp_match(s, '(?:^|[^a-z]|mg|mcg)x\s*([0-9]+)(?![0-9.]*\s*(?:mg|mcg))') AS xn,
               regexp_match(s, '([0-9]+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|cápsulas|capsula|cápsula|caps|grageas|sobres|ampollas|ampolla|ovulos|óvulos|parches|unidades|und)\M') AS fn
        FROM t
    )
    SELECT
        CASE WHEN m IS NULL THEN NULL
             WHEN m[2] = 'g' AND s ~ ('x\s*' || m[1] || '\s*g\M') THEN NULL
             WHEN m[2] = 'mcg' THEN m[1]::numeric / 1000
             WHEN m[2] = 'g' THEN m[1]::numeric * 1000
             ELSE m[1]::numeric END,
        COALESCE(xv[1]::numeric, xn[1]::numeric, fn[1]::numeric),
        CASE WHEN xv IS NOT NULL THEN xv[2]
             WHEN xn IS NOT NULL OR fn IS NOT NULL THEN 'unidad' END
    FROM d;
$$;

-- ----------------------------------------------------------------------------
-- 2. CADENAS NUEVAS Y WEB DE LAS QUE YA ESTAN
-- ----------------------------------------------------------------------------
-- Solo si no hay ya una cadena con ese nombre o esa web. Sin color (se elige
-- en Cadenas): el color no puede repetirse.
INSERT INTO public.dim_cadenas (id, nombre, website, color_hex, activo)
SELECT v.id, v.nombre, v.website, NULL, TRUE
FROM (VALUES
    ('farmadon',  'Farmadon',  'https://www.farmadon.com.ve'),
    ('farmago',   'Farmago',   'https://www.farmago.com.ve'),
    ('farmabien', 'Farmabien', 'https://www.farmabien.com'),
    ('farmatina', 'Farmatina', 'https://farmatina.com')
) AS v(id, nombre, website)
WHERE NOT EXISTS (
    SELECT 1 FROM public.dim_cadenas c
    WHERE c.id = v.id
       OR lower(c.nombre) = lower(v.nombre)
       OR lower(COALESCE(c.website, '')) LIKE '%' || split_part(v.website, '://', 2) || '%'
       OR lower(COALESCE(c.website, '')) LIKE '%' || replace(split_part(v.website, '://', 2), 'www.', '') || '%'
);

-- Sigla propia (si existe la columna de la fase 26): sin esto Farmadon,
-- Farmago y Farmabien saldrian las tres como "FA".
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'dim_cadenas' AND column_name = 'sigla') THEN
        UPDATE public.dim_cadenas d SET sigla = v.sigla
        FROM (VALUES ('farmadon', 'FD'), ('farmago', 'FG'), ('farmabien', 'FB'), ('farmatina', 'FN')) AS v(id, sigla)
        WHERE d.id = v.id AND COALESCE(d.sigla, '') = '';
    END IF;
END $$;

UPDATE public.dim_cadenas SET website = 'https://www.farmatodo.com.ve'
WHERE COALESCE(website, '') = '' AND (lower(id) LIKE '%farmatodo%' OR lower(nombre) LIKE '%farmatodo%');
UPDATE public.dim_cadenas SET website = 'https://www.locatel.com.ve'
WHERE COALESCE(website, '') = '' AND (lower(id) LIKE '%locatel%' OR lower(nombre) LIKE '%locatel%');
UPDATE public.dim_cadenas SET website = 'https://www.farmaciasaas.com'
WHERE COALESCE(website, '') = '' AND (lower(id) LIKE '%saas%' OR lower(nombre) LIKE '%saas%');

-- ----------------------------------------------------------------------------
-- 3. SUGERENCIAS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sugerencias_enlaces (
    id BIGSERIAL PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE CASCADE,
    cadena_id VARCHAR(50) NOT NULL REFERENCES dim_cadenas(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    nombre_tienda TEXT,
    marca_tienda TEXT,
    precio NUMERIC(14, 2),
    moneda VARCHAR(3),
    disponible BOOLEAN,
    puntaje INT NOT NULL,
    detalle JSONB,              -- {laboratorio, dosis, tamano: 'si'|'no'|'?' , consulta}
    estado VARCHAR(12) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'aceptada', 'descartada')),
    publicacion_id BIGINT REFERENCES publicaciones(id) ON DELETE SET NULL,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revisado TIMESTAMPTZ,
    CONSTRAINT uq_sugerencia UNIQUE (producto_id, cadena_id, url)
);
CREATE INDEX IF NOT EXISTS idx_sugerencias_estado ON public.sugerencias_enlaces (estado, puntaje DESC);

CREATE TABLE IF NOT EXISTS public.busquedas_enlaces (
    producto_id BIGINT NOT NULL REFERENCES dim_productos(id) ON DELETE CASCADE,
    cadena_id VARCHAR(50) NOT NULL REFERENCES dim_cadenas(id) ON DELETE CASCADE,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resultado VARCHAR(15) NOT NULL,   -- sugerido | sin_resultado | error
    consultas TEXT[],
    candidatos INT,
    mejor_puntaje INT,
    error TEXT,
    PRIMARY KEY (producto_id, cadena_id)
);

CREATE TABLE IF NOT EXISTS public.corridas_buscador (
    id BIGSERIAL PRIMARY KEY,
    inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin TIMESTAMPTZ,
    estado VARCHAR(12) NOT NULL DEFAULT 'corriendo',   -- corriendo | terminada | fallida
    total INT,
    procesados INT DEFAULT 0,
    resumen JSONB,
    url_github TEXT
);

-- Permisos: el robot escribe con service_role (no pasa por RLS). El panel lee
-- todo y solo cambia el estado de una sugerencia.
ALTER TABLE public.sugerencias_enlaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.busquedas_enlaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.corridas_buscador ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_sugerencias" ON public.sugerencias_enlaces;
CREATE POLICY "auth_select_sugerencias" ON public.sugerencias_enlaces FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_update_sugerencias" ON public.sugerencias_enlaces;
CREATE POLICY "auth_update_sugerencias" ON public.sugerencias_enlaces FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_select_busquedas" ON public.busquedas_enlaces;
CREATE POLICY "auth_select_busquedas" ON public.busquedas_enlaces FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_select_corridas_buscador" ON public.corridas_buscador;
CREATE POLICY "auth_select_corridas_buscador" ON public.corridas_buscador FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.sugerencias_enlaces, public.busquedas_enlaces, public.corridas_buscador TO authenticated;
GRANT UPDATE (estado, revisado, publicacion_id, actualizado) ON public.sugerencias_enlaces TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. PRODUCTOS A BUSCAR
-- ----------------------------------------------------------------------------
-- Los productos (tuyos y de la competencia) con al menos un enlace activo,
-- con lo que el robot necesita para armar la busqueda y puntuar.
CREATE OR REPLACE VIEW public.v_buscar_enlaces
WITH (security_invoker = true)
AS
SELECT
    p.id                         AS producto_id,
    p.id_interno,
    p.nombre,
    COALESCE(m.nombre, '')       AS marca,
    lab.nombre                   AS laboratorio,
    COALESCE(lab.sinonimos, '{}') AS laboratorio_sinonimos,
    lab.es_propio,
    p.tipo_mercado,
    pa.principio,
    r.dosis_mg,
    r.tamano,
    r.unidad,
    ARRAY(SELECT DISTINCT pub.cadena_id FROM publicaciones pub WHERE pub.producto_id = p.id) AS cadenas_con_enlace
FROM dim_productos p
JOIN dim_laboratorios lab ON lab.id = p.laboratorio_id
LEFT JOIN dim_marcas m ON m.id = p.marca_id
LEFT JOIN LATERAL fn_presentacion_registrada(p.id) r ON TRUE
LEFT JOIN LATERAL (
    SELECT pa.nombre AS principio
    FROM producto_principios pp
    JOIN dim_principios_activos pa ON pa.id = pp.principio_activo_id
    WHERE pp.producto_id = p.id
    ORDER BY pp.es_principal DESC, pp.id
    LIMIT 1
) pa ON TRUE
WHERE EXISTS (SELECT 1 FROM publicaciones pub WHERE pub.producto_id = p.id AND pub.activo);

-- Para el panel: la sugerencia con los datos del producto.
CREATE OR REPLACE VIEW public.v_sugerencias_enlaces
WITH (security_invoker = true)
AS
SELECT
    s.*,
    p.id_interno,
    p.nombre                     AS producto_nombre,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    p_propio.nombre              AS producto_propio_nombre,
    lab.nombre                   AS laboratorio,
    lab.es_propio,
    r.dosis_mg                   AS registrada_dosis_mg,
    r.tamano                     AS registrada_tamano,
    r.unidad                     AS registrada_unidad,
    EXISTS (SELECT 1 FROM publicaciones pub
            WHERE pub.producto_id = s.producto_id AND pub.cadena_id = s.cadena_id) AS ya_tiene_enlace
FROM sugerencias_enlaces s
JOIN dim_productos p        ON p.id = s.producto_id
JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe
       ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio
       ON p_propio.id = pe.producto_propio_id
LEFT JOIN LATERAL fn_presentacion_registrada(p.id) r ON TRUE;

GRANT SELECT ON public.v_buscar_enlaces, public.v_sugerencias_enlaces TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. ACEPTAR UNA SUGERENCIA
-- ----------------------------------------------------------------------------
-- Crea el enlace del MISMO producto en esa cadena (activo: el robot de precios
-- lo lee en su proxima corrida), marca la sugerencia como aceptada y descarta
-- las otras pendientes de ese producto en esa cadena.
CREATE OR REPLACE FUNCTION public.fn_aceptar_sugerencia(p_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    s RECORD;
    v_norm TEXT;
    v_pub BIGINT;
    v_otro BIGINT;
BEGIN
    SELECT * INTO s FROM sugerencias_enlaces WHERE id = p_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'La sugerencia % no existe.', p_id;
    END IF;

    v_norm := lower(regexp_replace(trim(s.url), '\?.*$', ''));

    SELECT id, producto_id INTO v_pub, v_otro
    FROM publicaciones WHERE cadena_id = s.cadena_id AND url_normalizada = v_norm;
    IF v_pub IS NOT NULL AND v_otro <> s.producto_id THEN
        RAISE EXCEPTION 'Esa URL ya está vinculada a otro producto en esta cadena.';
    END IF;

    IF v_pub IS NULL THEN
        INSERT INTO publicaciones (producto_id, cadena_id, url, url_normalizada, activo)
        VALUES (s.producto_id, s.cadena_id, trim(s.url), v_norm, TRUE)
        RETURNING id INTO v_pub;
    ELSE
        UPDATE publicaciones SET activo = TRUE, updated_at = NOW() WHERE id = v_pub;
    END IF;

    UPDATE sugerencias_enlaces
    SET estado = 'aceptada', revisado = NOW(), actualizado = NOW(), publicacion_id = v_pub
    WHERE id = p_id;

    UPDATE sugerencias_enlaces
    SET estado = 'descartada', revisado = NOW(), actualizado = NOW()
    WHERE producto_id = s.producto_id AND cadena_id = s.cadena_id
      AND id <> p_id AND estado = 'pendiente';

    RETURN v_pub;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_aceptar_sugerencia(BIGINT) TO authenticated;

-- ----------------------------------------------------------------------------
-- VERIFICACION
-- ----------------------------------------------------------------------------
/*
SELECT id, nombre, website, plataforma FROM dim_cadenas ORDER BY nombre;
SELECT COUNT(*) FROM v_buscar_enlaces;
SELECT estado, COUNT(*) FROM sugerencias_enlaces GROUP BY 1;
*/

-- ----------------------------------------------------------------------------
-- DESHACER (solo si quieres quitar el buscador; no toca enlaces ya aceptados)
-- ----------------------------------------------------------------------------
/*
DROP FUNCTION IF EXISTS public.fn_aceptar_sugerencia(BIGINT);
DROP VIEW IF EXISTS public.v_sugerencias_enlaces;
DROP VIEW IF EXISTS public.v_buscar_enlaces;
DROP TABLE IF EXISTS public.corridas_buscador;
DROP TABLE IF EXISTS public.busquedas_enlaces;
DROP TABLE IF EXISTS public.sugerencias_enlaces;
DELETE FROM public.dim_cadenas c
WHERE c.id IN ('farmadon', 'farmago', 'farmabien', 'farmatina')
  AND NOT EXISTS (SELECT 1 FROM publicaciones p WHERE p.cadena_id = c.id);
ALTER TABLE public.dim_cadenas DROP COLUMN IF EXISTS plataforma_revisada;
ALTER TABLE public.dim_cadenas DROP COLUMN IF EXISTS plataforma_detalle;
ALTER TABLE public.dim_cadenas DROP COLUMN IF EXISTS plataforma;
*/
