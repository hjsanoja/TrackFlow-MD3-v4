import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { getGitHubConfig, triggerGitHubScraper } from '../utils/githubClient';
import { publicacionIdDe } from '../utils/dbClient';

// Una corrida del robot (GitHub Actions) lanzada desde el panel: para todos
// los enlaces activos o solo para algunos. Se guarda en el navegador para
// seguir mostrando el avance aunque se recargue la pagina.
const CLAVE = 'competencia.robot';
const CADA_MS = 20000;

// GitHub tarda unos minutos en preparar la maquina (Python, navegador...).
const MINUTOS_PREPARACION = 4;
// Segundos por enlace. El robot lee las cadenas en paralelo, pero cada
// tienda de una en una y con pausas (Farmatodo es la mas lenta).
const SEGUNDOS_POR_ENLACE = { farmatodo: 10, otro: 5 };

export function estimarMinutos(enlaces) {
  const porTienda = new Map();
  for (const e of enlaces) {
    const tienda = String(e.url || '').toLowerCase().includes('farmatodo') ? 'farmatodo' : String(e.cadena || 'otro').toLowerCase();
    porTienda.set(tienda, (porTienda.get(tienda) || 0) + 1);
  }
  let segundos = 0;
  for (const [tienda, n] of porTienda) {
    segundos = Math.max(segundos, n * (SEGUNDOS_POR_ENLACE[tienda] || SEGUNDOS_POR_ENLACE.otro));
  }
  return Math.ceil(MINUTOS_PREPARACION + segundos / 60);
}

function leer() {
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE) || 'null');
    return c && c.inicio ? c : null;
  } catch { return null; }
}
function guardar(c) {
  try {
    if (c) localStorage.setItem(CLAVE, JSON.stringify(c));
    else localStorage.removeItem(CLAVE);
  } catch { /* sin almacenamiento */ }
}

// La corrida de GitHub que corresponde a este disparo. Si el token no puede
// leer Actions (403), devuelve null y el avance se calcula solo con el tiempo.
async function corridaGitHub(config, inicio) {
  const url = `https://api.github.com/repos/${config.repo_owner}/${config.repo_name}/actions/runs?event=repository_dispatch&per_page=5`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  const { workflow_runs: runs = [] } = await res.json();
  return runs
    .filter(r => new Date(r.created_at).getTime() >= inicio - 60000)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
}

// Cuantas de las publicaciones pedidas tienen una captura (buena o fallida)
// desde que empezo la corrida. El robot las guarda todas al final.
async function capturadasDesde(inicio, pubIds) {
  if (!isSupabaseActive()) return 0;
  let q = supabase.from('fact_precios').select('publicacion_id')
    .eq('origen', 'scraper')
    .gte('fecha_captura', new Date(inicio - 60000).toISOString());
  q = pubIds ? q.in('publicacion_id', pubIds) : q.limit(1);
  const { data, error } = await q;
  if (error) return 0;
  return new Set((data || []).map(d => d.publicacion_id)).size;
}

/**
 * @param {Function} onTerminado ({ corrida, leidos }) cuando el robot acaba.
 * @param {Function} onError     (mensaje, { faltaConfig })
 */
export function useRobot({ onTerminado, onError }) {
  const [corrida, setCorrida] = useState(leer);
  const [ahora, setAhora] = useState(Date.now());
  const callbacks = useRef({ onTerminado, onError });
  callbacks.current = { onTerminado, onError };

  const actualizar = useCallback((c) => { guardar(c); setCorrida(c); }, []);

  // enlaces: los que se quieren leer, o null para todos los activos.
  // total: cuantos son (para todos, los activos).
  // etiqueta: texto opcional para el aviso (p. ej. el nombre de la cadena).
  const lanzar = useCallback(async (enlaces, todosActivos, etiqueta = '') => {
    const lista = enlaces ? enlaces.filter(e => e.activo !== false) : todosActivos;
    if (lista.length === 0) {
      callbacks.current.onError?.('Ninguno de esos enlaces está activo: el robot solo lee los activos.');
      return false;
    }
    const config = await getGitHubConfig();
    if (!config?.token || !config.repo_owner || !config.repo_name) {
      callbacks.current.onError?.('Faltan las credenciales de GitHub Actions.', { faltaConfig: true });
      return false;
    }
    const ids = enlaces ? lista.map(e => e.id) : null;
    try {
      await triggerGitHubScraper({ config, payload: ids ? { doc_ids: ids.join(','), doc_id: ids.length === 1 ? ids[0] : undefined } : null });
    } catch (err) {
      callbacks.current.onError?.(err.message === 'CONFIG_MISSING' ? 'Faltan las credenciales de GitHub Actions.' : `No se pudo lanzar el robot: ${err.message}`,
        { faltaConfig: err.message === 'CONFIG_MISSING' });
      return false;
    }
    actualizar({
      inicio: Date.now(),
      ids,
      pubIds: ids ? [...new Set(lista.map(publicacionIdDe).filter(Boolean))] : null,
      total: lista.length,
      estimado: estimarMinutos(lista),
      estadoGitHub: null,
      urlGitHub: null,
      etiqueta,
    });
    return true;
  }, [actualizar]);

  const ocultar = useCallback(() => actualizar(null), [actualizar]);

  // Seguimiento mientras haya una corrida.
  useEffect(() => {
    if (!corrida) return undefined;
    let vigente = true;
    const revisar = async () => {
      setAhora(Date.now());
      const c = leer();
      if (!c) return;
      let gh = null;
      try {
        const config = await getGitHubConfig();
        if (config?.token) gh = await corridaGitHub(config, c.inicio);
      } catch { /* sin acceso a Actions: se sigue solo con el tiempo */ }

      const leidos = await capturadasDesde(c.inicio, c.pubIds);
      const esperados = c.pubIds ? c.pubIds.length : 1;
      const terminadoGitHub = gh?.status === 'completed';
      const terminadoDatos = leidos >= esperados;
      if (!vigente) return;

      if (terminadoGitHub || terminadoDatos) {
        actualizar(null);
        callbacks.current.onTerminado?.({ corrida: c, leidos, fallo: terminadoGitHub && gh.conclusion !== 'success' && !terminadoDatos, urlGitHub: gh?.html_url });
        return;
      }
      // Sin noticias mucho despues de lo esperado: se deja de seguir.
      const minutos = (Date.now() - c.inicio) / 60000;
      if (minutos > c.estimado * 2 + 15) {
        actualizar(null);
        callbacks.current.onError?.('El robot no terminó en el tiempo esperado. Revisa la corrida en GitHub Actions.');
        return;
      }
      if (gh && (gh.status !== c.estadoGitHub || gh.html_url !== c.urlGitHub)) {
        actualizar({ ...c, estadoGitHub: gh.status, urlGitHub: gh.html_url });
      }
    };
    revisar();
    const t = setInterval(revisar, CADA_MS);
    const reloj = setInterval(() => setAhora(Date.now()), 5000);
    return () => { vigente = false; clearInterval(t); clearInterval(reloj); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corrida?.inicio]);

  const minutos = corrida ? Math.max(0, Math.floor((ahora - corrida.inicio) / 60000)) : 0;
  const avance = corrida ? Math.min(95, ((ahora - corrida.inicio) / 60000 / corrida.estimado) * 100) : 0;
  const leyendo = (enlace) => Boolean(corrida && enlace?.activo !== false &&
    (corrida.ids === null || corrida.ids.includes(enlace.id)));

  return { corrida, lanzar, ocultar, minutos, avance, leyendo };
}
