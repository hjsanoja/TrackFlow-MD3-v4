// Piezas compartidas por Cadenas y Competencia.

// Lectores del robot. "probado": el robot tiene reglas propias para esa
// tienda y se sabe que lee bien. El resto se intenta con el lector generico
// (busca el precio en la pagina) y puede fallar.
export const LECTORES = [
  { value: 'farmatodo', label: 'Farmatodo', probado: true },
  { value: 'locatel', label: 'Locatel', probado: true },
  { value: 'farmaciasaas', label: 'Farmacias SAAS', probado: true },
  { value: 'farmadon', label: 'FarmaDON', probado: false },
  { value: 'grupo_san_ignacio', label: 'Grupo San Ignacio', probado: false },
  { value: 'xana', label: 'Farmacias Xana', probado: false },
  { value: 'farmago', label: 'FarmaGo', probado: false },
  { value: 'generico', label: 'Genérico', probado: false },
];
export const lectorDe = (modulo) => LECTORES.find(l => l.value === modulo) ||
  (modulo === 'saas' ? LECTORES[2] : { value: modulo || '', label: modulo || 'Sin lector', probado: false });

// Dominio sin "www." ("farmatodo.com.ve").
export function dominio(url) {
  if (!url) return '';
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// El enlace es de otra web que la de su cadena (p. ej. una URL de Locatel
// cargada en Farmatodo). Sin web de la cadena no se puede saber: false.
export function esDeOtraWeb(url, websiteCadena) {
  const a = dominio(url);
  const b = dominio(websiteCadena);
  if (!a || !b) return false;
  return !(a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}
