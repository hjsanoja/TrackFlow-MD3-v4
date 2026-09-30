// Piezas compartidas por Cadenas y Relacion (Competencia.jsx).

// Lectores del robot (dim_cadenas.modulo_scraper). Es solo informativo: el
// robot reconoce la tienda por su web. Si lee bien o no lo dice la ultima
// lectura de la cadena (estadoRobot en pages/Cadenas.jsx).
export const LECTORES = [
  { value: 'farmatodo', label: 'Farmatodo' },
  { value: 'locatel', label: 'Locatel' },
  { value: 'farmaciasaas', label: 'Farmacias SAAS' },
  { value: 'farmadon', label: 'FarmaDON' },
  { value: 'grupo_san_ignacio', label: 'Grupo San Ignacio' },
  { value: 'xana', label: 'Farmacias Xana' },
  { value: 'farmago', label: 'FarmaGo' },
  { value: 'generico', label: 'Genérico' },
];
export const lectorDe = (modulo) => LECTORES.find(l => l.value === modulo) ||
  (modulo === 'saas' ? LECTORES[2] : { value: modulo || '', label: modulo || 'Sin lector' });

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
