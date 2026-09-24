/**
 * Puente entre los tokens MD3 y Recharts.
 *
 * Recharts pinta SVG y necesita valores de color reales: no entiende las
 * clases de Tailwind. Por eso los gráficos tenían los colores escritos a mano
 * ('#464650' para los ejes, '#f3f3f6' para la rejilla, una lista suelta para
 * las series). Eran valores pensados para fondo claro, así que en modo oscuro
 * los ejes quedaban ilegibles.
 *
 * Aquí se leen los mismos tokens que usa el resto del panel, ya resueltos por
 * el navegador, de modo que los gráficos siguen el tema activo.
 */

function leerToken(nombre, respaldo) {
  if (typeof window === 'undefined') return respaldo;
  try {
    const valor = getComputedStyle(document.documentElement)
      .getPropertyValue(nombre)
      .trim();
    return valor || respaldo;
  } catch {
    return respaldo;
  }
}

/** Colores de ejes, rejilla y tooltip. */
export function tokensGrafico() {
  return {
    eje: leerToken('--md-sys-color-on-surface-variant', '#464650'),
    rejilla: leerToken('--md-sys-color-outline-variant', '#f3f3f6'),
    superficie: leerToken('--md-sys-color-surface-container-lowest', '#ffffff'),
    texto: leerToken('--md-sys-color-on-surface', '#1c1b1f'),
    borde: leerToken('--md-sys-color-outline-variant', '#e0e0e0'),
    positivo: leerToken('--md-sys-color-data-positive', '#16A34A'),
    negativo: leerToken('--md-sys-color-data-negative', '#E11D48'),
  };
}

/**
 * Paleta de series, en el orden definido por el sistema.
 * La serie 1 es el azul de marca, reservado para "Mi Marca".
 */
export function paletaSeries() {
  const respaldos = ['#0F2C59', '#1E6B52', '#3B6470', '#7C3AED', '#D97706', '#0284C7'];
  return respaldos.map((r, i) => leerToken(`--md-sys-color-data-series-${i + 1}`, r));
}

/** Color de una serie por índice, girando cuando se acaban. */
export function colorSerie(indice) {
  const p = paletaSeries();
  return p[indice % p.length];
}
