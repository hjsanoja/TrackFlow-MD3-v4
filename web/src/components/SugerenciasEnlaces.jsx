import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import StatCard from './StatCard';
import BarraFiltros from './BarraFiltros';
import Segmentado from './Segmentado';
import FiltroChip from './FiltroChip';
import CadenaBadge from './CadenaBadge';
import InfoGrafico from './InfoGrafico';
import GitHubConfigModal from './GitHubConfigModal';
import ConfirmModal from './ConfirmModal';
import ModalWrapper from './ModalWrapper';
import { normalizar } from './formulario';
import { describirPresentacion } from '../utils/presentacion';
import { getGitHubConfig, triggerGitHubScraper } from '../utils/githubClient';

/**
 * Sugerencias de enlaces (beta). El robot buscador (scraper/buscar_enlaces.py,
 * GitHub Actions) busca los productos de Competencia en las cadenas donde aún
 * no tienen enlace y deja aquí lo que encuentra. Nada se vuelve enlace hasta
 * que se acepta (fn_aceptar_sugerencia, fase 36).
 */
const VISTAS = { pendiente: 'Por revisar', aceptada: 'Aceptadas', descartada: 'Descartadas' };
const PLATAFORMAS = { vtex: 'VTEX', woocommerce: 'WooCommerce', shopify: 'Shopify', magento: 'Magento', navegador: 'Navegador' };
const CLAVE_LANZADO = 'sugerencias.lanzado';
const POR_PAGINA = 20;
const CADA_MS = 15000;
const faltaSql = (e) => /42P01|PGRST205|PGRST202|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

const fecha = (v) => (v ? new Date(v).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const decimal = (v) => String(Number(v)).replace('.', ',');
function presentacion(dosis, tamano, unidad) {
  const partes = [];
  if (dosis != null) partes.push(`${decimal(dosis)} mg`);
  if (tamano != null) partes.push(`x ${decimal(tamano)}${unidad === 'ml' ? ' ml' : unidad === 'g' ? ' g' : ''}`);
  return partes.join(' ');
}
function precio(v, moneda) {
  if (v == null) return '—';
  const n = Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return moneda === 'USD' ? `$${n}` : moneda === 'VES' || moneda === 'VEF' ? `Bs ${n}` : `${n}${moneda ? ` ${moneda}` : ''}`;
}
// Corrida de GitHub de una fila de corridas_buscador (url .../actions/runs/<id>).
const idCorridaGitHub = (url) => (/\/actions\/runs\/(\d+)/.exec(url || '') || [])[1] || null;
async function pedirGitHub(config, ruta, metodo = 'GET') {
  return fetch(`https://api.github.com/repos/${config.repo_owner}/${config.repo_name}${ruta}`, {
    method: metodo,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
}
const MAX_HORAS = 3; // el workflow se corta a las 2,5 h: mas que esto ya no esta corriendo
const MIN_SIN_LATIDO = 5; // minutos sin senal de vida del robot

const leerLanzado = () => { try { return Number(localStorage.getItem(CLAVE_LANZADO)) || 0; } catch { return 0; } };
const guardarLanzado = (t) => { try { if (t) localStorage.setItem(CLAVE_LANZADO, String(t)); else localStorage.removeItem(CLAVE_LANZADO); } catch { /* sin almacenamiento */ } };

export default function SugerenciasEnlaces() {
  const { refreshCompetencia, productos = [] } = useData() || {};
  const propioPorId = useMemo(() => new Map(productos.map(x => [String(x.id_interno).trim(), x])), [productos]);
  const { addToast } = useToast();
  const [ver, setVer] = useState('pendiente');
  const [filas, setFilas] = useState([]);
  const [cadenas, setCadenas] = useState([]);
  const [corrida, setCorrida] = useState(null);
  const [lanzado, setLanzado] = useState(leerLanzado);
  const [cargando, setCargando] = useState(true);
  const [sinFase36, setSinFase36] = useState(false);
  const [procesando, setProcesando] = useState(null);
  const [cadena, setCadena] = useState('todos');
  const [nivel, setNivel] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const [limite, setLimite] = useState(POR_PAGINA);
  const [verGithub, setVerGithub] = useState(false);
  const [confirmarTodo, setConfirmarTodo] = useState(false);
  const [configurar, setConfigurar] = useState(null);
  const [deteniendo, setDeteniendo] = useState(false);

  const nombreCadena = useCallback((id) => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id, [cadenas]);

  const cargarEstado = useCallback(async () => {
    const [{ data: cs, error: e1 }, { data: co }] = await Promise.all([
      supabase.from('dim_cadenas').select('id, nombre, website, activo, plataforma, plataforma_detalle, plataforma_revisada').order('nombre'),
      supabase.from('corridas_buscador').select('*').order('inicio', { ascending: false }).limit(1),
    ]);
    if (e1 && faltaSql(e1)) { setSinFase36(true); return null; }
    setCadenas((cs || []).filter(c => c.activo !== false));
    const ultima = co?.[0] || null;
    setCorrida(ultima);
    return ultima;
  }, []);

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setCargando(false); return; }
    setCargando(true);
    try {
      const { data, error } = await supabase.from('v_sugerencias_enlaces').select('*')
        .eq('estado', ver).order('puntaje', { ascending: false }).limit(1000);
      if (error) {
        if (faltaSql(error)) { setSinFase36(true); setFilas([]); return; }
        throw error;
      }
      setFilas(data || []);
      await cargarEstado();
    } catch (err) {
      addToast(`No se pudieron cargar las sugerencias: ${err.message}`, 'error');
    } finally {
      setCargando(false);
    }
  }, [ver, addToast, cargarEstado]);

  useEffect(() => { cargar(); }, [cargar]);
  // Al abrir: si la ultima corrida figura "corriendo" pero ya no corre, se cierra.
  useEffect(() => { if (corrida?.estado === 'corriendo') revisarViva(corrida); }, [corrida?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLimite(POR_PAGINA); }, [ver, cadena, nivel, busqueda]);

  // Marca como terminada una corrida que ya no corre (cancelada en GitHub o
  // cortada). Si la base no lo permite (falta la fase 38), solo en pantalla.
  const cerrarCorrida = useCallback(async (c, estado) => {
    const fin = new Date().toISOString();
    await supabase.from('corridas_buscador').update({ estado, fin }).eq('id', c.id).eq('estado', 'corriendo');
    setCorrida(prev => (prev && prev.id === c.id ? { ...prev, estado, fin } : prev));
  }, []);

  // Una corrida "corriendo" que en GitHub ya termino o que lleva demasiado.
  const revisarViva = useCallback(async (c) => {
    if (!c || c.estado !== 'corriendo') return c;
    // El robot late cada 30 s (fase 39): sin latido en 5 min ya no corre.
    const ultimoLatido = c.latido ? new Date(c.latido).getTime() : null;
    const sinVida = ultimoLatido ? Date.now() - ultimoLatido > MIN_SIN_LATIDO * 60000
      : Date.now() - new Date(c.inicio).getTime() > MAX_HORAS * 3600000;
    if (sinVida) {
      await cerrarCorrida(c, 'interrumpida');
      return { ...c, estado: 'interrumpida' };
    }
    const run = idCorridaGitHub(c.url_github);
    if (!run) return c;
    try {
      const config = await getGitHubConfig();
      if (!config?.token) return c;
      const res = await pedirGitHub(config, `/actions/runs/${run}`);
      if (!res.ok) return c;
      const gh = await res.json();
      if (gh.status !== 'completed') return c;
      // El robot marca su propio final; si GitHub termino y la fila sigue
      // "corriendo", la corrida se corto (cancelada o fallo).
      const estado = gh.conclusion === 'cancelled' ? 'cancelada' : 'interrumpida';
      await cerrarCorrida(c, estado);
      return { ...c, estado };
    } catch {
      return c;
    }
  }, [cerrarCorrida]);

  // Detener: se marca la corrida como cancelada; el robot lo ve en su
  // siguiente latido (menos de un minuto) y se detiene. Si el token de GitHub
  // puede, ademas se cancela la corrida alla.
  const detener = async () => {
    if (!corrida) return;
    setDeteniendo(true);
    try {
      try {
        const config = await getGitHubConfig();
        const run = idCorridaGitHub(corrida.url_github);
        if (config?.token && run) await pedirGitHub(config, `/actions/runs/${run}/cancel`, 'POST');
      } catch { /* sin permiso de Actions: basta con la marca */ }
      await cerrarCorrida(corrida, 'cancelada');
      addToast('Búsqueda detenida: el robot se para en menos de un minuto. Lo encontrado hasta ahora se queda.', 'success');
      cargar();
    } catch (err) {
      addToast(`No se pudo detener: ${err.message}`, 'error');
    } finally {
      setDeteniendo(false);
    }
  };

  // Mientras el robot arranca o busca, se consulta su avance.
  const inicioCorrida = corrida ? new Date(corrida.inicio).getTime() : 0;
  const arrancando = lanzado > 0 && inicioCorrida < lanzado - 60000 && Date.now() - lanzado < 20 * 60000;
  const buscando = corrida?.estado === 'corriendo';
  useEffect(() => {
    if (!arrancando && !buscando) return undefined;
    let recargada = Date.now();
    const t = setInterval(async () => {
      const antes = corrida?.estado;
      const procesadosAntes = corrida?.procesados;
      const ultima = await revisarViva(await cargarEstado());
      // La lista se refresca mientras busca (una vez por minuto si avanza).
      if (ultima?.estado === 'corriendo' && ultima.procesados !== procesadosAntes && Date.now() - recargada > 60000) {
        recargada = Date.now();
        cargar();
      }
      if (lanzado && ultima && new Date(ultima.inicio).getTime() >= lanzado - 60000) {
        setLanzado(0);
        guardarLanzado(0);
        if (ultima.estado !== 'corriendo') cargar();
      }
      if (antes === 'corriendo' && ultima?.estado !== 'corriendo') {
        cargar();
        addToast(ultima?.estado === 'terminada'
          ? `Búsqueda terminada: ${ultima.resumen?.con_sugerencia ?? 0} con sugerencia.`
          : ultima?.estado === 'cancelada' ? 'La búsqueda se canceló. Lo encontrado hasta ahora se queda.'
            : 'La búsqueda terminó con un error o se cortó. Revisa la corrida en GitHub.', ultima?.estado === 'terminada' ? 'success' : ultima?.estado === 'cancelada' ? 'info' : 'error');
      }
    }, CADA_MS);
    return () => clearInterval(t);
  }, [arrancando, buscando, corrida?.estado, corrida?.procesados, lanzado, cargarEstado, revisarViva, cargar, addToast]);

  const lanzar = async (forzar) => {
    const config = await getGitHubConfig();
    if (!config?.token || !config.repo_owner || !config.repo_name) {
      setVerGithub(true);
      addToast('Faltan las credenciales de GitHub Actions.', 'info');
      return;
    }
    try {
      await triggerGitHubScraper({ config: { ...config, workflow_event_type: 'buscar-enlaces' }, payload: forzar ? { forzar: '1' } : null });
      const t = Date.now();
      setLanzado(t);
      guardarLanzado(t);
      addToast('Buscador lanzado en GitHub: arranca en unos minutos.', 'info');
    } catch (err) {
      addToast(`No se pudo lanzar el buscador: ${err.message}`, 'error');
    }
  };

  const quitar = (ids) => setFilas(prev => prev.filter(f => !ids.includes(f.id)));

  const aceptar = async (s) => {
    setProcesando(s.id);
    try {
      const { error } = await supabase.rpc('fn_aceptar_sugerencia', { p_id: s.id });
      if (error) throw error;
      quitar(filas.filter(f => f.producto_id === s.producto_id && f.cadena_id === s.cadena_id).map(f => f.id));
      refreshCompetencia?.();
      addToast(`Enlace creado en ${nombreCadena(s.cadena_id)}. El robot de precios lo leerá en su próxima corrida.`, 'success');
    } catch (err) {
      addToast(`No se pudo aceptar: ${err.message}`, 'error');
    } finally {
      setProcesando(null);
    }
  };

  const cambiarEstado = async (s, estado) => {
    setProcesando(s.id);
    try {
      const { data, error } = await supabase.from('sugerencias_enlaces')
        .update({ estado, revisado: estado === 'pendiente' ? null : new Date().toISOString(), actualizado: new Date().toISOString() })
        .eq('id', s.id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('No se guardó el cambio.');
      quitar([s.id]);
      const anterior = ver;
      addToast(estado === 'descartada' ? 'Sugerencia descartada: no se vuelve a proponer.' : 'Sugerencia de vuelta en Por revisar.', 'success', {
        accion: {
          texto: 'Deshacer',
          onClick: async () => {
            await supabase.from('sugerencias_enlaces').update({ estado: anterior, revisado: anterior === 'pendiente' ? null : new Date().toISOString() }).eq('id', s.id);
            cargar();
          },
        },
      });
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally {
      setProcesando(null);
    }
  };

  // Agrupadas por producto, con los filtros aplicados.
  const grupos = useMemo(() => {
    const t = normalizar(busqueda);
    const visibles = filas.filter(f =>
      (cadena === 'todos' || f.cadena_id === cadena)
      && (nivel === 'todos' || (nivel === 'perfectas' ? f.puntaje >= 100 : f.puntaje >= 90))
      && (!t || normalizar(`${f.id_producto_propio} ${f.producto_nombre} ${f.producto_propio_nombre || ''} ${f.laboratorio} ${f.nombre_tienda}`).includes(t)));
    const m = new Map();
    for (const f of visibles) {
      if (!m.has(f.producto_id)) m.set(f.producto_id, { producto: f, sugerencias: [] });
      m.get(f.producto_id).sugerencias.push(f);
    }
    return [...m.values()].sort((a, b) => Math.max(...b.sugerencias.map(s => s.puntaje)) - Math.max(...a.sugerencias.map(s => s.puntaje)));
  }, [filas, cadena, nivel, busqueda]);

  const hayFiltros = cadena !== 'todos' || nivel !== 'todos' || busqueda !== '';
  const limpiar = () => { setCadena('todos'); setNivel('todos'); setBusqueda(''); };
  const cadenasEnLista = [...new Set(filas.map(f => f.cadena_id))];
  const perfectas = filas.filter(f => f.puntaje >= 100).length;
  const conBuscador = cadenas.filter(c => PLATAFORMAS[c.plataforma]).length;

  if (sinFase36) {
    return (
      <div className="m3-dash-card flex items-start gap-3 text-on-surface-variant">
        <span className="material-symbols-outlined text-primary" aria-hidden="true">database</span>
        <p className="m3-body-medium">Ejecuta <strong>fase36_sugerencias_enlaces.sql</strong> en Supabase para usar el buscador de enlaces.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tiendas y estado del robot */}
      <section className="m3-dash-card space-y-3" aria-label="Buscador">
        <div className="flex flex-col md:flex-row md:items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h3 className="m3-title-medium text-on-surface">Tiendas donde se busca</h3>
              <InfoGrafico titulo="Sugerencias de enlaces"
                que="Un robot en GitHub toma los productos que ya están en Relación y los busca en las cadenas donde todavía no tienen enlace: con el buscador público de la tienda (rápido) o, si no tiene, con un navegador que busca como una persona (más lento)."
                formula={[
                  'Laboratorio 40 · Dosis 30 · Tamaño 30 (si falta el dato: 20 / 10 / 10)',
                  'Dosis o tamaño distintos = no se sugiere',
                  'Se sugiere desde 70 puntos; hasta 3 por producto y cadena',
                ]}
                lectura="Nada se vuelve enlace hasta que lo aceptas. Al aceptar, el enlace se crea activo y el robot de precios lo lee en su próxima corrida. Lo descartado no se vuelve a proponer. Un producto ya buscado en una cadena no se repite antes de 7 días (salvo «Buscar todo de nuevo»)." />
            </div>
            <ul className="flex flex-wrap gap-2 mt-2">
              {cadenas.map(c => <EstadoCadena key={c.id} cadena={c} onConfigurar={() => setConfigurar(c)} />)}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end shrink-0">
            <button data-edita type="button" onClick={() => setConfirmarTodo(true)} disabled={arrancando || buscando} className="m3-btn-text"
              title="Busca todos los productos otra vez, aunque se hayan buscado hace poco, y vuelve a revisar cada tienda">
              Buscar todo de nuevo
            </button>
            <button data-edita type="button" onClick={() => lanzar(false)} disabled={arrancando || buscando} className="m3-btn-primary h-10 px-5">
              <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">travel_explore</span>
              Buscar enlaces
            </button>
          </div>
        </div>
        <EstadoCorrida corrida={corrida} arrancando={arrancando} onDetener={detener} deteniendo={deteniendo} />
      </section>

      <section className="grid grid-cols-3 gap-3" aria-label="Resumen">
        <StatCard compacto label={VISTAS[ver]} value={filas.length} icon="playlist_add_check" tono={ver === 'pendiente' && filas.length ? 'primary' : 'neutral'}
          hint={`${grupos.length} ${grupos.length === 1 ? 'producto' : 'productos'}`} />
        <StatCard compacto label="Coincidencia perfecta" value={perfectas} icon="verified" tono="neutral" hint="Laboratorio, dosis y tamaño"
          onClick={() => setNivel(nivel === 'perfectas' ? 'todos' : 'perfectas')} title="Ver solo las perfectas" />
        <StatCard compacto label="Tiendas con buscador" value={`${conBuscador} de ${cadenas.length}`} icon="storefront" tono="neutral"
          hint="Las demás aún no se pueden buscar" />
      </section>

      <section className="m3-data-table" aria-label="Sugerencias">
        <div className="m3-data-table-toolbar flex flex-col gap-3">
          <BarraFiltros integrada limpiar={{ visible: hayFiltros, onClick: limpiar }} filtrar={<>
            <Segmentado etiqueta="Qué sugerencias ver" valor={ver} onChange={setVer} opciones={Object.entries(VISTAS).map(([v, t]) => [v, t])} />
            <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
              opciones={[['todos', 'Cadena: todas'], ...cadenasEnLista.map(id => [id, nombreCadena(id)])]} />
            <FiltroChip etiqueta="Puntaje" icono="grade" valor={nivel} onChange={setNivel}
              opciones={[['todos', 'Puntaje: todos'], ['perfectas', 'Solo perfectas (100)'], ['altas', '90 o más']]} />
          </>} />
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, producto o nombre en la tienda" aria-label="Buscar sugerencia" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant mr-2">{grupos.length} {grupos.length === 1 ? 'producto' : 'productos'}</span>
              <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
                <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
              </button>
            </div>
          </div>
        </div>

        {cargando && filas.length === 0 ? (
          <div className="h-48 m3-skeleton m-4 rounded-2xl" aria-busy="true" />
        ) : grupos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 px-6 text-center text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl" aria-hidden="true">{hayFiltros ? 'filter_alt_off' : 'travel_explore'}</span>
            <p className="m3-title-medium text-on-surface">
              {hayFiltros ? 'Ninguna sugerencia con estos filtros' : ver === 'pendiente' ? 'No hay sugerencias por revisar' : `Aún no hay sugerencias ${VISTAS[ver].toLowerCase()}`}
            </p>
            {!hayFiltros && ver === 'pendiente' && <p className="m3-body-medium">Pulsa «Buscar enlaces» para que el robot busque tus productos en las otras cadenas.</p>}
          </div>
        ) : (
          <ul className="m3-sugerencias-lista">
            {grupos.slice(0, limite).map(g => (
              <li key={g.producto.producto_id} className="m3-sugerencias-grupo">
                <CabeceraProducto p={g.producto} propio={propioPorId.get(String(g.producto.id_producto_propio).trim())} />
                <ul>
                  {g.sugerencias.map(s => (
                    <FilaSugerencia key={s.id} s={s} ver={ver} nombreCadena={nombreCadena} procesando={procesando === s.id}
                      onAceptar={() => aceptar(s)} onDescartar={() => cambiarEstado(s, 'descartada')} onReabrir={() => cambiarEstado(s, 'pendiente')} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {grupos.length > limite && (
          <div className="flex justify-center p-3 border-t border-outline-variant">
            <button type="button" className="m3-btn-text" onClick={() => setLimite(l => l + POR_PAGINA)}>
              Mostrar {Math.min(POR_PAGINA, grupos.length - limite)} productos más
            </button>
          </div>
        )}
      </section>
      <GitHubConfigModal isOpen={verGithub} onClose={() => setVerGithub(false)} />
      <ConfirmModal isOpen={confirmarTodo} title="¿Buscar todo de nuevo?"
        message={'Vuelve a revisar cada tienda y a buscar todos los productos, aunque se hayan buscado hace poco.\n\nLas sugerencias por revisar se REEMPLAZAN con los resultados nuevos (precio, puntaje y enlaces que ya no aparecen). Las aceptadas y descartadas no se tocan.\n\nTarda bastante más que «Buscar enlaces».'}
        confirmText="Buscar todo" onCancel={() => setConfirmarTodo(false)}
        onConfirm={() => { setConfirmarTodo(false); lanzar(true); }} />
      {configurar && <ConfigurarTienda cadena={configurar} onClose={() => setConfigurar(null)}
        onGuardado={() => { setConfigurar(null); cargarEstado(); }} />}
    </div>
  );
}

function EstadoCadena({ cadena: c, onConfigurar }) {
  const nombre = PLATAFORMAS[c.plataforma];
  const huellas = c.plataforma_detalle?.huellas?.length ? `Se vio: ${c.plataforma_detalle.huellas.join(', ')}` : '';
  const [texto, clase, titulo] = nombre
    ? [nombre, 'is-si', c.plataforma === 'navegador'
      ? `Se busca con un navegador, como una persona (${c.plataforma_detalle?.modo === 'url' ? 'con su dirección de búsqueda' : 'escribiendo en su campo Buscar'}): es más lento. Revisada el ${fecha(c.plataforma_revisada)}.`
      : `Se puede buscar (${nombre})${c.plataforma_detalle?.moneda ? `, precios en ${c.plataforma_detalle.moneda}` : ''}. Revisada el ${fecha(c.plataforma_revisada)}.`]
    : c.plataforma === 'sin_buscador'
      ? ['Sin buscador', 'is-no', [`Ni el buscador público ni el navegador lograron buscar en esta tienda. ${c.plataforma_detalle?.nota || ''} ${huellas}`.trim(),
          diagnostico(c.plataforma_detalle?.diagnostico), 'Toca para poner a mano su dirección de búsqueda.'].filter(Boolean).join('\n')]
      : !c.website
        ? ['Sin web', 'is-no', 'Agrega su página web en Cadenas para poder buscar en ella.']
        : ['Por revisar', 'is-duda', 'Se revisa en la primera búsqueda.'];
  const manual = c.plataforma_detalle?.manual;
  const editable = c.website && (c.plataforma === 'sin_buscador' || c.plataforma === 'navegador');
  const contenido = (
    <>
      <CadenaBadge cadena={c.id} tamano="xs" title="" />
      <span className="text-on-surface">{c.nombre}</span>
      <span className="m3-tienda-estado">{manual ? 'Dirección a mano' : texto}</span>
      {editable && <span className="material-symbols-outlined m3-tienda-editar" aria-hidden="true">edit</span>}
    </>
  );
  return (
    <li className={`m3-tienda ${clase}`}>
      {editable ? (
        <button type="button" onClick={onConfigurar} className="m3-tienda-boton" title={`${titulo}${manual ? '' : ''}`}>{contenido}</button>
      ) : <span className="m3-tienda-boton" title={titulo}>{contenido}</span>}
    </li>
  );
}

function diagnostico(d) {
  if (!d) return '';
  return [d.url ? `Página: ${d.url}` : '', d.titulo ? `Título: ${d.titulo}` : '', d.enlaces != null ? `Enlaces en la página: ${d.enlaces}` : '',
    d.campos?.length ? `Campos: ${d.campos.join(', ')}` : '', d.muestras?.length ? `Se vio: ${d.muestras.slice(0, 4).join(' | ')}` : '']
    .filter(Boolean).join('\n');
}

// Direccion de busqueda puesta a mano: la pagina de resultados de la tienda
// al buscar "losartan", con esa palabra cambiada por {q}.
function ConfigurarTienda({ cadena: c, onClose, onGuardado }) {
  const { addToast } = useToast();
  const actual = c.plataforma_detalle?.manual ? String(c.plataforma_detalle.busqueda_url || '').replace('{q}', 'losartan') : '';
  const [url, setUrl] = useState(actual);
  const [guardando, setGuardando] = useState(false);
  const valida = /^https?:\/\//i.test(url.trim()) && /losartan/i.test(url);
  const guardar = async (quitar) => {
    setGuardando(true);
    try {
      const cambios = quitar
        ? { plataforma: null, plataforma_detalle: null, plataforma_revisada: null }
        : { plataforma: 'navegador', plataforma_revisada: new Date().toISOString(),
            plataforma_detalle: { modo: 'url', busqueda_url: url.trim().replace(/losartan/i, '{q}'), manual: true } };
      const { data, error } = await supabase.from('dim_cadenas').update(cambios).eq('id', c.id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('No se guardó el cambio.');
      addToast(quitar ? 'Dirección quitada: el robot la vuelve a averiguar en la próxima búsqueda.' : `Listo: el robot buscará en ${c.nombre} con esa dirección.`, 'success');
      onGuardado();
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally {
      setGuardando(false);
    }
  };
  return (
    <ModalWrapper isOpen onClose={onClose} title={`Cómo buscar en ${c.nombre}`} icon="travel_explore" maxWidth="max-w-lg"
      footer={
        <div className="flex flex-wrap items-center gap-2 w-full">
          {c.plataforma_detalle?.manual && (
            <button type="button" onClick={() => guardar(true)} disabled={guardando} className="m3-btn-text-danger mr-auto">Quitar dirección</button>
          )}
          <button type="button" onClick={onClose} className="m3-btn-text ml-auto">Cancelar</button>
          <button type="button" onClick={() => guardar(false)} disabled={!valida || guardando} className="m3-btn-primary h-10 px-5">Guardar</button>
        </div>
      }>
      <ol className="m3-body-medium text-on-surface space-y-2 list-decimal pl-5">
        <li>Abre <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{c.website}</a> y busca <strong>losartan</strong> en su buscador.</li>
        <li>En la página de resultados, copia la dirección completa de arriba del navegador.</li>
        <li>Pégala aquí. El robot cambia «losartan» por cada producto que busque.</li>
      </ol>
      <label className="block mt-4">
        <span className="m3-label-large text-on-surface-variant">Dirección de la página de resultados</span>
        <input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder={`${c.website}/...losartan...`}
          className="m3-input w-full mt-1" autoFocus />
      </label>
      {url && !valida && <p className="m3-body-small text-error mt-1">La dirección tiene que empezar por http y contener la palabra «losartan».</p>}
      <p className="m3-body-small text-on-surface-variant mt-3">Si la dirección no cambia al buscar (la tienda no pone la búsqueda en la dirección), avísale a quien mantiene el panel.</p>
    </ModalWrapper>
  );
}

function EstadoCorrida({ corrida, arrancando, onDetener, deteniendo }) {
  if (arrancando) {
    return (
      <div className="m3-banner m3-banner-info" role="status">
        <span className="material-symbols-outlined animate-spin" aria-hidden="true">sync</span>
        <span className="m3-body-medium flex-1">El buscador está arrancando en GitHub (unos minutos). Puedes seguir usando el panel.</span>
      </div>
    );
  }
  if (!corrida) return <p className="m3-body-small text-on-surface-variant">Aún no se ha buscado ninguna vez.</p>;
  if (corrida.estado === 'corriendo') {
    const avance = corrida.total ? Math.min(100, (corrida.procesados / corrida.total) * 100) : 0;
    return (
      <div className="m3-banner m3-banner-info" role="status">
        <span className="material-symbols-outlined animate-spin" aria-hidden="true">sync</span>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="m3-body-medium"><strong>Buscando</strong> · {corrida.procesados || 0} de {corrida.total ?? '…'} búsquedas</div>
          <div className="m3-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(avance)}><div style={{ width: `${Math.max(4, avance)}%` }} /></div>
        </div>
        {corrida.url_github && <a href={corrida.url_github} target="_blank" rel="noopener noreferrer" className="m3-btn-text">Ver en GitHub</a>}
        <button data-edita type="button" onClick={onDetener} disabled={deteniendo} className="m3-btn-outline h-9 px-4" title="Detener la búsqueda en GitHub">
          {deteniendo ? 'Deteniendo…' : 'Detener'}
        </button>
      </div>
    );
  }
  const r = corrida.resumen || {};
  return (
    <p className="m3-body-small text-on-surface-variant">
      Última búsqueda: {fecha(corrida.fin || corrida.inicio)}
      {corrida.estado === 'fallida'
        ? <span className="text-error"> · terminó con un error{r.error ? `: ${r.error}` : ''}</span>
        : corrida.estado === 'cancelada' ? ` · se canceló en ${corrida.procesados ?? 0} de ${corrida.total ?? '?'} búsquedas`
        : corrida.estado === 'interrumpida' ? ` · se cortó en ${corrida.procesados ?? 0} de ${corrida.total ?? '?'} búsquedas`
        : ` · ${corrida.procesados ?? 0} búsquedas · ${r.con_sugerencia ?? 0} con sugerencia`}
      {corrida.url_github && <> · <a href={corrida.url_github} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ver en GitHub</a></>}
    </p>
  );
}

// Igual que Revision de capturas: tu producto y el que se busca, en filas
// alineadas, cada uno con laboratorio y presentacion.
function CabeceraProducto({ p, propio }) {
  const pres = presentacion(p.registrada_dosis_mg, p.registrada_tamano, p.registrada_unidad);
  const presPropio = propio ? [propio.concentracion && propio.concentracion !== '—' ? propio.concentracion : null, describirPresentacion(propio)].filter(v => v && v !== '—').join(' · ') : '';
  return (
    <div className="m3-sugerencias-producto">
      <dl className="m3-revision-comparacion mt-0">
        <dt>Tu producto</dt>
        <dd>
          <span className="text-on-surface font-medium">{propio?.nombre || p.producto_propio_nombre || p.producto_nombre}</span>
          <span className="text-on-surface-variant">{[presPropio, propio?.laboratorio, p.id_producto_propio].filter(Boolean).map(t => ` · ${t}`).join('')}</span>
        </dd>
        <dt>Se busca</dt>
        <dd>
          {p.es_propio ? (
            <span className="text-on-surface">Tu mismo producto, en las cadenas donde aún no tienes enlace{pres ? <span className="text-on-surface-variant"> · {pres}</span> : null}</span>
          ) : (
            <>
              <span className="text-on-surface font-medium">{p.producto_nombre}</span>
              <span className="text-on-surface-variant">{[p.laboratorio, pres || 'sin dosis ni tamaño registrados'].filter(Boolean).map(t => ` · ${t}`).join('')}</span>
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}

// Dosis y tamano que se leen en el nombre de la tienda ("50 mg", "x 30", "120 ml").
function leerPresentacion(nombre) {
  const t = String(nombre || '').toLowerCase().replace(',', '.');
  const dosis = t.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|g)\b(?!\s*\/)/);
  const tam = t.match(/\bx\s*(\d{1,4})\b/) || t.match(/\b(\d{1,4})\s*(tabletas?|tabs?|c[aá]psulas?|caps?|comprimidos?|grageas?|sobres?|unidades?)\b/)
    || t.match(/(\d{2,4})\s*ml\b/);
  const partes = [];
  if (dosis) partes.push(`${dosis[1].replace('.', ',')} ${dosis[2]}`);
  if (tam) partes.push(/ml\b/.test(tam[0]) && !/^x/.test(tam[0]) ? `${tam[1]} ml` : `x ${tam[1]}`);
  return partes.join(' ');
}

const CRITERIOS = [['laboratorio', 'Laboratorio'], ['dosis', 'Dosis'], ['tamano', 'Tamaño']];

function FilaSugerencia({ s, ver, nombreCadena, procesando, onAceptar, onDescartar, onReabrir }) {
  const d = s.detalle || {};
  return (
    <li className="m3-sugerencia">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 m3-label-medium text-on-surface-variant">
            <CadenaBadge cadena={s.cadena_id} tamano="xs" title="" />{nombreCadena(s.cadena_id)}
          </span>
          <span className={`m3-puntaje ${s.puntaje >= 100 ? 'is-alto' : s.puntaje >= 90 ? 'is-medio' : ''}`} title="Puntaje de coincidencia (0 a 100)">{s.puntaje} de 100</span>
          {s.disponible === false && <span className="m3-chip-caido">Agotado</span>}
        </div>
        <dl className="m3-revision-comparacion">
          <dt>La tienda muestra</dt>
          <dd>
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-on-surface hover:underline" title="Abrir en la tienda">
              «{s.nombre_tienda || s.url}»
              <span className="material-symbols-outlined text-[14px] text-on-surface-variant align-[-2px] ml-0.5" aria-hidden="true">open_in_new</span>
            </a>
            <span className={d.dosis === 'no' || d.tamano === 'no' ? 'text-error' : 'text-on-surface-variant'}>
              {[leerPresentacion(s.nombre_tienda), s.marca_tienda].filter(Boolean).map(t => ` · ${t}`).join('')}
            </span>
          </dd>
        </dl>
        <div className="m3-revision-porque">
          <span className="material-symbols-outlined" aria-hidden="true">info</span>
          <span>
            {CRITERIOS.map(([k, t], i) => (
              <span key={k} className={d[k] === 'no' ? 'text-error' : d[k] === 'si' ? 'text-on-surface' : 'text-on-surface-variant'}>
                {i > 0 ? ' · ' : ''}{t}: {d[k] === 'si' ? 'coincide' : d[k] === 'no' ? 'no coincide' : 'no se pudo comprobar'}
              </span>
            ))}
            {d.consulta && <span className="text-on-surface-variant"> · se buscó «{d.consulta}»</span>}
          </span>
        </div>
      </div>
      <div className="text-right tabular-nums m3-body-medium text-on-surface whitespace-nowrap">{precio(s.precio, s.moneda)}</div>
      <div className="m3-sugerencia-acciones">
        {ver === 'pendiente' ? (
          s.ya_tiene_enlace ? (
            <>
              <span className="m3-body-small text-on-surface-variant">Ya tiene enlace en esta cadena</span>
              <button data-edita type="button" onClick={onDescartar} disabled={procesando} className="m3-btn-text">Descartar</button>
            </>
          ) : (
            <>
              <button data-edita type="button" onClick={onDescartar} disabled={procesando} className="m3-btn-text">Descartar</button>
              <button data-edita type="button" onClick={onAceptar} disabled={procesando} className="m3-btn-primary h-10 px-4" title="Crear el enlace en Relación">
                {procesando ? 'Creando…' : 'Aceptar'}
              </button>
            </>
          )
        ) : ver === 'descartada' ? (
          <button data-edita type="button" onClick={onReabrir} disabled={procesando} className="m3-btn-outline h-10 px-4">
            <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">undo</span>
            Volver a revisar
          </button>
        ) : (
          <Link to={`/competencia?producto=${encodeURIComponent(s.id_producto_propio)}`} className="m3-btn-text">
            <span className="material-symbols-outlined" aria-hidden="true">link</span>
            Ver en Relación
          </Link>
        )}
      </div>
    </li>
  );
}
