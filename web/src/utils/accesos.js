import { supabase, isSupabaseActive } from '../supabase';

// Registro de accesos (tabla accesos, fase 25). Nunca debe romper el inicio
// o el cierre de sesion: si la funcion no existe todavia, no pasa nada.
export async function registrarAcceso(evento, detalle = null) {
  if (!isSupabaseActive()) return;
  try {
    await supabase.rpc('fn_registrar_acceso', {
      p_evento: evento,
      p_agente: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      // El detalle (la ruta de un menu) existe desde la fase 51.
      ...(detalle ? { p_detalle: detalle } : {}),
    });
  } catch { /* sin registro */ }
}

// Actividad por menu (fase 51): una vez por menu y por sesion del navegador,
// para saber que menus usa cada persona sin llenar la tabla de accesos.
export function registrarMenu(ruta) {
  const menu = `/${String(ruta || '/').split(/[?#]/)[0].split('/')[1] || ''}`;
  const clave = `trackflow.menu_visto.${menu}`;
  try {
    if (sessionStorage.getItem(clave)) return;
    sessionStorage.setItem(clave, '1');
  } catch { /* sin almacenamiento: se anota igual */ }
  registrarAcceso('menu', menu);
}

// Direccion a la que vuelve el enlace de los correos (recuperar contrasena).
export function urlDelPanel() {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${window.location.origin}${base}`;
}

// Traduce los mensajes de Supabase Auth mas comunes.
export function mensajeAuth(error) {
  const m = String(error?.message || error || '');
  if (/invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(m)) return 'Tu correo aún no está confirmado.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
  if (/password should be at least|weak/i.test(m)) return 'La contraseña es muy corta o muy fácil. Usa al menos 8 caracteres.';
  if (/same password|different from the old/i.test(m)) return 'La contraseña nueva debe ser distinta de la anterior.';
  if (/network|fetch/i.test(m)) return 'No hay conexión con el servidor. Revisa tu internet.';
  return m || 'Ocurrió un error inesperado.';
}
