import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

// "Desde tu ultima visita": que precios cambiaron desde la ultima vez que
// esta persona abrio el Dashboard (fn_cambios_desde, fase 28).
//
// La visita anterior se guarda en este navegador. Si no hay (primera vez aqui,
// otro navegador), se usa su ingreso anterior registrado en `accesos`. Se fija
// una vez por pestana: volver al Dashboard o recargar no la mueve. Una visita
// cuenta como nueva despues de 30 minutos.
const MEDIA_HORA = 30 * 60 * 1000;

function visitaGuardada(email) {
  const clave = `dashboard.ultimaVisita.${email}`;
  const claveSesion = `dashboard.visitaAnterior.${email}`;
  try {
    const fijada = sessionStorage.getItem(claveSesion);
    if (fijada) return { desde: fijada === 'nunca' ? null : fijada, fijada: true };
    const guardada = localStorage.getItem(clave);
    const ahora = Date.now();
    const anterior = guardada && ahora - new Date(guardada).getTime() > MEDIA_HORA ? guardada : null;
    localStorage.setItem(clave, new Date(ahora).toISOString());
    return { desde: anterior, fijada: false, claveSesion };
  } catch {
    return { desde: null, fijada: true };
  }
}

// El ingreso anterior al actual (el ultimo es el de esta sesion).
async function ingresoAnterior(email) {
  const { data, error } = await supabase.from('accesos').select('fecha')
    .eq('email', email.toLowerCase()).eq('evento', 'ingreso')
    .order('fecha', { ascending: false }).limit(5);
  if (error || !data?.length) return null;
  const hace = Date.now() - MEDIA_HORA;
  return data.map(d => d.fecha).find(f => new Date(f).getTime() < hace) || null;
}

export function useCambiosDesdeVisita(email) {
  const [estado, setEstado] = useState({ desde: null, filas: [], listo: false });

  useEffect(() => {
    if (!email || !isSupabaseActive()) return undefined;
    let vigente = true;
    (async () => {
      const v = visitaGuardada(email);
      let desde = v.desde;
      if (!desde && !v.fijada) desde = await ingresoAnterior(email).catch(() => null);
      if (!v.fijada && v.claveSesion) {
        try { sessionStorage.setItem(v.claveSesion, desde || 'nunca'); } catch { /* sin almacenamiento */ }
      }
      if (!desde) { if (vigente) setEstado({ desde: null, filas: [], listo: true }); return; }
      const { data, error } = await supabase.rpc('fn_cambios_desde', { p_desde: desde });
      // Sin la fase 28 la funcion no existe: simplemente no se muestra nada.
      if (vigente) setEstado({ desde, filas: error ? [] : (data || []), listo: !error });
    })();
    return () => { vigente = false; };
  }, [email]);

  return estado;
}
