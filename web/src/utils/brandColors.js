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

/**
 * Get brand color for a Cadena
 */
export function getChainColor(chainName) {
  if (!chainName) return '#475569';
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
