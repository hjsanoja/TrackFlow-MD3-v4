// Global Utility for Consistent Brand & Laboratory Colors (MD3 / TrackFlow Theme)

const CHAIN_COLORS = {
  'farmatodo': '#00529B',
  'locatel': '#E30613',
  'redvital': '#E81C24',
  'farmahorro': '#009639',
  'saas': '#FF6600',
  'farmacias saas': '#FF6600',
  'titan': '#016874',
  'farmatitan': '#016874',
  'botiqueria': '#8E24AA',
  'fundafarmacia': '#00838F',
  'propia': '#016874',
  'generico': '#059669',
};

const LAB_COLORS = {
  'genfar': '#0284C7',
  'leti': '#16A34A',
  'calox': '#DC2626',
  'meyer': '#7C3AED',
  'nolver': '#2563EB',
  'behrens': '#0D9488',
  'pfeizer': '#0284C7',
  'bayer': '#16A34A',
  'roche': '#E11D48',
  'sanofi': '#9333EA',
  'mankind': '#D97706',
};

/**
 * Deterministic hash to generate a pleasant, reproducible color for any string
 */
function stringToColor(str) {
  if (!str) return '#475569';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  // Saturation 65%, Lightness 42% for clean contrast and legibility
  return `hsl(${h}, 65%, 42%)`;
}

// Colores para elegir en el menu Cadenas: los de marca conocidos y una paleta
// bien distinta entre si (la misma de la fase 24). Sin verdes: en los
// graficos el verde es "mi producto".
export const PALETA_CADENAS = [
  '#00529B', '#E30613', '#EA580C', '#7C3AED', '#0891B2', '#DB2777',
  '#CA8A04', '#4F46E5', '#0D9488', '#9333EA', '#B45309', '#BE123C',
  '#0369A1', '#C026D3', '#475569',
];

// Colores elegidos en el menu Cadenas (dim_cadenas.color_hex, fase 24).
// DataContext los registra al cargar las cadenas; se buscan por id ('Saas')
// y por nombre ('Farmacias SAAS'), porque los datos traen uno u otro.
const coloresRegistrados = new Map();

/** Guarda los colores de las cadenas para que todos los graficos usen los mismos. */
export function registrarColoresCadenas(cadenas) {
  coloresRegistrados.clear();
  for (const c of cadenas || []) {
    if (!/^#[0-9a-f]{6}$/i.test(c.color_hex || '')) continue;
    if (c.id) coloresRegistrados.set(String(c.id).toLowerCase().trim(), c.color_hex);
    if (c.nombre) coloresRegistrados.set(String(c.nombre).toLowerCase().trim(), c.color_hex);
  }
}

/** Color guardado para la cadena, o null si no tiene (para usar otro de respaldo). */
export function colorCadenaRegistrado(chainName) {
  if (!chainName) return null;
  return coloresRegistrados.get(String(chainName).toLowerCase().trim()) || null;
}

/**
 * Color de una cadena: el elegido en el menu Cadenas; si no hay, el de marca
 * conocido; si tampoco, uno fijo calculado a partir del nombre.
 */
export function getChainColor(chainName) {
  if (!chainName) return '#475569';
  const registrado = colorCadenaRegistrado(chainName);
  if (registrado) return registrado;
  const norm = chainName.toLowerCase().trim();
  for (const [key, color] of Object.entries(CHAIN_COLORS)) {
    if (norm.includes(key)) return color;
  }
  return stringToColor(chainName);
}

/**
 * Get brand color for a Laboratory
 */
export function getLabColor(labName) {
  if (!labName) return '#016874';
  const norm = labName.toLowerCase().trim();
  for (const [key, color] of Object.entries(LAB_COLORS)) {
    if (norm.includes(key)) return color;
  }
  return stringToColor(labName);
}

/**
 * Helper to get subtle background tint corresponding to a brand color
 */
export function getBrandBgTint(hexOrHsl) {
  if (!hexOrHsl) return 'rgba(1, 104, 116, 0.08)';
  return `${hexOrHsl}15`; // ~8% opacity
}
