-- ============================================================
-- SCRIPT DE DESACTIVACIÓN / HABILITACIÓN DE RLS EN SUPABASE
-- Copia y pega este script en el "SQL Editor" de tu proyecto de Supabase y presiona "RUN".
-- ============================================================

-- 1. DESACTIVAR RLS (Recomendado para evitar bloqueos de lectura/escritura)
ALTER TABLE IF EXISTS productos DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS productos_competencia DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS historico_precios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS scrape_runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bcv_rates DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cadenas DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS usuarios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS secrets DISABLE ROW LEVEL SECURITY;

-- 2. OTORGAR PERMISOS PÚBLICOS DE LECTURA Y ESCRITURA A LA ROL ANON Y AUTHENTICATED
GRANT ALL ON TABLE productos TO anon, authenticated, service_role;
GRANT ALL ON TABLE productos_competencia TO anon, authenticated, service_role;
GRANT ALL ON TABLE historico_precios TO anon, authenticated, service_role;
GRANT ALL ON TABLE scrape_runs TO anon, authenticated, service_role;
GRANT ALL ON TABLE bcv_rates TO anon, authenticated, service_role;
GRANT ALL ON TABLE cadenas TO anon, authenticated, service_role;
GRANT ALL ON TABLE usuarios TO anon, authenticated, service_role;

-- 3. (OPCIONAL) POLÍTICAS DE ACCESO TOTAL EN CASO DE QUE RLS VUELVA A HABILITARSE
DROP POLICY IF EXISTS "Acceso publico productos" ON productos;
CREATE POLICY "Acceso publico productos" ON productos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico competencia" ON productos_competencia;
CREATE POLICY "Acceso publico competencia" ON productos_competencia FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico historico" ON historico_precios;
CREATE POLICY "Acceso publico historico" ON historico_precios FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico scrape_runs" ON scrape_runs;
CREATE POLICY "Acceso publico scrape_runs" ON scrape_runs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico bcv" ON bcv_rates;
CREATE POLICY "Acceso publico bcv" ON bcv_rates FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico cadenas" ON cadenas;
CREATE POLICY "Acceso publico cadenas" ON cadenas FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Acceso publico usuarios" ON usuarios;
CREATE POLICY "Acceso publico usuarios" ON usuarios FOR ALL USING (true) WITH CHECK (true);
