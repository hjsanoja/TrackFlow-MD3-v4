import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

// "Desde tu ultima visita": que precios cambiaron desde la ultima vez que
// esta persona abrio el Dashboard en este navegador (fn_cambios_desde, fase 28).
//
// La fecha de la visita anterior se fija una vez por pestana: volver al
// Dashboard desde otro menu, o recargar, no la mueve. Una visita cuenta como
// nueva despues de 30 minutos.
const MEDIA_HORA = 30 * 60 * 1000;

function visitaAnterior(email) {
  const clave = `dashboard.ultimaVisita.${email}`;
  const claveSesion = `dashboard.visitaAnterior.${email}`;
  try {
    const fijada = sessionStorage.getItem(claveSesion);
    if (fijada) return fijada === 'nunca' ? null : fijada;
    const guardada = localStorage.getItem(clave);
    const ahora = Date.now();
    // Una visita de hace menos de media hora es la misma visita.
    const anterior = guardada && ahora - new Date(guardada).getTime() > MEDIA_HORA ? guardada : null;
    sessionStorage.setItem(claveSesion, anterior || 'nunca');
    localStorage.setItem(clave, new Date(ahora).toISOString());
    return anterior;
  } catch {
    return null;
  }
}

export function useCambiosDesdeVisita(email) {
  const [estado, setEstado] = useState({ desde: null, filas: [], listo: false });

  useEffect(() => {
    if (!email || !isSupabaseActive()) return undefined;
    const desde = visitaAnterior(email);
    if (!desde) { setEstado({ desde: null, filas: [], listo: true }); return undefined; }
    let vigente = true;
    supabase.rpc('fn_cambios_desde', { p_desde: desde }).then(({ data, error }) => {
      if (!vigente) return;
      // Sin la fase 28 la funcion no existe: simplemente no se muestra nada.
      setEstado({ desde, filas: error ? [] : (data || []), listo: true });
    });
    return () => { vigente = false; };
  }, [email]);

  return estado;
}
