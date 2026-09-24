import { getRowValue } from './csvParser';
import { resolverUnidadNegocio } from './validarCsv';
import { parsearContenido } from './parsearFicha';

/**
 * Lee una fila del CSV de productos tal como viene: una celda vacia queda
 * vacia (no se rellena con un valor por defecto). La usan el importador y la
 * revision previa "antes -> despues", para que las dos entiendan el archivo
 * exactamente igual.
 */
export function leerFilaProducto(row) {
  const id = getRowValue(row,
    'id_interno', 'id', 'ID Interno', 'ID_INTERNO', 'ID', 'codigo', 'código',
    'cod', 'item', 'ref', 'sku', 'plu', 'clave', 'identificador', 'ID_PRODUCTO', 'PRODUCTO_ID').trim();
  const nombre = getRowValue(row,
    'nombre', 'Nombre', 'nombre_producto', 'Nombre Producto', 'producto',
    'descripcion', 'descripción', 'descripcion_producto', 'desc', 'item_name',
    'articulo', 'artículo', 'denominacion', 'denominación', 'PRODUCTO').trim();
  const codigo_barra = getRowValue(row,
    'codigo_barra', 'Código de Barra', 'Codigo de Barra', 'codigo_barras',
    'Código de Barras', 'Codigo de Barras', 'gtin', 'GTIN', 'ean', 'EAN',
    'upc', 'UPC', 'barcode', 'Bar Code', 'barcode_id').trim();
  const principio_activo = getRowValue(row, 'principio_activo', 'Principio Activo', 'molecula', 'molécula', 'Molecula', 'sustancia_activa').trim();
  const concentracion = getRowValue(row, 'concentracion', 'Concentración', 'Concentracion', 'dosis', 'concentracion_mg', 'conc').trim();
  const tamano = getRowValue(row, 'tamano', 'Tamaño', 'Tamano', 'tamano_empaque', 'presentacion', 'Presentación', 'Presentacion', 'empaque').trim();
  const forma_farmaceutica = getRowValue(row, 'forma_farmaceutica', 'Forma Farmacéutica', 'Forma Farmaceutica', 'forma', 'Forma').trim();
  const laboratorio = getRowValue(row, 'laboratorio', 'Laboratorio', 'lab', 'Lab', 'fabricante').trim();
  const categoria = getRowValue(row, 'categoria', 'Categoría', 'Categoria', 'linea', 'grupo').trim();
  const unRaw = getRowValue(row, 'unidad_negocio', 'Unidad de Negocio', 'Unidad Negocio', 'unidad', 'un', 'UN', 'linea_negocio').trim();
  const tipoRaw = getRowValue(row, 'tipo_mercado', 'market_type', 'Market Type', 'Tipo').trim().toUpperCase();

  // Busqueda exacta: getRowValue acepta subcadenas y 'activo' encajaria con
  // 'principio_activo'.
  const claveActivo = Object.keys(row).find(k => k.trim().toLowerCase() === 'activo');
  const activoRaw = claveActivo ? String(row[claveActivo] ?? '').trim().toLowerCase() : '';

  const pvpRaw = getRowValue(row, 'pvp_propio_usd', 'PVP Propio USD', 'pvp', 'precio', 'pvp usd', 'precio usd', 'mi precio lista (usd)').trim();
  const pvp = parseFloat(pvpRaw.replace(',', '.'));

  return {
    id,
    nombre,
    codigo_barra,
    principio_activo,
    concentracion,
    tamano,
    forma_farmaceutica,
    laboratorio,
    categoria,
    unidad_negocio: unRaw ? resolverUnidadNegocio(unRaw) : '',
    market_type: tipoRaw ? (tipoRaw.includes('MARCA') ? 'MARCA' : 'GENERICO') : undefined,
    activo: activoRaw ? !['no', 'false', '0'].includes(activoRaw) : undefined,
    pvp_propio_usd: Number.isFinite(pvp) && pvp > 0 ? pvp : 0,
  };
}

const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// "500 MG" = "500mg"; "250 mg/5 ml" = "250mg/5ml".
const sinEspacios = (t) => norm(t).replace(/\s/g, '');

const CAMPOS = [
  { campo: 'nombre', etiqueta: 'Nombre', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'codigo_barra', etiqueta: 'Código de barras', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'principio_activo', etiqueta: 'Molécula', igual: (a, b) => sinEspacios(a) === sinEspacios(b) },
  { campo: 'concentracion', etiqueta: 'Dosis', igual: (a, b) => sinEspacios(a).replace(/-/g, '+') === sinEspacios(b).replace(/-/g, '+') },
  {
    campo: 'tamano', etiqueta: 'Empaque',
    igual: (a, b) => {
      const ca = parsearContenido(a);
      const cb = parsearContenido(b);
      return ca.cantidad === cb.cantidad && ca.unidad === cb.unidad;
    },
  },
  { campo: 'forma_farmaceutica', etiqueta: 'Forma', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'laboratorio', etiqueta: 'Laboratorio', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'categoria', etiqueta: 'Categoría', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'unidad_negocio', etiqueta: 'Unidad de negocio', igual: (a, b) => norm(a) === norm(b) },
  { campo: 'market_type', etiqueta: 'Tipo', igual: (a, b) => norm(a) === norm(b), mostrar: v => (v === 'MARCA' ? 'Marca' : 'Genérico') },
  { campo: 'activo', etiqueta: 'Estado', igual: (a, b) => Boolean(a) === Boolean(b), mostrar: v => (v ? 'Activo' : 'De baja') },
  {
    campo: 'pvp_propio_usd', etiqueta: 'PVP',
    igual: (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005,
    mostrar: v => (Number(v) > 0 ? `$${Number(v).toFixed(2)}` : '—'),
  },
];

const vacio = (v) => v === undefined || v === null || v === '' || (typeof v === 'number' && v === 0);

/**
 * Compara cada fila con el producto guardado. Solo cuentan las celdas con
 * valor: una vacia no cambia nada.
 * @returns {{ nuevos: Array, conCambios: Array, sinCambios: number }}
 */
export function calcularCambios(filas, productosPorId) {
  const nuevos = [];
  const conCambios = [];
  let sinCambios = 0;

  for (const row of filas) {
    const f = leerFilaProducto(row);
    if (!f.id) continue;
    const actual = productosPorId.get(f.id);
    if (!actual) {
      nuevos.push({ id: f.id, nombre: f.nombre });
      continue;
    }
    const cambios = [];
    for (const c of CAMPOS) {
      const nuevo = f[c.campo];
      if (vacio(nuevo) && c.campo !== 'activo') continue;
      if (nuevo === undefined) continue;
      const antes = actual[c.campo];
      if (!c.igual(antes, nuevo)) {
        const ver = c.mostrar || (v => (vacio(v) ? '—' : String(v)));
        cambios.push({ etiqueta: c.etiqueta, antes: ver(antes), despues: ver(nuevo) });
      }
    }
    if (cambios.length > 0) conCambios.push({ id: f.id, nombre: actual.nombre, cambios });
    else sinCambios++;
  }
  return { nuevos, conCambios, sinCambios };
}
