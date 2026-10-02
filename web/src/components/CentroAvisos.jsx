import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, isSupabaseActive } from '../supabase';
import { useData } from '../context/DataContext';

// Centro de avisos (la campana de la barra de arriba): junta en un solo lugar
// lo que pide atencion, sin correo. Cada aviso lleva a su pantalla. Se cuenta
// al entrar, cada 5 minutos y al abrir la campana. Una vista que falta (fase
// sin correr) simplemente no da aviso.
const CADA_MS = 5 * 60 * 1000;

async function contar(tabla, filtro) {
  let q = supabase.from(tabla).select('*', { count: 'exact', head: true });
  if (filtro) q = filtro(q);
  const { count, error } = await q;
  return error ? 0 : count || 0;
}

async function cadenasConFallas() {
  const { data, error } = await supabase.from('scrape_runs')
    .select('cadena_id, total_urls, exitosos, started_at').order('started_at', { ascending: false }).limit(200);
  if (error) return [];
  const ultima = new Map();
  for (const r of data || []) if (!ultima.has(r.cadena_id)) ultima.set(r.cadena_id, r);
  return [...ultima.values()].filter(r => r.total_urls > 0 && (r.exitosos || 0) / r.total_urls < 0.8).map(r => r.cadena_id);
}

export default function CentroAvisos({ verExperimental = true, verCadenas = true }) {
  const navigate = useNavigate();
  const { cadenas = [] } = useData() || {};
  const [avisos, setAvisos] = useState([]);
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) return;
    const [agotados, bajoMinimo, pendientes, sugerencias, fallas] = await Promise.all([
      verExperimental ? contar('v_disponibilidad', q => q.eq('estado', 'agotado').eq('es_propio', true)) : 0,
      verExperimental ? contar('v_precio_minimo_alertas') : 0,
      verExperimental ? contar('fact_precios', q => q.eq('sospechoso', true).eq('revisado_manual', false)) : 0,
      verExperimental ? contar('sugerencias_enlaces', q => q.eq('estado', 'pendiente')) : 0,
      verCadenas ? cadenasConFallas() : [],
    ]);
    setAvisos([
      { id: 'agotados', n: agotados, importante: true, icono: 'remove_shopping_cart', texto: `${agotados === 1 ? 'Un producto tuyo agotado' : `${agotados} enlaces tuyos agotados`} en alguna cadena`, ir: '/experimental?tab=agotados' },
      { id: 'minimo', n: bajoMinimo, importante: true, icono: 'gpp_maybe', texto: `${bajoMinimo === 1 ? 'Una cadena vende' : `${bajoMinimo} cadenas venden`} tu producto por debajo del mínimo`, ir: '/experimental?tab=precio_minimo' },
      { id: 'fallas', n: fallas.length, importante: true, icono: 'smart_toy', texto: `El robot leyó con fallas: ${fallas.map(id => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id).join(', ')}`, ir: '/cadenas' },
      { id: 'revision', n: pendientes, importante: false, icono: 'rule', texto: `${pendientes} ${pendientes === 1 ? 'captura dudosa espera' : 'capturas dudosas esperan'} revisión`, ir: '/experimental?tab=revision' },
      { id: 'sugerencias', n: sugerencias, importante: false, icono: 'travel_explore', texto: `${sugerencias} ${sugerencias === 1 ? 'sugerencia de enlace pendiente' : 'sugerencias de enlaces pendientes'}`, ir: '/experimental?tab=sugerencias' },
    ].filter(a => a.n > 0));
  }, [verExperimental, verCadenas, cadenas]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, CADA_MS);
    window.addEventListener('trackflow:revision', cargar);
    return () => { clearInterval(t); window.removeEventListener('trackflow:revision', cargar); };
  }, [cargar]);

  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', esc); };
  }, [abierto]);

  const importantes = avisos.filter(a => a.importante).length;

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="m3-icon-btn relative" onClick={() => { setAbierto(v => !v); if (!abierto) cargar(); }}
        aria-haspopup="true" aria-expanded={abierto}
        title={avisos.length ? `${avisos.length} ${avisos.length === 1 ? 'aviso' : 'avisos'}` : 'Sin avisos'} aria-label="Avisos">
        <span className="material-symbols-outlined">{avisos.length ? 'notifications_active' : 'notifications'}</span>
        {avisos.length > 0 && (
          <span className={`m3-avisos-badge ${importantes ? 'is-importante' : ''}`}>{avisos.length}</span>
        )}
      </button>
      {abierto && (
        <div className="m3-avisos-panel" role="dialog" aria-label="Avisos">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="m3-title-small text-on-surface">Avisos</span>
            <button type="button" className="m3-icon-btn m3-icon-btn-sm" onClick={cargar} title="Volver a contar" aria-label="Volver a contar">
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
          {avisos.length === 0 ? (
            <p className="m3-body-medium text-on-surface-variant px-4 pb-4">Todo en orden: nada pide atención ahora.</p>
          ) : (
            <ul className="pb-2">
              {avisos.map(a => (
                <li key={a.id}>
                  <button type="button" className={`m3-aviso ${a.importante ? 'is-importante' : ''}`}
                    onClick={() => { setAbierto(false); navigate(a.ir); }}>
                    <span className="material-symbols-outlined" aria-hidden="true">{a.icono}</span>
                    <span className="flex-1 min-w-0 text-left">{a.texto}</span>
                    <span className="material-symbols-outlined text-on-surface-variant" aria-hidden="true">chevron_right</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
