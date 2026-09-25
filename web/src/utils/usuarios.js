// Piezas compartidas por Usuarios, Mi cuenta y App.

export const AVAILABLE_MENUS = [
  { id: '/', label: 'Dashboard', desc: 'Indicadores y KPIs de precios', icon: 'dashboard', isDefault: true },
  { id: '/mapa-calor', label: 'Mapa de Calor', desc: 'Posición frente al mercado', icon: 'thermostat', isDefault: true },
  { id: '/experimental', label: 'Experimental', desc: 'Revisión de capturas, devaluación, canibalización y simulador', icon: 'science', isDefault: false },
  { id: '/productos', label: 'Productos', desc: 'Catálogo de productos propios', icon: 'medication', isDefault: false },
  { id: '/competencia', label: 'Competencia', desc: 'Enlaces y precios de la competencia', icon: 'link', isDefault: false },
  { id: '/cadenas', label: 'Cadenas', desc: 'Cadenas de farmacias vigiladas', icon: 'storefront', isDefault: false },
  { id: '/dimensiones', label: 'Dimensiones', desc: 'Laboratorios, categorías, moléculas…', icon: 'schema', isDefault: false },
];

export const DEFAULT_CONSULTA_MENUS = ['/', '/mapa-calor'];

export const esUsuarioActivo = (u) => Boolean(u) && (u.activo === true || u.activo === 'si' || u.activo === 'sí');

const EVENTOS = {
  ingreso: { texto: 'Entró al panel', icono: 'login' },
  salida: { texto: 'Cerró sesión', icono: 'logout' },
  clave_cambiada: { texto: 'Cambió su contraseña', icono: 'lock_reset' },
  recuperacion: { texto: 'Pidió recuperar la contraseña', icono: 'mail_lock' },
};
export const etiquetaEvento = (e) => EVENTOS[e] || { texto: e, icono: 'history' };

export function fechaHora(v) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString('es-VE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// "Hace 3 días", "Hoy 10:15"…
export function haceCuanto(v) {
  if (!v) return 'Nunca';
  const d = new Date(v);
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  const hora = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  if (dias <= 0 && new Date().toDateString() === d.toDateString()) return `Hoy ${hora}`;
  if (dias <= 1) return `Ayer ${hora}`;
  if (dias < 30) return `Hace ${dias} días`;
  return d.toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
}
