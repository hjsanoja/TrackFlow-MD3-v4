import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

// Lo que cada usuario deja elegido en una pantalla (un objeto), guardado en
// preferencias_usuario (fase 52): lo encuentra igual desde cualquier equipo.
// Arranca con la copia del navegador para no esperar a la base; si la base
// responde antes de que el usuario toque algo, manda lo de la base.
export function usePreferenciaGuardada(clave, inicial) {
  const local = `trackflow_pref_${clave}`;
  const [valor, setValor] = useState(() => {
    try { return { ...inicial, ...JSON.parse(localStorage.getItem(local) || '{}') }; } catch { return inicial; }
  });
  const actual = useRef(valor);
  const tocado = useRef(false);
  const espera = useRef(null);

  useEffect(() => {
    if (!isSupabaseActive()) return undefined;
    let vivo = true;
    supabase.from('preferencias_usuario').select('valor').eq('clave', clave).maybeSingle()
      .then(({ data, error }) => {
        if (!vivo || error || !data?.valor || tocado.current) return;
        const nuevo = { ...actual.current, ...data.valor };
        actual.current = nuevo;
        setValor(nuevo);
        try { localStorage.setItem(local, JSON.stringify(nuevo)); } catch { /* sin almacenamiento */ }
      });
    return () => { vivo = false; };
  }, [clave, local]);

  useEffect(() => () => clearTimeout(espera.current), []);

  // cambiar({ campo: valor }) o cambiar(v => ({ ... })): mezcla con lo que hay.
  const cambiar = useCallback((parcial) => {
    tocado.current = true;
    const previo = actual.current;
    const nuevo = { ...previo, ...(typeof parcial === 'function' ? parcial(previo) : parcial) };
    actual.current = nuevo;
    setValor(nuevo);
    try { localStorage.setItem(local, JSON.stringify(nuevo)); } catch { /* sin almacenamiento */ }
    if (!isSupabaseActive()) return;
    clearTimeout(espera.current);
    espera.current = setTimeout(() => {
      supabase.from('preferencias_usuario')
        .upsert({ clave, valor: nuevo, actualizado: new Date().toISOString() }, { onConflict: 'email,clave' })
        .then(() => {});
    }, 800);
  }, [clave, local]);

  return [valor, cambiar];
}
