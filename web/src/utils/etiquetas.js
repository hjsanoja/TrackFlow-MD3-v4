/**
 * Etiquetas visibles del panel, en un solo lugar.
 *
 * Regla: un campo se llama IGUAL en la tabla, en el formulario, en el filtro,
 * en el desplegable, en el eje del gráfico y en el CSV exportado. Si necesitas
 * el texto de un campo, impórtalo de aquí en vez de escribirlo a mano; así no
 * vuelven a aparecer tres nombres para el mismo dato.
 *
 * Los nombres de columna de la base están en DICCIONARIO_CAMPOS.md. Este
 * archivo es la capa visible equivalente.
 */
export const ETIQUETAS = {
  // --- Producto ---
  id_interno: 'ID Interno',
  nombre_producto: 'Nombre del Producto',
  laboratorio: 'Laboratorio',
  unidad_negocio: 'Unidad de Negocio',
  categoria: 'Categoría',
  forma_farmaceutica: 'Forma Farmacéutica',
  principio_activo: 'Principio Activo',
  concentracion: 'Concentración',
  presentacion: 'Presentación',
  unidosis: 'Unidades por Empaque',
  codigo_barra: 'Código de Barras',
  pvp_propio: 'PVP Propio (USD)',
  tipo_mercado: 'Tipo de Mercado',

  // --- Cadena ---
  cadena: 'Cadena',
  nombre_cadena: 'Nombre de la Cadena',
  id_cadena: 'ID de la Cadena',
  website: 'Sitio Web',
  scraper_modulo: 'Módulo de Scraping',
  color_cadena: 'Color de la Cadena',

  // --- Enlace de competencia ---
  url: 'URL del Producto',
  tipo_enlace: 'Tipo de Enlace',
  producto_propio: 'Producto Propio Equivalente',

  // --- Precios ---
  precio_lista: 'Precio de Lista',
  precio_descuento: 'Precio con Descuento',
  tasa_bcv: 'Tasa BCV',
  variacion: 'Variación',
  ultima_captura: 'Última Captura',

  // --- Analisis ---
  marca: 'Marca',
  costo_unidad: 'Costo por Unidad',

  // --- Comunes ---
  activo: 'Activo',
  acciones: 'Acciones',
  estado: 'Estado'
};

/**
 * Añade el asterisco de campo obligatorio sin duplicar el texto de la etiqueta.
 * Uso: <Field label={obligatorio(ETIQUETAS.nombre_producto)}>
 */
export function obligatorio(etiqueta) {
  return `${etiqueta} *`;
}
