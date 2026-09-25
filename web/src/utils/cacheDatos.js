// Copia local de los datos del panel (productos, enlaces, precios...). Se
// guarda en el navegador para pintar al instante al volver a entrar; los
// datos frescos llegan unos segundos despues y la reemplazan.
//
// Va en localStorage (sobrevive a cerrar la pestana) y marcada con el correo
// del usuario: si entra otra persona en el mismo navegador no ve la copia
// del anterior. Al cerrar sesion se borra.
export const CLAVE_CACHE = 'trackflow_data_cache_v4';
const CLAVES_VIEJAS = ['trackflow_data_cache_v3'];
// Una copia de mas de 3 dias no se muestra: mejor esperar a los datos nuevos.
const MAX_EDAD_MS = 3 * 24 * 60 * 60 * 1000;

export function leerCache(email) {
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE_CACHE) || 'null');
    if (!c || !email || c.email !== email) return null;
    if (Date.now() - (c.timestamp || 0) > MAX_EDAD_MS) return null;
    return c;
  } catch {
    return null;
  }
}

export function guardarCache(email, datos) {
  if (!email) return;
  try {
    localStorage.setItem(CLAVE_CACHE, JSON.stringify({ email, timestamp: Date.now(), ...datos }));
  } catch {
    // Sin espacio o sin almacenamiento: se trabaja sin copia.
  }
}

export function limpiarCacheDatos() {
  for (const clave of [CLAVE_CACHE, ...CLAVES_VIEJAS]) {
    try { localStorage.removeItem(clave); } catch { /* sin almacenamiento */ }
    try { sessionStorage.removeItem(clave); } catch { /* sin almacenamiento */ }
  }
}
