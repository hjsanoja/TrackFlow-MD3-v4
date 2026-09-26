-- ============================================================================
-- FASE 26: sigla de cada cadena
-- ============================================================================
-- Una sigla corta (FT, LC, SA...) para las tarjetas, leyendas y la insignia
-- de color de la cadena en todo el panel. Se edita en el menu Cadenas.
--
-- Rellena las cadenas que no tienen sigla: las conocidas con la suya y el
-- resto con las iniciales del nombre (o las dos primeras letras si es una
-- sola palabra). No toca las que ya tienen una. Se puede correr mas de una
-- vez.
-- ============================================================================

ALTER TABLE public.dim_cadenas ADD COLUMN IF NOT EXISTS sigla VARCHAR(4);

UPDATE public.dim_cadenas SET sigla = 'FT'
WHERE coalesce(sigla, '') = '' AND (lower(id) LIKE '%farmatodo%' OR lower(nombre) LIKE '%farmatodo%');
UPDATE public.dim_cadenas SET sigla = 'LC'
WHERE coalesce(sigla, '') = '' AND (lower(id) LIKE '%locatel%' OR lower(nombre) LIKE '%locatel%');
UPDATE public.dim_cadenas SET sigla = 'SA'
WHERE coalesce(sigla, '') = '' AND (lower(id) LIKE '%saas%' OR lower(nombre) LIKE '%saas%');

-- El resto: iniciales de las palabras (sin "Farmacia(s)" ni "Grupo").
UPDATE public.dim_cadenas d
SET sigla = upper(
    CASE WHEN array_length(p.palabras, 1) >= 2
         THEN left(p.palabras[1], 1) || left(p.palabras[2], 1)
         -- Una palabra: primera letra y la primera mayuscula interna
         -- (FarmaDON -> FD, FarmaGo -> FG); si no hay, la segunda letra.
         ELSE left(coalesce(p.palabras[1], d.nombre), 1) ||
              coalesce(substring(substr(coalesce(p.palabras[1], d.nombre), 2) FROM '[A-ZÁÉÍÓÚÑ]'),
                       substr(coalesce(p.palabras[1], d.nombre), 2, 1))
    END)
FROM (
    SELECT id, array_remove(array_remove(array_remove(
             regexp_split_to_array(trim(regexp_replace(nombre, '[^A-Za-zÁÉÍÓÚÑáéíóúñ ]', ' ', 'g')), '\s+'),
             'Farmacias'), 'Farmacia'), 'Grupo') AS palabras
    FROM public.dim_cadenas
) p
WHERE p.id = d.id AND coalesce(d.sigla, '') = '';

UPDATE public.dim_cadenas SET sigla = upper(sigla) WHERE sigla IS NOT NULL;

-- COMPROBACION: cada cadena con su sigla y su color.
SELECT id, nombre, sigla, color_hex FROM public.dim_cadenas ORDER BY nombre;
