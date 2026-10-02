import { supabase, isSupabaseActive } from '../supabase';
import { useConsulta } from '../utils/cacheConsultas';

// Llama una funcion de Postgres (rpc) y devuelve sus filas. `faltaSql` dice
// si la funcion no existe todavia (falta correr su fase). El resultado queda
// en memoria (utils/cacheConsultas): al volver a la pestana sale al instante.
export function useRpc(nombre, params) {
  const clave = `rpc:${nombre}:${JSON.stringify(params)}`;
  const { datos, error, cargando } = useConsulta(clave, () => supabase.rpc(nombre, params), { activa: isSupabaseActive() });
  const faltaSql = Boolean(error && /PGRST202|function|404|does not exist/i.test(`${error.code} ${error.message}`));
  return { filas: datos || [], error, cargando, faltaSql };
}
