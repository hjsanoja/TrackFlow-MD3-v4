import { useCallback, useEffect, useRef, useState } from 'react';

// Memoria de consultas mientras la pestana del navegador esta abierta.
// Al volver a una pantalla ya vista se muestra al instante lo ultimo que se
// leyo y, por detras, se vuelve a pedir (si tiene mas de FRESCO_MS) para
// reemplazarlo cuando llegue. Asi las pestanas de Experimental no esperan
// a la base cada vez que se cambia de una a otra.
const FRESCO_MS = 60 * 1000;
const memoria = new Map(); // clave -> { datos, en }

export function leerConsulta(clave) {
  return memoria.get(clave) || null;
}

export function guardarConsulta(clave, datos) {
  memoria.set(clave, { datos, en: Date.now() });
}

// Olvida las claves que empiezan por `prefijo` (tras guardar un cambio).
export function olvidarConsultas(prefijo) {
  for (const k of [...memoria.keys()]) if (k.startsWith(prefijo)) memoria.delete(k);
}

// `cargar` devuelve una promesa con { data, error } (como supabase-js).
// Devuelve { datos, error, cargando, recargar }. Con datos en memoria,
// `cargando` es false desde el primer pintado.
export function useConsulta(clave, cargar, { activa = true } = {}) {
  const guardado = leerConsulta(clave);
  const [estado, setEstado] = useState(() => ({
    datos: guardado?.datos ?? null, error: null, cargando: !guardado && activa,
  }));
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;

  const pedir = useCallback(async (forzar = false) => {
    const previo = leerConsulta(clave);
    if (previo) setEstado({ datos: previo.datos, error: null, cargando: false });
    if (!forzar && previo && Date.now() - previo.en < FRESCO_MS) return;
    if (!previo) setEstado(e => ({ ...e, cargando: true }));
    let res;
    try { res = await cargarRef.current(); } catch (err) { res = { data: null, error: err }; }
    // Otra clave pudo pedirse mientras tanto: solo se pinta la vigente.
    if (claveRef.current !== clave) return;
    if (res?.error) {
      setEstado(e => ({ datos: e.datos, error: res.error, cargando: false }));
      return;
    }
    guardarConsulta(clave, res?.data ?? null);
    setEstado({ datos: res?.data ?? null, error: null, cargando: false });
  }, [clave]);

  const claveRef = useRef(clave);
  claveRef.current = clave;

  useEffect(() => {
    if (!activa) { setEstado(e => ({ ...e, cargando: false })); return; }
    pedir(false);
  }, [pedir, activa]);

  return { ...estado, recargar: () => pedir(true) };
}
