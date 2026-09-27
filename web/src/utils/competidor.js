// Datos del competidor por separado (fase 33): nombre corto, concentracion y
// tamano. Para los enlaces viejos, que tienen todo en el nombre ("Acetaminofen
// 500 mg Calox Caja x 10 Tabletas"), la concentracion y las unidades se leen
// del nombre.
import { normalizar } from '../components/formulario';

const RE_DOSIS = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|ui|%|g)(?:\s*\/\s*(\d+(?:[.,]\d+)?)?\s*(ml|g|dosis))?/i;
const RE_UNIDADES = /x\s*(\d+(?:[.,]\d+)?)|(\d+)\s*(?:tabletas?|tab|comprimidos?|c[aá]psulas?|caps|grageas?|sobres?|ampollas?|[oó]vulos?)/i;

const numero = (t) => Number(String(t).replace(',', '.'));

// "500 mg", "120 mg/5 ml" con el mismo formato que Productos.
export function concentracionDe(e) {
  if (e?.concentracion) return String(e.concentracion);
  const m = String(e?.nombre_competidor || e?.marca || '').match(RE_DOSIS);
  if (!m || (m[2].toLowerCase() === 'g' && !m[4])) return '';
  const base = `${numero(m[1])} ${m[2].toLowerCase() === 'ui' ? 'UI' : m[2].toLowerCase()}`;
  return m[4] ? `${base}/${m[3] ? numero(m[3]) : 1} ${m[4].toLowerCase()}` : base;
}

// Unidades del empaque: las guardadas (1 = "no se sabe") o las del nombre.
export function unidadesDe(e) {
  const n = Number(e?.unidades_empaque);
  if (n > 1) return n;
  const m = String(e?.nombre_competidor || e?.marca || '').match(RE_UNIDADES);
  const leidas = m ? numero(m[1] || m[2]) : 0;
  return leidas > 1 ? leidas : null;
}

// Clave para comparar dosis: "500 mg" = "500mg" = "500 MG".
export const claveDosis = (t) => normalizar(t).replace(/[^a-z0-9./]/g, '');

// Un competidor es el mismo si coinciden nombre, laboratorio, concentracion y
// tamano: no es lo mismo el acetaminofen 500 x 10 de Calox que el de Leti, ni
// que el 500 x 20 de Calox.
export function claveCompetidor(e) {
  return [
    normalizar(e?.nombre_competidor || e?.marca).replace(/[^a-z0-9]/g, ''),
    normalizar(e?.laboratorio).replace(/[^a-z0-9]/g, ''),
    claveDosis(concentracionDe(e)),
    unidadesDe(e) || '',
  ].join('|');
}
