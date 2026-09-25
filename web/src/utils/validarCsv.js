import { getRowValue } from './csvParser';

/**
 * Validación previa de un CSV, antes de escribir nada en la base.
 *
 * Hasta ahora la importación escribía directamente y solo al final decía
 * cuántas filas habían entrado. Si una fila venía mal, o te enterabas por un
 * mensaje genérico o no te enterabas: quedaba a medias sin saber cuál falló.
 *
 * Aquí se revisa el archivo entero primero y se devuelve un informe con el
 * número de fila y el motivo de cada problema, separando lo que impide
 * importar (errores) de lo que conviene mirar pero no bloquea (avisos).
 */

/** Esquemas de las plantillas. Ver CARGA_CSV.md y DICCIONARIO_CAMPOS.md. */
export const ESQUEMAS = {
  productos: {
    nombre: 'Catálogo de productos',
    columnas: [
      { campo: 'id_interno', etiqueta: 'ID Interno', obligatorio: true,
        alias: ['id', 'codigo', 'código', 'sku', 'clave', 'identificador'] },
      // Solo obligatorio en productos nuevos: para actualizar uno que ya
      // existe basta el id y las columnas que cambian (p. ej. solo el PVP).
      { campo: 'nombre', etiqueta: 'Nombre del Producto', obligatorio: true, soloNuevos: true,
        alias: ['producto', 'descripcion', 'descripción'] },
      { campo: 'laboratorio', etiqueta: 'Laboratorio', obligatorio: false,
        alias: ['fabricante'] },
      { campo: 'categoria', etiqueta: 'Categoría', obligatorio: false, alias: ['categoría'] },
      { campo: 'unidad_negocio', etiqueta: 'Unidad de Negocio', obligatorio: false, alias: ['un'] },
      { campo: 'tipo_mercado', etiqueta: 'Tipo de mercado', obligatorio: false,
        alias: ['market_type'], tipo: 'lista', valores: ['marca', 'generico', 'genérico'] },
      { campo: 'pvp_propio_usd', etiqueta: 'PVP Propio (USD)', obligatorio: false,
        alias: ['pvp', 'pvp_usd', 'precio_usd'], tipo: 'numero' },
      // exacto: getRowValue acepta subcadenas y 'activo' encajaria con
      // 'principio_activo'.
      { campo: 'activo', etiqueta: 'Activo', obligatorio: false, tipo: 'booleano', exacto: true },
    ],
  },
  competencia: {
    nombre: 'Enlaces de competencia',
    columnas: [
      { campo: 'id_interno', etiqueta: 'ID del producto (id_interno)', obligatorio: true,
        alias: ['id_producto_propio', 'producto_propio', 'sku_propio'] },
      { campo: 'cadena', etiqueta: 'Cadena', obligatorio: true },
      { campo: 'url', etiqueta: 'URL del Producto', obligatorio: true, tipo: 'url' },
      { campo: 'tipo', etiqueta: 'Tipo de Enlace', obligatorio: false,
        tipo: 'lista', valores: ['propio', 'alternativa', 'competidor'] },
      { campo: 'marca', etiqueta: 'Competidor', obligatorio: false,
        alias: ['competidor', 'marca_competencia'] },
      { campo: 'laboratorio_competidor', etiqueta: 'Laboratorio del competidor', obligatorio: false,
        alias: ['laboratorio', 'fabricante'] },
      { campo: 'activo', etiqueta: 'Activo', obligatorio: false, tipo: 'booleano', exacto: true },
    ],
  },
};

// Como el importador interpreta la unidad de negocio: 'PH' o cualquier texto
// con 'Pharmetique' es Pharmetique, etc. Lo demas se busca tal cual.
export function resolverUnidadNegocio(texto) {
  const original = String(texto || '').trim();
  const mayus = original.toUpperCase();
  if (mayus.includes('PHARMETIQUE') || mayus === 'PH') return 'Pharmetique';
  if (mayus.includes('OTC')) return 'OTC';
  if (mayus.includes('SANTE') || mayus.includes('SANTÉ')) return 'La Sante';
  return original || 'La Sante';
}

function esNumero(v) {
  return v === '' || !isNaN(parseFloat(String(v).replace(',', '.')));
}

function esBooleano(v) {
  return v === '' || ['si', 'sí', 'no', 'true', 'false', '1', '0', 'x'].includes(String(v).toLowerCase().trim());
}

function esUrl(v) {
  if (!v) return false;
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`);
    // new URL() acepta "no-es-una-url" como nombre de host válido, así que
    // hace falta exigir un dominio con punto y una extensión de al menos dos
    // letras. Si no, una celda con texto suelto pasaba la validación y el
    // scraper acababa intentando visitarla.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {Array<Object>} filas   salida de parseCSV
 * @param {string} tipoEsquema    'productos' | 'competencia'
 * @param {Object} contexto       { idsExistentes: Set } para validaciones cruzadas
 * @returns informe con errores, avisos y las filas que sí se pueden importar
 */
export function validarCsv(filas, tipoEsquema, contexto = {}) {
  const esquema = ESQUEMAS[tipoEsquema];
  if (!esquema) throw new Error(`Esquema desconocido: ${tipoEsquema}`);

  const errores = [];
  const avisos = [];
  const filasValidas = [];
  const clavesVistas = new Map();

  // 1. ¿Están las columnas obligatorias? Se mira en la primera fila, porque
  //    parseCSV ya normalizó los encabezados.
  const primera = filas[0] || {};
  const faltantes = esquema.columnas
    .filter(c => c.obligatorio && !(c.soloNuevos && contexto.idsExistentes))
    .filter(c => !getRowValue(primera, c.campo, ...(c.alias || [])) &&
                 !Object.keys(primera).some(k =>
                   k.toLowerCase().replace(/[^a-z0-9]/g, '') ===
                   c.campo.toLowerCase().replace(/[^a-z0-9]/g, '')));

  if (faltantes.length > 0) {
    return {
      ok: false,
      errores: [{
        fila: 0,
        campo: '',
        mensaje: `Faltan columnas obligatorias: ${faltantes.map(c => c.etiqueta).join(', ')}. ` +
                 `Descarga la plantilla desde el botón de arriba para ver el formato esperado.`,
      }],
      avisos: [],
      filasValidas: [],
      total: filas.length,
    };
  }

  // 2. Fila por fila
  filas.forEach((fila, i) => {
    const numero = i + 2; // +1 por el encabezado, +1 porque las hojas empiezan en 1
    let filaOk = true;

    for (const col of esquema.columnas) {
      const valor = col.exacto
        ? String(fila[Object.keys(fila).find(k => k.trim().toLowerCase() === col.campo)] ?? '').trim()
        : getRowValue(fila, col.campo, ...(col.alias || [])).trim();

      if (col.obligatorio && !valor && col.soloNuevos && contexto.idsExistentes) {
        const idFila = getRowValue(fila, 'id_interno', 'id', 'codigo', 'sku').trim();
        if (contexto.idsExistentes.has(idFila)) continue;
        errores.push({ fila: numero, campo: col.etiqueta, mensaje: 'Obligatorio en un producto nuevo' });
        filaOk = false;
        continue;
      }
      if (col.obligatorio && !valor) {
        errores.push({ fila: numero, campo: col.etiqueta, mensaje: 'Campo obligatorio vacío' });
        filaOk = false;
        continue;
      }
      if (!valor) continue;

      if (col.tipo === 'numero' && !esNumero(valor)) {
        errores.push({ fila: numero, campo: col.etiqueta, mensaje: `"${valor}" no es un número` });
        filaOk = false;
      }
      if (col.tipo === 'url' && !esUrl(valor)) {
        errores.push({ fila: numero, campo: col.etiqueta, mensaje: `"${valor.slice(0, 40)}" no es una dirección válida` });
        filaOk = false;
      }
      if (col.tipo === 'booleano' && !esBooleano(valor)) {
        avisos.push({ fila: numero, campo: col.etiqueta, mensaje: `"${valor}" no se entiende; se tomará como "sí"` });
      }
      if (col.tipo === 'lista' && !col.valores.includes(valor.toLowerCase())) {
        avisos.push({ fila: numero, campo: col.etiqueta, mensaje: `"${valor}" no es un valor conocido (${col.valores.join(', ')})` });
      }
    }

    // 3. Validaciones propias de cada plantilla
    if (tipoEsquema === 'competencia') {
      const idPropio = getRowValue(fila, 'id_interno', 'id_producto_propio').trim();
      const url = getRowValue(fila, 'url').trim();
      const cadena = getRowValue(fila, 'cadena').trim();

      // El producto propio debe existir: es lo que construye la equivalencia.
      if (idPropio && contexto.idsExistentes && !contexto.idsExistentes.has(idPropio)) {
        errores.push({
          fila: numero, campo: 'ID del producto (id_interno)',
          mensaje: `"${idPropio}" no existe en tu catálogo. Cárgalo antes que sus enlaces.`,
        });
        filaOk = false;
      }

      // La clave real de un enlace es cadena + URL sin querystring.
      const clave = `${cadena.toLowerCase()}|${url.replace(/\?.*$/, '').toLowerCase()}`;
      if (clavesVistas.has(clave)) {
        avisos.push({
          fila: numero, campo: 'URL del Producto',
          mensaje: `Repetida: misma cadena y URL que la fila ${clavesVistas.get(clave)}. Se omitirá.`,
        });
        filaOk = false;
      } else {
        clavesVistas.set(clave, numero);
      }

      const tipo = getRowValue(fila, 'tipo').toLowerCase().trim();
      const lab = getRowValue(fila, 'laboratorio_competidor', 'laboratorio', 'fabricante').trim();
      if (tipo !== 'propio' && !lab) {
        avisos.push({
          fila: numero, campo: 'Laboratorio',
          mensaje: 'Sin laboratorio: si el enlace es nuevo, el competidor queda como "OTRO"; si ya existe, se conserva el que tiene',
        });
      }
    }

    if (tipoEsquema === 'productos') {
      const id = getRowValue(fila, 'id_interno', 'id', 'codigo', 'sku').trim();
      if (id) {
        if (clavesVistas.has(id)) {
          avisos.push({
            fila: numero, campo: 'ID Interno',
            mensaje: `Repetido: ya aparece en la fila ${clavesVistas.get(id)}. La última gana.`,
          });
        } else {
          clavesVistas.set(id, numero);
        }
      }

      // Sin molecula la dosis no tiene donde guardarse (producto_principios
      // la necesita), y el nombre limpio de v_csv_productos ya no la lleva:
      // se perderia del todo.
      // Categoria y unidad de negocio no se crean al importar (son catalogos
      // cerrados): si el nombre no existe, el producto conserva la que tenia
      // o, si es nuevo, queda sin ella. Antes pasaba sin avisar.
      // Misma comparacion que al guardar: sin mayusculas, tildes ni signos.
      const clave = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const existe = (lista, valor) => lista.some(n => clave(n) === clave(valor));
      if (contexto.categorias) {
        const cat = getRowValue(fila, 'categoria', 'categoría', 'linea', 'grupo').trim();
        if (cat && !existe(contexto.categorias, cat)) {
          avisos.push({
            fila: numero, campo: 'Categoría',
            mensaje: `"${cat}" no existe en Dimensiones. Se conservará la categoría que tenía (o quedará sin categoría si es nuevo). Créala antes en Dimensiones → Categorías.`,
          });
        }
      }
      if (contexto.unidadesNegocio) {
        const unRaw = getRowValue(fila, 'unidad_negocio', 'Unidad de Negocio', 'Unidad Negocio', 'un', 'linea_negocio').trim();
        const un = resolverUnidadNegocio(unRaw);
        if (unRaw && !existe(contexto.unidadesNegocio, un)) {
          avisos.push({
            fila: numero, campo: 'Unidad de Negocio',
            mensaje: `"${unRaw}" no existe en Dimensiones. Se conservará la unidad que tenía (o quedará sin unidad si es nuevo). Créala antes en Dimensiones → Unidades de Negocio.`,
          });
        }
      }

      const molecula = getRowValue(fila, 'principio_activo', 'molecula', 'molécula').trim();
      const dosis = getRowValue(fila, 'concentracion', 'dosis').trim();
      if (dosis && !molecula) {
        avisos.push({
          fila: numero, campo: 'Principio Activo',
          mensaje: `Trae concentración (${dosis}) pero no principio activo: la dosis no se guardará.`,
        });
      }
    }

    if (filaOk) filasValidas.push({ ...fila, __fila: numero });
  });

  return {
    ok: errores.length === 0,
    errores,
    avisos,
    filasValidas,
    total: filas.length,
  };
}
