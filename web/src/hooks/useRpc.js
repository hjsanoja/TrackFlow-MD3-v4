import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

// Llama una funcion de Postgres (rpc) y devuelve sus filas. `faltaSql` dice
// si la funcion no existe todavia (falta correr su fase).
export function useRpc(nombre, params) {
  const [estado, setEstado] = useState({ cargando: true, filas: [], error: null });
  const clave = JSON.stringify(params);

  useEffect(() => {
    if (!isSupabaseActive()) { setEstado({ cargando: false, filas: [], error: null }); return undefined; }
    let vigente = true;
    setEstado(e => ({ ...e, cargando: true }));
    supabase.rpc(nombre, params).then(({ data, error }) => {
      if (vigente) setEstado({ cargando: false, filas: error ? [] : data || [], error });
    });
    return () => { vigente = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nombre, clave]);

  const faltaSql = Boolean(estado.error && /PGRST202|function|404|does not exist/i.test(`${estado.error.code} ${estado.error.message}`));
  return { ...estado, faltaSql };
}
