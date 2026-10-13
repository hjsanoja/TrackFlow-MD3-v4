import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import Select from '../Select';
import { AVAILABLE_MENUS } from '../../utils/usuarios';
import { hoyCaracas } from '../../utils/permisos';

// Barra de seleccion de Usuarios: aplica un perfil (fase 50) a varios usuarios
// ya creados. Copia rol, menus, "solo ver", que productos ve y, si el perfil
// tiene dias, el "Acceso hasta" (fase 51). El trigger anota cada cambio.
export const venceConDias = (dias) => {
  if (!(Number(dias) > 0)) return null;
  const d = new Date(`${hoyCaracas()}T12:00:00`);
  d.setDate(d.getDate() + Number(dias));
  return d.toISOString().slice(0, 10);
};

export function camposDePerfil(p) {
  const admin = p.rol === 'administrador';
  return {
    rol: admin ? 'administrador' : 'consulta',
    menus_permitidos: admin ? AVAILABLE_MENUS.map(m => m.id) : (p.menus_permitidos || []),
    menus_solo_lectura: admin ? [] : (p.menus_solo_lectura || []),
    alcance: admin ? null : (p.alcance && ['laboratorios', 'unidades_negocio', 'categorias'].some(k => p.alcance[k]?.length) ? p.alcance : null),
    vence_el: admin ? null : venceConDias(p.vence_dias),
  };
}

export default function AplicarPerfilVarios({ usuarios, onLimpiar, onListo, addToast }) {
  const [perfiles, setPerfiles] = useState([]);
  const [elegido, setElegido] = useState('');
  const [avance, setAvance] = useState(null);

  useEffect(() => {
    if (!isSupabaseActive()) return;
    supabase.from('perfiles_usuario').select('*').order('nombre').then(({ data }) => setPerfiles(data || []));
  }, []);

  const aplicar = async () => {
    const p = perfiles.find(x => String(x.id) === String(elegido));
    if (!p) return;
    const campos = camposDePerfil(p);
    setAvance({ hechos: 0, total: usuarios.length });
    let ok = 0;
    const fallas = [];
    for (const u of usuarios) {
      const { data, error } = await supabase.from('usuarios').update(campos).eq('id', u.id).select('id');
      if (error || !data?.length) fallas.push(u.nombre || u.email); else ok += 1;
      setAvance({ hechos: ok + fallas.length, total: usuarios.length });
    }
    setAvance(null);
    addToast(`Perfil «${p.nombre}» aplicado a ${ok} ${ok === 1 ? 'usuario' : 'usuarios'}.${fallas.length ? ` No se pudo con: ${fallas.join(', ')}.` : ''}`, fallas.length ? 'warning' : 'success');
    onListo();
  };

  return (
    <div className="m3-selection-bar" role="toolbar" aria-label="Acciones sobre los usuarios elegidos">
      <button type="button" onClick={onLimpiar} disabled={!!avance} className="m3-icon-btn" title="Quitar selección" aria-label="Quitar selección">
        <span className="material-symbols-outlined">close</span>
      </button>
      <span className="m3-title-medium mr-auto">
        {avance ? `Aplicando ${avance.hechos} de ${avance.total}…` : `${usuarios.length} ${usuarios.length === 1 ? 'elegido' : 'elegidos'}`}
      </span>
      {perfiles.length === 0 ? (
        <span className="m3-body-small text-on-surface-variant">Crea un perfil desde «Nuevo usuario» (corre la fase 50).</span>
      ) : (
        <>
          <Select value={elegido} onChange={e => setElegido(e.target.value)} className="m3-select min-w-[12rem]" aria-label="Perfil a aplicar">
            <option value="">Elegir perfil…</option>
            {perfiles.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </Select>
          <button type="button" onClick={aplicar} disabled={!elegido || !!avance} className="m3-btn-primary h-10 px-4">Aplicar perfil</button>
        </>
      )}
    </div>
  );
}
