-- ============================================================================
-- TRACKFLOW - DDL FASE 1: POLÍTICAS RLS (fase1_rls.sql)
-- ============================================================================
-- ORDEN DE EJECUCIÓN:
-- 1. Ejecutar ÚNICAMENTE DESPUÉS de:
--    a) Haber corrido fase1_esquema.sql exitosamente.
--    b) Haber verificado que tus usuarios existen en Supabase -> Authentication -> Users.
--    c) Haber confirmado que el login con Supabase Auth funciona en el frontend.
--    d) Haber confirmado que el scraper en GitHub Actions usa service_role_key.
-- 2. Este script blinda las 17 tablas: CERO acceso para anon, acceso granular
--    para authenticated (Supabase Auth).
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 6. POLÍTICAS RLS (A2: Granulares, sin 'anon', sin service_role innecesario)
-- ----------------------------------------------------------------------------

-- Habilitar RLS en todas las tablas
ALTER TABLE public.dim_cadenas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_laboratorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_marcas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_unidades_negocio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_formas_farmaceuticas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_tipos_promocion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_principios_activos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_tasa_bcv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.producto_principios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvp_propio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.producto_equivalencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publicaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.config_calidad ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_precios ENABLE ROW LEVEL SECURITY;

-- Catálogos y Entidades: SELECT, INSERT, UPDATE para authenticated (sin DELETE por borrado lógico)
DO $$ 
DECLARE 
    t TEXT;
BEGIN
    FOR t IN 
        SELECT unnest(ARRAY[
            'dim_cadenas', 'dim_laboratorios', 'dim_marcas', 'dim_categorias', 
            'dim_unidades_negocio', 'dim_formas_farmaceuticas', 'dim_tipos_promocion', 
            'dim_principios_activos', 'dim_productos', 'producto_principios', 
            'pvp_propio', 'producto_equivalencias', 'publicaciones', 'config_calidad'
        ])
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_select_%I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "auth_select_%I" ON %I FOR SELECT TO authenticated USING (true)', t, t);
        
        EXECUTE format('DROP POLICY IF EXISTS "auth_insert_%I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "auth_insert_%I" ON %I FOR INSERT TO authenticated WITH CHECK (true)', t, t);

        EXECUTE format('DROP POLICY IF EXISTS "auth_update_%I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "auth_update_%I" ON %I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t, t);
    END LOOP;
END $$;

-- Tablas Operativas y Hechos: Solo SELECT para authenticated
-- (La inserción y modificación de capturas queda reservada al scraper vía service_role)
DO $$ 
DECLARE 
    t TEXT;
BEGIN
    FOR t IN 
        SELECT unnest(ARRAY['fact_precios', 'scrape_runs', 'dim_tasa_bcv', 'audit_log'])
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_select_%I" ON %I', t, t);
        EXECUTE format('CREATE POLICY "auth_select_%I" ON %I FOR SELECT TO authenticated USING (true)', t, t);
    END LOOP;
END $$;


-- ----------------------------------------------------------------------------
-- CONSULTAS DE VERIFICACIÓN POST-EJECUCIÓN RLS
-- ----------------------------------------------------------------------------

-- Verificación 2: RLS habilitado en todas las tablas públicas
/*
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
ORDER BY tablename;
*/

-- Verificación 3: Listado de políticas activas (Confirmar CERO para 'anon' y roles correctos)
/*
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;
*/
