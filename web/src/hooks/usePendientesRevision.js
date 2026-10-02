import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { olvidarConsultas } from '../utils/cacheConsultas';

// Cuantas capturas dudosas esperan revision: el contador del menu y de la
// pestana. Se vuelve a contar cada 5 minutos y cuando la bandeja avisa de un
// cambio (avisarCambioRevision).
const EVENTO = 'trackflow:revision';
const CADA_MS = 5 * 60 * 1000;

export function avisarCambioRevision() {
  olvidarConsultas('revision:'); // lo guardado de las bandejas ya no sirve
  window.dispatchEvent(new Event(EVENTO));
}

export function usePendientesRevision() {
  const [pendientes, setPendientes] = useState(null);
  useEffect(() => {
    if (!isSupabaseActive()) return undefined;
    let vigente = true;
    const contar = async () => {
      const { count, error } = await supabase.from('fact_precios')
        .select('id', { count: 'exact', head: true })
        .eq('sospechoso', true).eq('revisado_manual', false);
      if (vigente && !error) setPendientes(count ?? 0);
    };
    contar();
    const t = setInterval(contar, CADA_MS);
    window.addEventListener(EVENTO, contar);
    return () => { vigente = false; clearInterval(t); window.removeEventListener(EVENTO, contar); };
  }, []);
  return pendientes;
}
