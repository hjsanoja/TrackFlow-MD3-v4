// Piezas de presentacion compartidas por Productos y Competencia.

// Un enlace esta "caido" si no trae precio desde hace mas de 7 dias (o nunca
// lo trajo): suele ser una URL que la tienda cambio o retiro.
export const DIAS_ENLACE_CAIDO = 7;
export function enlaceCaido(e) {
  if (!e.ultimo_scrape) return true;
  return (Date.now() - new Date(e.ultimo_scrape).getTime()) / 86400000 > DIAS_ENLACE_CAIDO;
}

// "20 tabletas", "120 ml · Jarabe", "30 g · Crema". Antes salia "20 unidad"
// mas una etiqueta "20u", y en los jarabes "120u", que se leia como 120
// unidades. El volumen y el peso se dicen en ml y g; las unidades se nombran
// con la forma farmaceutica cuando la hay.
const NOMBRES_POR_FORMA = [
  [/tableta/i, 'tableta', 'tabletas'],
  [/c[aá]psula/i, 'cápsula', 'cápsulas'],
  [/comprimido/i, 'comprimido', 'comprimidos'],
  [/sobre/i, 'sobre', 'sobres'],
  [/ampolla/i, 'ampolla', 'ampollas'],
  [/[oó]vulo/i, 'óvulo', 'óvulos'],
];

export function describirPresentacion(p) {
  const forma = p.forma_farmaceutica || '';
  const m = String(p.tamano || '').match(/^\s*([\d.,]+)\s*(ml|g|unidad(?:es)?)?/i);
  if (!m) return forma || '—';
  const n = Number(m[1].replace(',', '.'));
  const cantidad = Number.isFinite(n) ? n.toLocaleString('es-VE') : m[1];
  const unidad = (m[2] || 'unidad').toLowerCase();
  if (unidad === 'ml' || unidad === 'g') return forma ? `${cantidad} ${unidad} · ${forma}` : `${cantidad} ${unidad}`;
  const nombres = NOMBRES_POR_FORMA.find(([re]) => re.test(forma));
  if (nombres) return `${cantidad} ${n === 1 ? nombres[1] : nombres[2]}`;
  const texto = `${cantidad} ${n === 1 ? 'unidad' : 'unidades'}`;
  return forma ? `${texto} · ${forma}` : texto;
}
