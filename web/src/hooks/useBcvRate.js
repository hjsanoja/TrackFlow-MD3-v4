import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { supabaseInsertSafe } from '../utils/dbClient';

// Tasa BCV compartida por todas las pantallas.
//
// Antes cada pantalla que la usaba la consultaba de nuevo al abrirse (y, si no
// habia tasa del dia, preguntaba a dos paginas externas), y mientras tanto
// calculaba con una tasa fija de 744,23. Ahora hay una sola consulta cada 10
// minutos para toda la app y se arranca con la ultima tasa conocida, guardada
// en el navegador.
const CLAVE = 'trackflow.tasa_bcv';
const VIGENCIA_MS = 10 * 60 * 1000;

let actual = leerGuardada();   // { rate, source, updatedAt }
let promesa = null;
let pedidaEn = 0;
const oyentes = new Set();

function leerGuardada() {
  try {
    const t = JSON.parse(localStorage.getItem(CLAVE) || 'null');
    if (t && t.rate > 0) return { ...t, updatedAt: t.updatedAt ? new Date(t.updatedAt) : null };
  } catch { /* sin almacenamiento */ }
  return null;
}

function publicar(t) {
  actual = t;
  try { localStorage.setItem(CLAVE, JSON.stringify(t)); } catch { /* sin almacenamiento */ }
  oyentes.forEach(fn => fn(t));
}

async function leerDeSupabase() {
  if (!isSupabaseActive()) return null;
  try {
    const { data, error } = await supabase.from('dim_tasa_bcv').select('*').order('fecha', { ascending: false }).limit(1);
    if (!error && data?.length) {
      const val = Number(data[0].tasa);
      if (val > 0) return { rate: val, source: data[0].fuente || 'oficial', updatedAt: data[0].fecha ? new Date(data[0].fecha) : new Date() };
    }
    const { data: legacy, error: e2 } = await supabase.from('bcv_rates').select('*').order('updated_at', { ascending: false }).limit(1);
    if (!e2 && legacy?.length) {
      const val = Number(legacy[0].value || legacy[0].valor);
      if (val > 0) return { rate: val, source: legacy[0].source || 'oficial', updatedAt: legacy[0].updated_at ? new Date(legacy[0].updated_at) : new Date() };
    }
  } catch (err) {
    console.warn('[useBcvRate] aviso leyendo Supabase:', err?.message || String(err));
  }
  return null;
}

async function leerDeApis() {
  const intentos = [
    ['https://ve.dolarapi.com/v1/dolares/oficial', j => j?.promedio || j?.precio],
    ['https://pydolarve.org/api/v1/dollar?page=bcv', j => j?.monitors?.usd?.price || j?.price],
  ];
  for (const [url, leer] of intentos) {
    try {
      // Sin respuesta en 4 s se pasa a la siguiente: no se espera de mas.
      const res = await fetch(url, { signal: AbortSignal.timeout?.(4000) });
      if (res.ok) {
        const val = Number(leer(await res.json()));
        if (val > 100) return val;
      }
    } catch { /* siguiente */ }
  }
  return null;
}

async function actualizar() {
  const guardada = await leerDeSupabase();
  if (guardada) publicar(guardada);
  const esDeHoy = guardada?.updatedAt && new Date(guardada.updatedAt).toDateString() === new Date().toDateString();
  if (esDeHoy) return;

  // No hay tasa del dia: se busca fuera y se guarda para todos.
  const auto = await leerDeApis();
  if (!auto) return;
  publicar({ rate: auto, source: 'auto', updatedAt: new Date() });
  if (isSupabaseActive()) {
    const hoy = new Date().toISOString().split('T')[0];
    supabaseInsertSafe('bcv_rates', { value: auto, updated_at: new Date().toISOString() }).catch(() => {});
    supabase.from('dim_tasa_bcv').upsert({ fecha: hoy, tasa: auto, fuente: 'BCV' }, { onConflict: 'fecha' }).then(() => {}, () => {});
  }
}

function pedir(forzar = false) {
  if (!promesa || forzar || Date.now() - pedidaEn > VIGENCIA_MS) {
    pedidaEn = Date.now();
    promesa = actualizar().catch(err => console.warn('[useBcvRate] aviso en refresh:', err?.message || String(err)));
  }
  return promesa;
}

export function useBcvRate() {
  const [tasa, setTasa] = useState(actual);
  const [loading, setLoading] = useState(!actual);
  const [error, setError] = useState(null);

  useEffect(() => {
    oyentes.add(setTasa);
    let vigente = true;
    pedir().finally(() => { if (vigente) setLoading(false); });
    return () => { vigente = false; oyentes.delete(setTasa); };
  }, []);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    await pedir(true);
    setLoading(false);
  };

  const setManual = async (value) => {
    setError(null);
    const num = parseFloat(String(value).replace(',', '.'));
    if (!num || isNaN(num) || num <= 0) {
      setError('La tasa debe ser un número positivo (usa punto, no coma)');
      return false;
    }
    publicar({ rate: num, source: 'manual', updatedAt: new Date() });
    try {
      if (isSupabaseActive()) {
        const hoy = new Date().toISOString().split('T')[0];
        await Promise.allSettled([
          supabaseInsertSafe('bcv_rates', { value: num, updated_at: new Date().toISOString() }),
          supabase.from('dim_tasa_bcv').upsert({ fecha: hoy, tasa: num, fuente: 'manual' }, { onConflict: 'fecha' }),
        ]);
      }
    } catch (err) {
      console.warn('[useBcvRate] guardado local tras aviso:', err?.message || String(err));
    }
    return true;
  };

  return {
    rate: tasa?.rate ?? null,
    source: tasa?.source ?? null,
    updatedAt: tasa?.updatedAt ?? null,
    loading,
    error,
    refresh,
    setManual,
  };
}
