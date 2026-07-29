-- ============================================================
-- SCRIPT DE CONFIGURACIÓN DE POLÍTICAS DE SEGURIDAD (RLS) PARA SUPABASE
-- Copia y pega todo este código en el "SQL Editor" de Supabase y presiona RUN.
-- ============================================================

-- Opción 1: Desactivar RLS en las tablas (Recomendado para apps de scraping/panel interno)
ALTER TABLE IF EXISTS productos DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS productos_competencia DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS historico_precios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS scrape_runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bcv_rates DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cadenas DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS usuarios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS secrets DISABLE ROW LEVEL SECURITY;

-- Opción 2: O si prefieres mantener RLS habilitado pero permitiendo lectura/escritura pública con la anon_key:
/*
ALTER TABLE IF EXISTS productos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a productos" ON productos;
CREATE POLICY "Acceso total a productos" ON productos FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS productos_competencia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a productos_competencia" ON productos_competencia;
CREATE POLICY "Acceso total a productos_competencia" ON productos_competencia FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS historico_precios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a historico_precios" ON historico_precios;
CREATE POLICY "Acceso total a historico_precios" ON historico_precios FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS scrape_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a scrape_runs" ON scrape_runs;
CREATE POLICY "Acceso total a scrape_runs" ON scrape_runs FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS bcv_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a bcv_rates" ON bcv_rates;
CREATE POLICY "Acceso total a bcv_rates" ON bcv_rates FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS cadenas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a cadenas" ON cadenas;
CREATE POLICY "Acceso total a cadenas" ON cadenas FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS usuarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Acceso total a usuarios" ON usuarios;
CREATE POLICY "Acceso total a usuarios" ON usuarios FOR ALL USING (true) WITH CHECK (true);
*/
