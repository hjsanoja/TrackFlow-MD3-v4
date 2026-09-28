// Permisos del usuario en el panel (fase 41).
//   - Solo un administrador borra. La base de datos tambien lo exige.
//   - menus_solo_lectura: menus que un usuario de consulta ve sin editar.
//   - vence_el: fecha hasta la que tiene acceso.
// Los botones que borran llevan data-borra y los que crean o editan
// data-edita; Layout pone en <body> las clases que los ocultan segun el
// permiso del menu abierto (ver index.css).

export const esAdministrador = (u) => u?.rol === 'administrador';

export function hoyCaracas() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
}

export const accesoVencido = (u) => Boolean(u?.vence_el) && String(u.vence_el).slice(0, 10) < hoyCaracas();

// Menu (ruta de primer nivel) de una direccion: '/competencia?x=1' -> '/competencia'.
export const menuDe = (ruta) => `/${String(ruta || '/').split(/[?#]/)[0].split('/')[1] || ''}`;

export function permisosEn(u, ruta) {
  const admin = esAdministrador(u);
  const menu = menuDe(ruta);
  const soloLectura = !admin && (u?.menus_solo_lectura || []).includes(menu);
  return { admin, puedeBorrar: admin, puedeEditar: !soloLectura, soloLectura };
}
