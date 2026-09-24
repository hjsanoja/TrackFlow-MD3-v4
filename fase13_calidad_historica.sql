-- ============================================================================
-- TRACKFLOW - FASE 13: EVALUAR LA CALIDAD DEL HISTORICO MIGRADO
-- ============================================================================
-- HALLAZGO: v_calidad_datos dice "100% limpio, 0 sospechosas de 20.153".
-- No es que los datos esten verificados: es que NUNCA se comprobaron.
--
-- fn_control_calidad_precio, el trigger que marca las capturas dudosas, tiene
-- esto como primera instruccion:
--
--     IF NEW.origen = 'legacy' THEN
--         RETURN NEW;   -- sale sin evaluar nada
--     END IF;
--
-- Y fase2_migracion_datos.sql:462 inserto las 20.153 capturas historicas con
-- origen = 'legacy', a proposito, "para que los triggers de calidad no emitan
-- sospechas erroneas" durante la migracion. Tenia sentido entonces: evaluar
-- 20.000 filas en cadena habria sido lentisimo y ademas el orden de insercion
-- no es el cronologico.
--
-- La consecuencia es que hoy el histórico esta sin revisar, y los promedios,
-- brechas e indices se calculan sobre datos que nadie comprobo.
--
-- Esta fase permite evaluarlo ahora, en frio y en orden cronologico correcto.
--
-- IMPORTANTE: por defecto NO ESCRIBE NADA. Primero se corre en modo ensayo
-- para ver cuantas capturas se marcarian y calibrar los umbrales; solo cuando
-- el resultado convence se aplica.
--
-- ORDEN DE EJECUCION: despues de fase12_bandeja_revision.sql. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.fn_evaluar_calidad_historica(
    p_aplicar            BOOLEAN DEFAULT FALSE,
    p_umbral_variacion   NUMERIC DEFAULT NULL,
    p_umbral_similitud   NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_umbral_var NUMERIC;
    v_umbral_sim NUMERIC;
    v_total      INT := 0;
    v_por_precio INT := 0;
    v_por_nombre INT := 0;
    v_por_ambos  INT := 0;
    v_marcadas   INT := 0;
BEGIN
    -- Umbrales: los de config_calidad salvo que se pasen explicitamente.
    SELECT COALESCE(p_umbral_variacion, valor, 0.40) INTO v_umbral_var
    FROM config_calidad WHERE clave = 'umbral_variacion_precio';
    v_umbral_var := COALESCE(v_umbral_var, p_umbral_variacion, 0.40);

    SELECT COALESCE(p_umbral_similitud, valor, 0.40) INTO v_umbral_sim
    FROM config_calidad WHERE clave = 'umbral_similitud_nombre';
    v_umbral_sim := COALESCE(v_umbral_sim, p_umbral_similitud, 0.40);

    -- Se evalua cada captura legacy contra la ANTERIOR de su misma
    -- publicacion, en orden cronologico. Es lo que el trigger no pudo hacer
    -- durante la migracion, porque las filas no entraron en ese orden.
    CREATE TEMP TABLE IF NOT EXISTS tmp_eval (
        id BIGINT PRIMARY KEY,
        falla_precio BOOLEAN,
        falla_nombre BOOLEAN,
        similitud NUMERIC,
        variacion NUMERIC
    ) ON COMMIT DROP;
    TRUNCATE tmp_eval;

    INSERT INTO tmp_eval
    WITH serie AS (
        SELECT
            fp.id,
            fp.publicacion_id,
            fp.nombre_capturado,
            COALESCE(fp.precio_desc_bs, fp.precio_full_bs) AS precio,
            LAG(COALESCE(fp.precio_desc_bs, fp.precio_full_bs))
                OVER (PARTITION BY fp.publicacion_id ORDER BY fp.fecha_captura) AS precio_anterior,
            pub.producto_id
        FROM fact_precios fp
        JOIN publicaciones pub ON pub.id = fp.publicacion_id
        WHERE fp.origen = 'legacy'
          AND fp.estado = 'ok'
          AND NOT fp.revisado_manual
    )
    SELECT
        s.id,
        -- Salto de precio por encima del umbral, en cualquier direccion
        (s.precio_anterior IS NOT NULL
         AND s.precio_anterior > 0
         AND ABS((s.precio - s.precio_anterior) / s.precio_anterior) > v_umbral_var) AS falla_precio,
        -- Nombre que no se parece al del catalogo
        (s.nombre_capturado IS NOT NULL
         AND LENGTH(TRIM(s.nombre_capturado)) > 0
         AND word_similarity(LOWER(p.nombre), LOWER(s.nombre_capturado)) < v_umbral_sim) AS falla_nombre,
        CASE WHEN s.nombre_capturado IS NOT NULL
             THEN word_similarity(LOWER(p.nombre), LOWER(s.nombre_capturado))
             ELSE NULL END AS similitud,
        CASE WHEN s.precio_anterior > 0
             THEN ROUND((((s.precio - s.precio_anterior) / s.precio_anterior) * 100)::numeric, 1)
             ELSE NULL END AS variacion
    FROM serie s
    JOIN dim_productos p ON p.id = s.producto_id;

    SELECT COUNT(*) INTO v_total FROM tmp_eval;
    SELECT COUNT(*) INTO v_por_precio FROM tmp_eval WHERE falla_precio AND NOT falla_nombre;
    SELECT COUNT(*) INTO v_por_nombre FROM tmp_eval WHERE falla_nombre AND NOT falla_precio;
    SELECT COUNT(*) INTO v_por_ambos  FROM tmp_eval WHERE falla_precio AND falla_nombre;

    IF p_aplicar THEN
        UPDATE fact_precios fp
        SET sospechoso = TRUE,
            similitud_nombre = e.similitud,
            motivo_sospecha = CASE
                WHEN e.falla_precio AND e.falla_nombre THEN 'ambos'
                WHEN e.falla_precio THEN 'variacion_precio'
                ELSE 'nombre'
            END
        FROM tmp_eval e
        WHERE fp.id = e.id
          AND (e.falla_precio OR e.falla_nombre);
        GET DIAGNOSTICS v_marcadas = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'modo', CASE WHEN p_aplicar THEN 'aplicado' ELSE 'ensayo (no se escribio nada)' END,
        'umbral_variacion_precio', v_umbral_var,
        'umbral_similitud_nombre', v_umbral_sim,
        'capturas_legacy_evaluadas', v_total,
        'se_marcarian_por_precio', v_por_precio,
        'se_marcarian_por_nombre', v_por_nombre,
        'se_marcarian_por_ambos', v_por_ambos,
        'total_a_marcar', v_por_precio + v_por_nombre + v_por_ambos,
        'porcentaje_afectado', ROUND(
            ((v_por_precio + v_por_nombre + v_por_ambos)::numeric / NULLIF(v_total, 0)) * 100, 2),
        'marcadas_realmente', v_marcadas
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_evaluar_calidad_historica(BOOLEAN, NUMERIC, NUMERIC) TO authenticated;

-- ----------------------------------------------------------------------------
-- COMO USARLA
-- ----------------------------------------------------------------------------

-- PASO 1. Ensayo con los umbrales actuales. NO escribe nada.
/*
SELECT jsonb_pretty(fn_evaluar_calidad_historica());
*/

-- PASO 2. Si sale demasiado, probar umbrales mas laxos hasta dar con un numero
--         revisable. 0.80 = solo saltos de mas del 80%.
/*
SELECT jsonb_pretty(fn_evaluar_calidad_historica(FALSE, 0.80, 0.25));
*/

-- PASO 3. Cuando el numero convenza, aplicar con esos mismos umbrales.
/*
SELECT jsonb_pretty(fn_evaluar_calidad_historica(TRUE, 0.80, 0.25));
*/

-- PASO 4. Revisarlas en el panel: Experimental -> Revisión de Capturas
/*
SELECT * FROM v_calidad_datos;
*/

-- ----------------------------------------------------------------------------
-- DIAGNOSTICO: MIRAR ANTES DE DECIDIR
-- ----------------------------------------------------------------------------

-- D1. Ejemplos de nombres que no coinciden, del mas raro al menos raro.
--     Sirve para saber SI son fallos reales (paginas de oferta, producto
--     agotado, la tienda cambio el producto de esa URL) o solo variantes del
--     titulo. La similitud aguanta bien acentos y reordenamientos: una
--     puntuacion baja significa que el texto es de verdad distinto.
/*
SELECT
  p.nombre                    AS "esperado",
  fp.nombre_capturado         AS "lo que se leyo",
  ROUND(word_similarity(LOWER(p.nombre), LOWER(fp.nombre_capturado))::numeric, 3) AS parecido,
  COUNT(*) OVER (PARTITION BY fp.nombre_capturado) AS "veces que se repite",
  pub.url
FROM fact_precios fp
JOIN publicaciones pub ON pub.id = fp.publicacion_id
JOIN dim_productos p   ON p.id = pub.producto_id
WHERE fp.origen = 'legacy'
  AND fp.nombre_capturado IS NOT NULL
  AND word_similarity(LOWER(p.nombre), LOWER(fp.nombre_capturado)) < 0.40
ORDER BY parecido
LIMIT 25;
*/

-- D2. Los nombres capturados mas repetidos entre los que fallan. Si uno solo
--     explica cientos de casos, es un patron (por ejemplo, una pagina de
--     "producto no disponible") y no hace falta revisarlos uno por uno.
/*
SELECT fp.nombre_capturado, COUNT(*) AS veces
FROM fact_precios fp
JOIN publicaciones pub ON pub.id = fp.publicacion_id
JOIN dim_productos p   ON p.id = pub.producto_id
WHERE fp.origen = 'legacy'
  AND fp.nombre_capturado IS NOT NULL
  AND word_similarity(LOWER(p.nombre), LOWER(fp.nombre_capturado)) < 0.40
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
*/

-- D3. Solo el criterio de precio: pasar 0 como umbral de nombre lo desactiva,
--     porque la similitud nunca es menor que cero.
/*
SELECT jsonb_pretty(fn_evaluar_calidad_historica(FALSE, 0.40, 0));
*/

-- Para deshacerlo: quita la marca de todo lo que no se haya revisado a mano.
/*
UPDATE fact_precios SET sospechoso = FALSE, motivo_sospecha = NULL
WHERE origen = 'legacy' AND NOT revisado_manual;
*/
