-- ============================================================================
-- FASE 24: un color unico por cadena
-- ============================================================================
-- dim_cadenas.color_hex existe desde la fase 1, pero con el mismo valor por
-- defecto (#3B82F6) para todas y el panel no lo usaba: cada grafico tenia su
-- propia lista de colores escrita a mano. Desde el PR que acompana esta fase,
-- todos los graficos y tarjetas toman el color de aqui, y se edita en el
-- menu Cadenas.
--
-- Esta fase:
--   1. Pone los colores de marca conocidos (Farmatodo azul, Locatel rojo,
--      SAAS naranja) si la cadena no tiene uno propio.
--   2. Da a las demas cadenas sin color (o con el de por defecto) uno de una
--      paleta, sin repetir.
--   3. Impide que dos cadenas compartan color (indice unico).
--
-- No toca cadenas que ya tengan un color elegido. Se puede correr mas de una
-- vez.
-- ============================================================================

DO $$
DECLARE
    -- Paleta: colores bien distintos entre si, legibles en claro y oscuro.
    -- Se evita el verde: en los graficos es "mi producto".
    paleta TEXT[] := ARRAY[
        '#7C3AED', '#0891B2', '#DB2777', '#CA8A04', '#4F46E5', '#0D9488',
        '#9333EA', '#B45309', '#BE123C', '#0369A1', '#C026D3', '#475569'
    ];
    r RECORD;
    color TEXT;
BEGIN
    -- Sin color elegido = vacio o el de por defecto de la fase 1.
    UPDATE public.dim_cadenas SET color_hex = NULL
    WHERE color_hex IS NULL OR upper(color_hex) IN ('#3B82F6', '#002855', '');

    -- 1. Colores de marca conocidos.
    UPDATE public.dim_cadenas SET color_hex = '#00529B'
    WHERE color_hex IS NULL AND (lower(id) LIKE '%farmatodo%' OR lower(nombre) LIKE '%farmatodo%');
    UPDATE public.dim_cadenas SET color_hex = '#E30613'
    WHERE color_hex IS NULL AND (lower(id) LIKE '%locatel%' OR lower(nombre) LIKE '%locatel%');
    UPDATE public.dim_cadenas SET color_hex = '#EA580C'
    WHERE color_hex IS NULL AND (lower(id) LIKE '%saas%' OR lower(nombre) LIKE '%saas%');

    -- 2. El resto, de la paleta, sin repetir ninguno ya usado.
    FOR r IN SELECT id FROM public.dim_cadenas WHERE color_hex IS NULL ORDER BY nombre LOOP
        SELECT c INTO color
        FROM unnest(paleta) WITH ORDINALITY AS p(c, orden)
        WHERE NOT EXISTS (SELECT 1 FROM public.dim_cadenas d WHERE upper(d.color_hex) = upper(p.c))
        ORDER BY orden
        LIMIT 1;
        IF color IS NULL THEN
            -- Mas cadenas que colores en la paleta: uno generado a partir del id.
            color := '#' || substr(md5(r.id), 1, 6);
        END IF;
        UPDATE public.dim_cadenas SET color_hex = upper(color) WHERE id = r.id;
    END LOOP;

    UPDATE public.dim_cadenas SET color_hex = upper(color_hex) WHERE color_hex IS NOT NULL;
END $$;

-- 3. Dos cadenas no pueden compartir color.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dim_cadenas_color
    ON public.dim_cadenas (upper(color_hex))
    WHERE color_hex IS NOT NULL;

-- COMPROBACION: cada cadena con su color; ninguno repetido.
SELECT id, nombre, color_hex, activo FROM public.dim_cadenas ORDER BY nombre;
