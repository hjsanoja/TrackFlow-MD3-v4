import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import Select from '../Select';
import { Field } from '../formulario';
import { venceConDias } from './AplicarPerfilVarios';
import { hoyCaracas } from '../../utils/permisos';

// Perfiles de permisos (fase 50): plantillas con rol, menus, "solo ver" y
// que productos ve, para no marcar todo a mano en cada usuario nuevo.
// "Aplicar" copia el perfil al formulario (luego se puede ajustar); el
// usuario no queda atado al perfil. Sin la fase 50 el bloque no sale.
const diasHasta = (fecha) => {
  if (!fecha) return null;
  const d = Math.round((new Date(`${fecha}T12:00:00`) - new Date(`${hoyCaracas()}T12:00:00`)) / 864e5);
  return d > 0 ? d : null;
};
const faltaTabla = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

export default function PerfilesPermisos({ form, onAplicar }) {
  const [perfiles, setPerfiles] = useState(null); // null = cargando o sin fase
  const [elegido, setElegido] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [nombreNuevo, setNombreNuevo] = useState(null); // null = cerrado
  const [mensaje, setMensaje] = useState(null);

  const cargar = async () => {
    const { data, error } = await supabase.from('perfiles_usuario').select('*').order('nombre');
    if (error) { setPerfiles(faltaTabla(error) ? null : []); return; }
    setPerfiles(data || []);
  };
  useEffect(() => { if (isSupabaseActive()) cargar(); }, []);

  if (perfiles === null) return null;

  const aplicar = (id) => {
    setElegido(id);
    const p = perfiles.find(x => String(x.id) === String(id));
    if (!p) return;
    onAplicar({
      rol: p.rol === 'administrador' ? 'administrador' : 'consulta',
      menus_permitidos: p.menus_permitidos || [],
      menus_solo_lectura: p.menus_solo_lectura || [],
      alcance: p.alcance && ['laboratorios', 'unidades_negocio', 'categorias'].some(k => p.alcance[k]?.length) ? p.alcance : null,
      // Perfil con dias (fase 51, ej. "Invitado 30 dias"): acceso hasta hoy + N.
      ...(p.vence_dias ? { vence_el: venceConDias(p.vence_dias) } : {}),
    });
    setMensaje(`Se aplicó «${p.nombre}»${p.vence_dias ? `: acceso por ${p.vence_dias} días` : ''}. Puedes ajustar lo que haga falta antes de guardar.`);
  };

  const guardarComo = async () => {
    const nombre = String(nombreNuevo || '').trim();
    if (!nombre) return;
    setGuardando(true);
    const { error } = await supabase.from('perfiles_usuario').upsert({
      nombre,
      rol: form.rol,
      menus_permitidos: form.menus_permitidos,
      menus_solo_lectura: form.menus_solo_lectura,
      alcance: form.alcance,
      // Con "Acceso hasta", el perfil guarda los dias que faltan (fase 51).
      ...(diasHasta(form.vence_el) ? { vence_dias: diasHasta(form.vence_el) } : {}),
      actualizado: new Date().toISOString(),
    }, { onConflict: 'nombre' });
    setGuardando(false);
    if (error) { setMensaje(`No se pudo guardar el perfil: ${error.message}`); return; }
    setNombreNuevo(null);
    setMensaje(`Perfil «${nombre}» guardado. Ya puedes aplicarlo a otros usuarios.`);
    cargar();
  };

  const borrar = async () => {
    const p = perfiles.find(x => String(x.id) === String(elegido));
    if (!p) return;
    const { error } = await supabase.from('perfiles_usuario').delete().eq('id', p.id);
    if (error) { setMensaje(`No se pudo borrar: ${error.message}`); return; }
    setElegido('');
    setMensaje(`Perfil «${p.nombre}» borrado. Los usuarios que lo usaron no cambian.`);
    cargar();
  };

  return (
    <Field label="Perfil" hint="Aplica de una vez el rol, los menús, «solo ver» y los productos que ve. Después puedes ajustar.">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={elegido} onChange={e => aplicar(e.target.value)} className="m3-select min-w-[14rem]" aria-label="Aplicar un perfil">
          <option value="">{perfiles.length ? 'Elegir un perfil…' : 'Aún no hay perfiles'}</option>
          {perfiles.map(p => <option key={p.id} value={p.id}>{p.nombre}{p.vence_dias ? ` (${p.vence_dias} días)` : ''}</option>)}
        </Select>
        {elegido && (
          <button type="button" onClick={borrar} className="m3-btn-text-danger" data-borra title="Borrar este perfil (no cambia a ningún usuario)">Borrar perfil</button>
        )}
        {nombreNuevo === null ? (
          <button type="button" onClick={() => { setNombreNuevo(''); setMensaje(null); }} className="m3-btn-text">
            <span className="material-symbols-outlined" aria-hidden="true">bookmark_add</span>
            Guardar como perfil
          </button>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <input type="text" value={nombreNuevo} onChange={e => setNombreNuevo(e.target.value)} placeholder="Nombre, ej. Ventas"
              className="m3-input w-48" aria-label="Nombre del perfil" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); guardarComo(); } }} />
            <button type="button" onClick={guardarComo} disabled={guardando || !nombreNuevo.trim()} className="m3-btn-outline h-10 px-4">
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" onClick={() => setNombreNuevo(null)} className="m3-btn-text">Cancelar</button>
          </span>
        )}
      </div>
      {mensaje && <p className="m3-body-small text-on-surface-variant mt-1.5" role="status">{mensaje}</p>}
    </Field>
  );
}
