// Marca o generico de un competidor. Regla (la misma de la fase 29): si su
// nombre empieza con la molecula del producto propio es GENERICO
// ("Acetaminofen Genven 500 mg"); si no, MARCA ("Atamel", "Tempra").
const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function sugerirTipoMercado(nombre, molecula) {
  const palabra = sinAcentos(molecula).split(/\s+/)[0] || '';
  if (palabra.length < 4 || !String(nombre || '').trim()) return 'GENERICO';
  return sinAcentos(nombre).startsWith(palabra) ? 'GENERICO' : 'MARCA';
}

// Lee lo que venga de un CSV o formulario: "marca", "Genérico", "G"...
export function leerTipoMercado(valor) {
  const t = sinAcentos(valor);
  if (!t) return null;
  if (t.startsWith('m')) return 'MARCA';
  if (t.startsWith('g')) return 'GENERICO';
  return undefined; // no valido
}

export const esMarca = (x) => String(x?.tipo_mercado || x?.market_type || '').toUpperCase() === 'MARCA';
