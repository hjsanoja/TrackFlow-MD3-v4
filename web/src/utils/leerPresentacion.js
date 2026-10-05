// Dosis y tamano que se leen en un nombre de tienda. Misma regla que
// fn_leer_presentacion (fase 49) y leer_presentacion del buscador (Python).
//   "Losartan 50 mg x 30 Tabletas"            -> { dosis_mg: 50, tamano: 30, unidad: 'unidad' }
//   "Jarabe 180mg/5ml 120ml"                  -> { dosis_mg: 180, tamano: 120, unidad: 'ml' }
//   "Prolardii 10 Sobres x 1.3 gr"            -> { dosis_mg: null, tamano: 10, unidad: 'unidad' }
//     (el "x 1.3 gr" es el peso de cada sobre, no la cantidad)
export function leerPresentacion(texto) {
  const s = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|g)(?![a-wyz])/);
  const xv = s.match(/(?:^|[^a-z]|mg|mcg)x\s*(\d+(?:\.\d+)?)\s*(ml|g)\b/);
  const xn = s.match(/(?:^|[^a-z]|mg|mcg)x\s*(\d+)(?![\d.])(?!\s*(?:mg|mcg|g|gr|grs|ml)\b)/);
  const fn = s.match(/(\d+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|capsula|caps|grageas|sobres|ampollas|ampolla|ovulos|parches|unidades|und)\b/);
  const mls = [...s.matchAll(/(?<![/\d.])(\d+(?:\.\d+)?)\s*ml\b/g)];

  let dosis = null;
  if (m && !(m[2] === 'g' && new RegExp(`x\\s*${m[1].replace('.', '\\.')}\\s*g\\b`).test(s))) {
    const v = Number(m[1]);
    dosis = m[2] === 'mcg' ? v / 1000 : m[2] === 'g' ? v * 1000 : v;
  }
  const ml = mls.length ? Number(mls.at(-1)[1]) : null;
  if (xv) return { dosis_mg: dosis, tamano: Number(xv[1]), unidad: xv[2] };
  if (ml > 5) return { dosis_mg: dosis, tamano: ml, unidad: 'ml' };
  if (xn) return { dosis_mg: dosis, tamano: Number(xn[1]), unidad: 'unidad' };
  if (fn) return { dosis_mg: dosis, tamano: Number(fn[1]), unidad: 'unidad' };
  return { dosis_mg: dosis, tamano: null, unidad: null };
}

const decimal = (v) => Number(v).toLocaleString('es-VE', { maximumFractionDigits: 3 });

// "500 mg", "1 g"
export function textoDosis(mg) {
  if (mg == null) return '';
  const n = Number(mg);
  return n >= 1000 && n % 1000 === 0 ? `${n / 1000} g` : `${decimal(n)} mg`;
}

// "x 30", "120 ml", "30 g"
export function textoTamano(tamano, unidad) {
  if (tamano == null) return '';
  if (unidad === 'ml') return `${decimal(tamano)} ml`;
  if (unidad === 'g') return `${decimal(tamano)} g`;
  return `x ${decimal(tamano)}`;
}
