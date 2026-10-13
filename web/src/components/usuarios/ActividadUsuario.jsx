import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import { AVAILABLE_MENUS, fechaHora, haceCuanto } from '../../utils/usuarios';

// Ficha del usuario (fase 51): que menus usa (30 dias) y el historial de sus
// permisos (quien le dio o le quito que, y cuando). Sin la fase, no sale.
const NOMBRE_MENU = Object.fromEntries([...AVAILABLE_MENUS.map(m => [m.id, m.label]), ['/usuarios', 'Usuarios'], ['/mi-cuenta', 'Mi cuenta']]);
const CAMPOS = {
  creado: 'Se creó el usuario', eliminado: 'Se eliminó el usuario', rol: 'Rol', menus: 'Menús', solo_ver: 'Solo ver',
  alcance: 'Qué productos ve', vence_el: 'Acceso hasta', activo: 'Activo',
};
const nombresMenus = (t) => String(t || '').split(',').map(x => x.trim()).filter(Boolean).map(x => NOMBRE_MENU[x] || x).join(', ') || 'ninguno';
const valor = (campo, v) => {
  if (v == null || v === '') return campo === 'vence_el' ? 'sin fecha' : '—';
  if (campo === 'menus' || campo === 'solo_ver') return nombresMenus(v);
  if (campo === 'activo') return v === 'true' ? 'sí' : 'no';
  if (campo === 'alcance') {
    try { const a = JSON.parse(v); return ['laboratorios', 'unidades_negocio', 'categorias'].flatMap(k => a?.[k] || []).join(', ') || 'todos'; } catch { return v; }
  }
  return v;
};

export default function ActividadUsuario({ email }) {
  const [menus, setMenus] = useState(null);
  const [bitacora, setBitacora] = useState(null);

  useEffect(() => {
    if (!isSupabaseActive() || !email) return;
    const correo = String(email).toLowerCase();
    supabase.from('v_actividad_menus').select('menu, veces, ultima').eq('email', correo).order('veces', { ascending: false })
      .then(({ data, error }) => setMenus(error ? null : data || []));
    supabase.from('usuarios_bitacora').select('campo, antes, despues, quien, fecha').ilike('email', correo).order('fecha', { ascending: false }).limit(30)
      .then(({ data, error }) => setBitacora(error ? null : data || []));
  }, [email]);

  return (
    <>
      {menus && (
        <section>
          <h3 className="m3-title-small text-on-surface-variant mb-2">Menús que usa (30 días)</h3>
          {menus.length === 0 ? (
            <p className="m3-body-medium text-on-surface-variant">No abrió ningún menú en los últimos 30 días.</p>
          ) : (
            <ul className="divide-y divide-outline-variant">
              {menus.map(m => (
                <li key={m.menu} className="flex items-center gap-3 py-2 m3-body-medium">
                  <span className="flex-1">{NOMBRE_MENU[m.menu] || m.menu}</span>
                  <span className="tabular-nums text-on-surface-variant">{m.veces} {Number(m.veces) === 1 ? 'vez' : 'veces'}</span>
                  <span className="tabular-nums text-on-surface-variant w-28 text-right" title={fechaHora(m.ultima)}>{haceCuanto(m.ultima).toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {bitacora && (
        <section>
          <h3 className="m3-title-small text-on-surface-variant mb-2">Historial de permisos</h3>
          {bitacora.length === 0 ? (
            <p className="m3-body-medium text-on-surface-variant">Sin cambios de permisos registrados.</p>
          ) : (
            <ul className="divide-y divide-outline-variant">
              {bitacora.map((b, i) => (
                <li key={i} className="py-2 m3-body-medium">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-on-surface flex-1">{CAMPOS[b.campo] || b.campo}</span>
                    <span className="m3-body-small text-on-surface-variant tabular-nums">{fechaHora(b.fecha)}</span>
                  </div>
                  {!['creado', 'eliminado'].includes(b.campo) && (
                    <div className="m3-body-small text-on-surface-variant">{valor(b.campo, b.antes)} → <span className="text-on-surface">{valor(b.campo, b.despues)}</span></div>
                  )}
                  <div className="m3-body-small text-on-surface-variant">por {b.quien || 'el sistema'}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
