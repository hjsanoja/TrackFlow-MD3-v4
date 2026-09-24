// Convierte el texto libre que llega del formulario o del CSV en las filas
// atomicas que espera el esquema: producto_principios (molecula + dosis) y
// dim_productos.cantidad_contenido (tamano del empaque).
//
// Hasta ahora estos dos campos se recogian en la pantalla de Productos y se
// perdian antes de llegar a la base: dbUpsertProducto los metia en cleanData y
// solo los escribia en la tabla legacy `productos`, que desde la Fase 5 es una
// vista de solo lectura. Por eso la unica forma de saber la dosis de un
// producto era leerla dentro del nombre.

// El CHECK de producto_principios.concentracion_unidad solo admite estas cinco.
const UNIDADES_CONCENTRACION = ['mg', 'g', 'mcg', 'UI', '%'];
// El de por_unidad, solo estas tres.
const UNIDADES_POR = ['ml', 'g', 'dosis'];
// El de dim_productos.unidad_contenido, solo estas tres.
const UNIDADES_CONTENIDO = ['unidad', 'ml', 'g'];

const ALIAS_UNIDAD = {
  mg: 'mg', miligramo: 'mg', miligramos: 'mg',
  g: 'g', gr: 'g', gramo: 'g', gramos: 'g',
  mcg: 'mcg', ug: 'mcg', µg: 'mcg', microgramo: 'mcg', microgramos: 'mcg',
  ui: 'UI', iu: 'UI', u: 'UI',
  '%': '%'
};

function normalizarUnidad(u) {
  if (!u) return null;
  const clave = String(u).trim().toLowerCase();
  const norm = ALIAS_UNIDAD[clave] || null;
  return UNIDADES_CONCENTRACION.includes(norm) ? norm : null;
}

function normalizarUnidadPor(u) {
  if (!u) return null;
  const clave = String(u).trim().toLowerCase();
  const norm = clave === 'gr' ? 'g' : clave;
  return UNIDADES_POR.includes(norm) ? norm : null;
}

// "12,5" y "12.5" son el mismo numero: en Venezuela se escribe con coma.
function aNumero(txt) {
  if (txt === undefined || txt === null || txt === '') return null;
  const n = Number(String(txt).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "300mg", "12,5 mg", "250mg/5ml", "10 mg/ml", "4%"
const RE_DOSIS = /^([\d.,]+)\s*(mg|miligramos?|g|gr|gramos?|mcg|ug|µg|microgramos?|ui|iu|u|%)\s*(?:\/\s*([\d.,]+)?\s*(ml|g|gr|dosis)\s*)?$/i;

export function parsearDosis(texto) {
  if (!texto) return null;
  const m = String(texto).trim().match(RE_DOSIS);
  if (!m) return null;

  const valor = aNumero(m[1]);
  const unidad = normalizarUnidad(m[2]);
  if (valor === null || !unidad) return null;

  const porUnidad = normalizarUnidadPor(m[4]);
  // "10 mg/ml" no trae numero tras la barra: se entiende "por 1 ml".
  const porCantidad = porUnidad ? (aNumero(m[3]) ?? 1) : null;

  return { valor, unidad, porCantidad, porUnidad };
}

// Separa por "+" respetando espacios: "Losartán + Hidroclorotiazida".
function partir(texto) {
  if (!texto) return [];
  return String(texto).split('+').map(t => t.trim()).filter(Boolean);
}

// Empareja moleculas con dosis por posicion. La primera molecula es la rectora
// (es_principal), que el esquema limita a una sola por producto mediante un
// indice unico parcial.
//
// Cuando hay una sola dosis y varias moleculas (o al reves) NO se reparte a
// ciegas: se emparejan las que coinciden por posicion y el resto queda sin
// concentracion. Una fila sin concentracion no se puede guardar porque la
// columna es NOT NULL CHECK (> 0), asi que se descarta en vez de inventarla.
export function parsearPrincipios(principioActivo, concentracion) {
  const nombres = partir(principioActivo);
  if (nombres.length === 0) return [];

  const dosis = partir(concentracion).map(parsearDosis);

  return nombres.map((nombre, i) => {
    const d = dosis[i] || null;
    return d ? { nombre, esPrincipal: i === 0, ...d } : null;
  }).filter(Boolean);
}

// "10 tabletas" -> 10 unidad / "120 ml" -> 120 ml / "30 g" -> 30 g
// Es lo que va a dim_productos.cantidad_contenido + unidad_contenido.
export function parsearContenido(tamano, unidosis) {
  const texto = String(tamano || '').trim();

  const mVolumen = texto.match(/([\d.,]+)\s*(ml|mililitros?)\b/i);
  if (mVolumen) {
    const v = aNumero(mVolumen[1]);
    if (v !== null) return { cantidad: v, unidad: 'ml' };
  }

  // El peso solo cuenta si NO lleva "mg"/"mcg" delante, que son concentracion.
  const mPeso = texto.match(/(?:^|[^cm])\b([\d.,]+)\s*(g|gr|gramos?)\b/i);
  if (mPeso) {
    const v = aNumero(mPeso[1]);
    if (v !== null) return { cantidad: v, unidad: 'g' };
  }

  // "10 tabletas", "x 12 cápsulas", o el numero que ya venia calculado.
  // "10 unidad" en singular es como lo exporta v_csv_productos cuando toma
  // el empaque guardado; antes no encajaba y el producto quedaba en 1.
  const mUnidades = texto.match(/([\d.,]+)\s*(tab|tabletas?|c[aá]p(?:sulas?)?|comp(?:rimidos?)?|amp(?:ollas?)?|sobres?|unidad(?:es)?|u)\b/i);
  const porTexto = mUnidades ? aNumero(mUnidades[1]) : null;
  const porCampo = aNumero(unidosis);
  const cantidad = porTexto ?? porCampo;

  return { cantidad: cantidad ?? 1, unidad: 'unidad' };
}

export { UNIDADES_CONCENTRACION, UNIDADES_POR, UNIDADES_CONTENIDO };
