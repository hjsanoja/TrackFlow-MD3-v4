-- ============================================================================
-- TRACKFLOW - FASE 37: TAMANO EN ML SIN "x"
-- ============================================================================
-- Algunas tiendas escriben el volumen sin "x": "ANALPER JBE PED 180MG/5ML
-- 120ML". fn_leer_presentacion (control de calidad y panel) ahora toma ese
-- volumen: el ultimo "N ml" que no sea el "/5ml" de la concentracion. Es la
-- misma regla que usa el robot buscador (scraper/buscar_enlaces.py).
--
-- No cambia datos. ORDEN DE EJECUCION: despues de fase36. Es idempotente.
-- ============================================================================

SET search_path = public, extensions;

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
               (SELECT (array_agg(r.x[1] ORDER BY r.o DESC))[1]
                FROM regexp_matches(s, '(?<![/0-9.])([0-9]+(?:\.[0-9]+)?)\s*ml\M', 'g') WITH ORDINALITY AS r(x, o)) AS ml,
               regexp_match(s, '(?:^|[^a-z]|mg|mcg)x\s*([0-9]+)(?![0-9.]*\s*(?:mg|mcg))') AS xn,
               regexp_match(s, '([0-9]+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|cápsulas|capsula|cápsula|caps|grageas|sobres|ampollas|ampolla|ovulos|óvulos|parches|unidades|und)\M') AS fn
        FROM t
    ), e AS (
        SELECT d.*, CASE WHEN ml::numeric > 5 THEN ml::numeric END AS ml_ok FROM d
    )
    SELECT
        CASE WHEN m IS NULL THEN NULL
             WHEN m[2] = 'g' AND s ~ ('x\s*' || m[1] || '\s*g\M') THEN NULL
             WHEN m[2] = 'mcg' THEN m[1]::numeric / 1000
             WHEN m[2] = 'g' THEN m[1]::numeric * 1000
             ELSE m[1]::numeric END,
        COALESCE(xv[1]::numeric, ml_ok, xn[1]::numeric, fn[1]::numeric),
        CASE WHEN xv IS NOT NULL THEN xv[2]
             WHEN ml_ok IS NOT NULL THEN 'ml'
             WHEN xn IS NOT NULL OR fn IS NOT NULL THEN 'unidad' END
    FROM e;
$$;

-- VERIFICACION
/*
SELECT * FROM fn_leer_presentacion('ANALPER JBE PED 180MG/5ML 120ML ACETAMINOFEN LA SANTE'); -- 180 | 120 | ml
SELECT * FROM fn_leer_presentacion('Losartan Potasico 50 mg x 30 Tabletas');                 -- 50 | 30 | unidad
*/
