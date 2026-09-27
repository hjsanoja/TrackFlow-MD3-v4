-- ============================================================================
-- TRACKFLOW - FASE 35: CONTROL DE CALIDAD POR PRESENTACION Y SENSIBILIDAD
-- ============================================================================
-- 1. fn_leer_presentacion: saca la dosis (mg) y el tamano (unidades, ml o g)
--    de un nombre, p. ej. "Losartan Potasico 50 mg x 30 Tabletas" -> 50 / 30.
-- 2. El control de calidad (trigger de cada captura nueva) compara ademas la
--    presentacion leida en la tienda con la registrada: si el enlace dice
--    "x 30" y el producto es "x 10", la captura queda marcada con el motivo
--    'presentacion'. Solo compara lo que se pudo leer en los dos lados.
--    Se enciende y apaga con config_calidad.validar_presentacion (1 / 0).
-- 3. fn_probar_sensibilidad: con unos umbrales, cuantas capturas de los
--    ultimos N dias se marcarian; con p_aplicar las marca (nunca desmarca ni
--    toca las ya revisadas a mano).
-- 4. v_capturas_revision: suma la presentacion leida y la registrada y el
--    historial de lecturas del enlace alrededor de la captura.
-- 5. Indice para contar las pendientes rapido (contador del menu).
--
-- ORDEN DE EJECUCION: despues de fase34. Es idempotente. No cambia datos.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 0. NUEVO MOTIVO Y NUEVA OPCION
-- ----------------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.fact_precios'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%motivo_sospecha%'
    LOOP
        EXECUTE format('ALTER TABLE public.fact_precios DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE public.fact_precios ADD CONSTRAINT fact_precios_motivo_sospecha_check
    CHECK (motivo_sospecha IN ('nombre', 'variacion_precio', 'ambos', 'legacy', 'presentacion'));

INSERT INTO config_calidad (clave, valor, descripcion)
VALUES ('validar_presentacion', 1, '1 = marcar la captura si la dosis o el tamaño leídos no son los registrados; 0 = no revisar')
ON CONFLICT (clave) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. LEER DOSIS Y TAMANO DE UN NOMBRE
-- ----------------------------------------------------------------------------
-- dosis_mg: el primer "N mg" / "N mcg" / "N g" que no sea tamano ("x 30 g").
-- tamano: "x N" (con ml o g si los lleva) o "N tabletas/capsulas/...".
-- unidad: 'unidad', 'ml' o 'g'.
CREATE OR REPLACE FUNCTION public.fn_leer_presentacion(p_texto TEXT)
RETURNS TABLE (dosis_mg NUMERIC, tamano NUMERIC, unidad TEXT)
LANGUAGE sql IMMUTABLE
AS $$
    WITH t AS (
        SELECT regexp_replace(lower(COALESCE(p_texto, '')), '([0-9]),([0-9])', '\1.\2', 'g') AS s
    ), d AS (
        SELECT s,
               regexp_match(s, '([0-9]+(?:\.[0-9]+)?)\s*(mg|mcg|g)\M') AS m,
               regexp_match(s, 'x\s*([0-9]+(?:\.[0-9]+)?)\s*(ml|g)\M') AS xv,
               regexp_match(s, 'x\s*([0-9]+)(?![0-9.]*\s*(?:mg|mcg))') AS xn,
               regexp_match(s, '([0-9]+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|cápsulas|capsula|cápsula|caps|grageas|sobres|ampollas|ampolla|ovulos|óvulos|parches|unidades|und)\M') AS fn
        FROM t
    )
    SELECT
        CASE WHEN m IS NULL THEN NULL
             -- "x 30 g" es tamano, no dosis
             WHEN m[2] = 'g' AND s ~ ('x\s*' || m[1] || '\s*g\M') THEN NULL
             WHEN m[2] = 'mcg' THEN m[1]::numeric / 1000
             WHEN m[2] = 'g' THEN m[1]::numeric * 1000
             ELSE m[1]::numeric END,
        COALESCE(xv[1]::numeric, xn[1]::numeric, fn[1]::numeric),
        CASE WHEN xv IS NOT NULL THEN xv[2]
             WHEN xn IS NOT NULL OR fn IS NOT NULL THEN 'unidad' END
    FROM d;
$$;

-- Dosis y tamano REGISTRADOS de un producto: la concentracion principal
-- (solo mg, mcg o g) y cantidad_contenido. Tamano 1 = sin dato.
CREATE OR REPLACE FUNCTION public.fn_presentacion_registrada(p_producto_id BIGINT)
RETURNS TABLE (dosis_mg NUMERIC, tamano NUMERIC, unidad TEXT)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
    SELECT
        (SELECT CASE lower(pp.concentracion_unidad)
                    WHEN 'mg' THEN pp.concentracion_valor
                    WHEN 'mcg' THEN pp.concentracion_valor / 1000
                    WHEN 'g' THEN pp.concentracion_valor * 1000 END
         FROM producto_principios pp
         WHERE pp.producto_id = p.id
         ORDER BY pp.es_principal DESC, pp.id
         LIMIT 1),
        CASE WHEN p.cantidad_contenido > 1 THEN p.cantidad_contenido END,
        COALESCE(p.unidad_contenido, 'unidad')
    FROM dim_productos p
    WHERE p.id = p_producto_id;
$$;

-- TRUE si lo leido contradice lo registrado (solo si hay dato en los dos
-- lados: sin dosis o sin tamano en alguno, no se compara ese dato).
CREATE OR REPLACE FUNCTION public.fn_presentacion_distinta(
    l_dosis NUMERIC, l_tamano NUMERIC, l_unidad TEXT,
    r_dosis NUMERIC, r_tamano NUMERIC, r_unidad TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT (l_dosis IS NOT NULL AND r_dosis IS NOT NULL AND ABS(l_dosis - r_dosis) > 0.001)
        OR (l_tamano IS NOT NULL AND r_tamano IS NOT NULL
            AND COALESCE(l_unidad, 'unidad') = COALESCE(r_unidad, 'unidad')
            AND ABS(l_tamano - r_tamano) > 0.001);
$$;

-- ----------------------------------------------------------------------------
-- 2. CONTROL DE CALIDAD DE CADA CAPTURA NUEVA
-- ----------------------------------------------------------------------------
-- Igual que la fase 1, mas la presentacion.
CREATE OR REPLACE FUNCTION public.fn_control_calidad_precio()
RETURNS TRIGGER
SET search_path = public, extensions
AS $$
DECLARE
    v_nombre_esperado TEXT;
    v_producto_id BIGINT;
    v_similitud NUMERIC;
    v_umbral_similitud NUMERIC;
    v_umbral_variacion NUMERIC;
    v_validar_pres NUMERIC;
    v_ultimo_precio NUMERIC;
    v_precio_actual NUMERIC;
    v_variacion NUMERIC;
    v_falla_nombre BOOLEAN := FALSE;
    v_falla_precio BOOLEAN := FALSE;
    v_falla_pres BOOLEAN := FALSE;
BEGIN
    IF NEW.origen = 'legacy' THEN
        RETURN NEW;
    END IF;
    IF NEW.revisado_manual THEN
        RETURN NEW;
    END IF;

    SELECT valor INTO v_umbral_similitud FROM config_calidad WHERE clave = 'umbral_similitud_nombre';
    SELECT valor INTO v_umbral_variacion FROM config_calidad WHERE clave = 'umbral_variacion_precio';
    SELECT valor INTO v_validar_pres FROM config_calidad WHERE clave = 'validar_presentacion';
    v_umbral_similitud := COALESCE(v_umbral_similitud, 0.40);
    v_umbral_variacion := COALESCE(v_umbral_variacion, 0.40);
    v_validar_pres := COALESCE(v_validar_pres, 1);

    -- 1. Nombre y presentacion
    IF NEW.nombre_capturado IS NOT NULL AND NEW.estado = 'ok' THEN
        SELECT TRIM(COALESCE(m.nombre, '') || ' ' || p.nombre), p.id
        INTO v_nombre_esperado, v_producto_id
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

        IF v_validar_pres > 0 AND v_producto_id IS NOT NULL THEN
            SELECT fn_presentacion_distinta(l.dosis_mg, l.tamano, l.unidad, r.dosis_mg, r.tamano, r.unidad)
            INTO v_falla_pres
            FROM fn_leer_presentacion(NEW.nombre_capturado) l,
                 fn_presentacion_registrada(v_producto_id) r;
            v_falla_pres := COALESCE(v_falla_pres, FALSE);
        END IF;
    END IF;

    -- 2. Variacion de precio vs la ultima captura valida
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

    -- Motivo: 'ambos' = mas de uno a la vez
    IF (v_falla_nombre::int + v_falla_precio::int + v_falla_pres::int) > 1 THEN
        NEW.sospechoso := TRUE;
        NEW.motivo_sospecha := 'ambos';
    ELSIF v_falla_pres THEN
        NEW.sospechoso := TRUE;
        NEW.motivo_sospecha := 'presentacion';
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

-- ----------------------------------------------------------------------------
-- 3. PROBAR Y APLICAR OTRA SENSIBILIDAD
-- ----------------------------------------------------------------------------
-- Evalua las capturas del robot de los ultimos p_dias con los umbrales dados.
-- Devuelve cuantas se marcarian por cada motivo, cuantas estan marcadas hoy y
-- cuantas serian nuevas. Con p_aplicar = TRUE marca las nuevas (las ya
-- marcadas y las revisadas a mano no se tocan).
CREATE OR REPLACE FUNCTION public.fn_probar_sensibilidad(
    p_umbral_variacion NUMERIC,
    p_umbral_similitud NUMERIC,
    p_validar_presentacion BOOLEAN DEFAULT TRUE,
    p_dias INT DEFAULT 30,
    p_aplicar BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_res JSONB;
BEGIN
    WITH eval AS (
        SELECT fp.id, fp.sospechoso AS ya_marcada, fp.revisado_manual AS revisada,
               COALESCE(ant.precio > 0
                        AND ABS(COALESCE(fp.precio_desc_bs, fp.precio_full_bs) - ant.precio) / ant.precio > p_umbral_variacion, FALSE) AS f_precio,
               COALESCE(fp.nombre_capturado IS NOT NULL
                        AND word_similarity(LOWER(TRIM(COALESCE(m.nombre, '') || ' ' || p.nombre)), LOWER(fp.nombre_capturado)) < p_umbral_similitud, FALSE) AS f_nombre,
               COALESCE(p_validar_presentacion AND fp.nombre_capturado IS NOT NULL
                        AND fn_presentacion_distinta(l.dosis_mg, l.tamano, l.unidad, r.dosis_mg, r.tamano, r.unidad), FALSE) AS f_pres
        FROM fact_precios fp
        JOIN publicaciones pub ON pub.id = fp.publicacion_id
        JOIN dim_productos p   ON p.id = pub.producto_id
        LEFT JOIN dim_marcas m ON m.id = p.marca_id
        LEFT JOIN LATERAL fn_leer_presentacion(fp.nombre_capturado) l ON TRUE
        LEFT JOIN LATERAL fn_presentacion_registrada(p.id) r ON TRUE
        LEFT JOIN LATERAL (
            SELECT COALESCE(a.precio_desc_bs, a.precio_full_bs) AS precio
            FROM fact_precios a
            WHERE a.publicacion_id = fp.publicacion_id
              AND a.fecha_captura < fp.fecha_captura
              AND a.estado = 'ok' AND a.disponible AND NOT a.sospechoso
            ORDER BY a.fecha_captura DESC
            LIMIT 1
        ) ant ON TRUE
        WHERE fp.origen = 'scraper'
          AND fp.estado = 'ok'
          AND fp.fecha_captura >= NOW() - make_interval(days => GREATEST(p_dias, 1))
    ), marcar AS (
        UPDATE fact_precios fp
        SET sospechoso = TRUE,
            motivo_sospecha = CASE
                WHEN (e.f_precio::int + e.f_nombre::int + e.f_pres::int) > 1 THEN 'ambos'
                WHEN e.f_pres THEN 'presentacion'
                WHEN e.f_nombre THEN 'nombre'
                ELSE 'variacion_precio' END
        FROM eval e
        WHERE p_aplicar
          AND fp.id = e.id
          AND (e.f_precio OR e.f_nombre OR e.f_pres)
          AND NOT e.ya_marcada AND NOT e.revisada
        RETURNING fp.id
    )
    SELECT jsonb_build_object(
        'evaluadas',        COUNT(*),
        'marcadas_hoy',     COUNT(*) FILTER (WHERE ya_marcada),
        'marcarian',        COUNT(*) FILTER (WHERE f_precio OR f_nombre OR f_pres),
        'nuevas',           COUNT(*) FILTER (WHERE (f_precio OR f_nombre OR f_pres) AND NOT ya_marcada AND NOT revisada),
        'por_precio',       COUNT(*) FILTER (WHERE f_precio),
        'por_nombre',       COUNT(*) FILTER (WHERE f_nombre),
        'por_presentacion', COUNT(*) FILTER (WHERE f_pres),
        'marcadas_ahora',   (SELECT COUNT(*) FROM marcar)
    ) INTO v_res
    FROM eval;

    RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_probar_sensibilidad(NUMERIC, NUMERIC, BOOLEAN, INT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_leer_presentacion(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_presentacion_registrada(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_presentacion_distinta(NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. VISTA DE REVISION CON PRESENTACION E HISTORIAL
-- ----------------------------------------------------------------------------
-- Las mismas columnas de la fase 34, en el mismo orden, y al final:
--   leida_* / registrada_*: dosis y tamano leidos en la tienda y registrados;
--   historial: hasta 8 lecturas antes y 4 despues, [{f, p, s, a}] con
--   a = TRUE en esta captura y s = TRUE si esa lectura esta marcada.
CREATE OR REPLACE VIEW public.v_capturas_revision
WITH (security_invoker = true)
AS
SELECT
    fp.id                          AS captura_id,
    fp.publicacion_id,
    pub.cadena_id,
    pub.url,
    pub.activo                     AS enlace_activo,
    p.id_interno,
    COALESCE(p_propio.id_interno, p.id_interno) AS id_producto_propio,
    p.nombre                       AS producto_nombre,
    p_propio.nombre                AS producto_propio_nombre,
    lab.nombre                     AS laboratorio,
    lab.es_propio,

    fp.fecha_captura,
    fp.precio_full_bs,
    fp.precio_desc_bs,
    COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio_bs,
    fp.tasa_bcv,
    CASE WHEN fp.tasa_bcv > 0
         THEN ROUND((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) / fp.tasa_bcv)::numeric, 2)
         ELSE NULL END             AS precio_usd,

    fp.motivo_sospecha,
    fp.similitud_nombre,
    fp.nombre_capturado,
    CASE WHEN NOT fp.revisado_manual THEN 'pendiente'
         WHEN fp.sospechoso          THEN 'erronea'
         ELSE 'valida' END         AS estado_revision,

    ant.fecha_captura              AS fecha_anterior,
    ant.precio_bs                  AS precio_anterior_bs,
    CASE WHEN ant.precio_bs > 0
         THEN ROUND((((COALESCE(fp.precio_desc_bs, fp.precio_full_bs) - ant.precio_bs)
                      / ant.precio_bs) * 100)::numeric, 1)
         ELSE NULL END             AS variacion_pct,

    sig.fecha_captura              AS fecha_siguiente,
    sig.precio_bs                  AS precio_siguiente_bs,
    COUNT(*) FILTER (WHERE NOT fp.revisado_manual)
        OVER (PARTITION BY fp.publicacion_id) AS pendientes_enlace,

    -- nuevas (fase 35)
    l.dosis_mg                     AS leida_dosis_mg,
    l.tamano                       AS leida_tamano,
    l.unidad                       AS leida_unidad,
    r.dosis_mg                     AS registrada_dosis_mg,
    r.tamano                       AS registrada_tamano,
    r.unidad                       AS registrada_unidad,
    COALESCE(h_antes.lecturas, '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('f', fp.fecha_captura,
             'p', COALESCE(fp.precio_desc_bs, fp.precio_full_bs), 's', fp.sospechoso, 'a', TRUE))
      || COALESCE(h_despues.lecturas, '[]'::jsonb) AS historial

FROM fact_precios fp
JOIN publicaciones pub      ON pub.id = fp.publicacion_id
JOIN dim_productos p        ON p.id = pub.producto_id
JOIN dim_laboratorios lab   ON lab.id = p.laboratorio_id
LEFT JOIN producto_equivalencias pe
       ON pe.producto_competidor_id = p.id AND pe.activo
LEFT JOIN dim_productos p_propio
       ON p_propio.id = pe.producto_propio_id
LEFT JOIN LATERAL fn_leer_presentacion(fp.nombre_capturado) l ON TRUE
LEFT JOIN LATERAL fn_presentacion_registrada(p.id) r ON TRUE
LEFT JOIN LATERAL (
    SELECT a.fecha_captura, COALESCE(a.precio_desc_bs, a.precio_full_bs) AS precio_bs
    FROM fact_precios a
    WHERE a.publicacion_id = fp.publicacion_id
      AND a.fecha_captura < fp.fecha_captura
      AND a.estado = 'ok' AND a.disponible AND NOT a.sospechoso
    ORDER BY a.fecha_captura DESC
    LIMIT 1
) ant ON TRUE
LEFT JOIN LATERAL (
    SELECT s.fecha_captura, COALESCE(s.precio_desc_bs, s.precio_full_bs) AS precio_bs
    FROM fact_precios s
    WHERE s.publicacion_id = fp.publicacion_id
      AND s.fecha_captura > fp.fecha_captura
      AND s.estado = 'ok' AND s.disponible
    ORDER BY s.fecha_captura ASC
    LIMIT 1
) sig ON TRUE
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('f', x.fecha_captura, 'p', x.precio, 's', x.sospechoso) ORDER BY x.fecha_captura) AS lecturas
    FROM (
        SELECT b.fecha_captura, COALESCE(b.precio_desc_bs, b.precio_full_bs) AS precio, b.sospechoso
        FROM fact_precios b
        WHERE b.publicacion_id = fp.publicacion_id
          AND b.fecha_captura < fp.fecha_captura
          AND b.estado = 'ok' AND b.disponible
        ORDER BY b.fecha_captura DESC
        LIMIT 8
    ) x
) h_antes ON TRUE
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('f', x.fecha_captura, 'p', x.precio, 's', x.sospechoso) ORDER BY x.fecha_captura) AS lecturas
    FROM (
        SELECT d.fecha_captura, COALESCE(d.precio_desc_bs, d.precio_full_bs) AS precio, d.sospechoso
        FROM fact_precios d
        WHERE d.publicacion_id = fp.publicacion_id
          AND d.fecha_captura > fp.fecha_captura
          AND d.estado = 'ok' AND d.disponible
        ORDER BY d.fecha_captura ASC
        LIMIT 4
    ) x
) h_despues ON TRUE
WHERE (fp.sospechoso AND NOT fp.revisado_manual)
   OR (fp.revisado_manual AND fp.motivo_sospecha IS NOT NULL);

GRANT SELECT ON public.v_capturas_revision TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. CONTAR PENDIENTES RAPIDO (contador del menu)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fact_precios_pendientes
    ON public.fact_precios (fecha_captura DESC)
    WHERE sospechoso AND NOT revisado_manual;

-- ----------------------------------------------------------------------------
-- VERIFICACION
-- ----------------------------------------------------------------------------
/*
SELECT * FROM fn_leer_presentacion('Losartan Potasico 50 mg x 30 Tabletas');   -- 50 | 30 | unidad
SELECT * FROM fn_leer_presentacion('Acetaminofen Jarabe 120 mg/5 ml x 120 ml'); -- 120 | 120 | ml
SELECT fn_probar_sensibilidad(0.40, 0.40, TRUE, 30, FALSE);
*/
