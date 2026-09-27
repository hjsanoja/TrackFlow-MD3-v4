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
import { normalizar } from './formulario';
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
const leerLanzado = () => { try { return Number(localStorage.getItem(CLAVE_LANZADO)) || 0; } catch { return 0; } };
const guardarLanzado = (t) => { try { if (t) localStorage.setItem(CLAVE_LANZADO, String(t)); else localStorage.removeItem(CLAVE_LANZADO); } catch { /* sin almacenamiento */ } };

export default function SugerenciasEnlaces() {
  const { refreshCompetencia } = useData() || {};
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
  useEffect(() => { setLimite(POR_PAGINA); }, [ver, cadena, nivel, busqueda]);

  // Mientras el robot arranca o busca, se consulta su avance.
  const inicioCorrida = corrida ? new Date(corrida.inicio).getTime() : 0;
  const arrancando = lanzado > 0 && inicioCorrida < lanzado - 60000 && Date.now() - lanzado < 20 * 60000;
  const buscando = corrida?.estado === 'corriendo';
  useEffect(() => {
    if (!arrancando && !buscando) return undefined;
    const t = setInterval(async () => {
      const antes = corrida?.estado;
      const ultima = await cargarEstado();
      if (lanzado && ultima && new Date(ultima.inicio).getTime() >= lanzado - 60000) {
        setLanzado(0);
        guardarLanzado(0);
        if (ultima.estado !== 'corriendo') cargar();
      }
      if (antes === 'corriendo' && ultima?.estado !== 'corriendo') {
        cargar();
        addToast(ultima?.estado === 'terminada'
          ? `Búsqueda terminada: ${ultima.resumen?.con_sugerencia ?? 0} con sugerencia.`
          : 'La búsqueda terminó con un error. Revisa la corrida en GitHub.', ultima?.estado === 'terminada' ? 'success' : 'error');
      }
    }, CADA_MS);
    return () => clearInterval(t);
  }, [arrancando, buscando, corrida?.estado, lanzado, cargarEstado, cargar, addToast]);

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
                que="Un robot en GitHub toma los productos que ya están en Competencia y los busca en las cadenas donde todavía no tienen enlace: con el buscador público de la tienda (rápido) o, si no tiene, con un navegador que busca como una persona (más lento)."
                formula={[
                  'Laboratorio 40 · Dosis 30 · Tamaño 30 (si falta el dato: 20 / 10 / 10)',
                  'Dosis o tamaño distintos = no se sugiere',
                  'Se sugiere desde 70 puntos; hasta 3 por producto y cadena',
                ]}
                lectura="Nada se vuelve enlace hasta que lo aceptas. Al aceptar, el enlace se crea activo y el robot de precios lo lee en su próxima corrida. Lo descartado no se vuelve a proponer. Un producto ya buscado en una cadena no se repite antes de 7 días (salvo «Buscar todo de nuevo»)." />
            </div>
            <ul className="flex flex-wrap gap-2 mt-2">
              {cadenas.map(c => <EstadoCadena key={c.id} cadena={c} />)}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end shrink-0">
            <button type="button" onClick={() => lanzar(true)} disabled={arrancando || buscando} className="m3-btn-text"
              title="Busca todos los productos otra vez, aunque se hayan buscado hace poco, y vuelve a revisar cada tienda">
              Buscar todo de nuevo
            </button>
            <button type="button" onClick={() => lanzar(false)} disabled={arrancando || buscando} className="m3-btn-primary h-10 px-5">
              <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">travel_explore</span>
              Buscar enlaces
            </button>
          </div>
        </div>
        <EstadoCorrida corrida={corrida} arrancando={arrancando} />
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
                <CabeceraProducto p={g.producto} />
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
    </div>
  );
}

function EstadoCadena({ cadena: c }) {
  const nombre = PLATAFORMAS[c.plataforma];
  const huellas = c.plataforma_detalle?.huellas?.length ? `Se vio: ${c.plataforma_detalle.huellas.join(', ')}` : '';
  const [texto, clase, titulo] = nombre
    ? [nombre, 'is-si', c.plataforma === 'navegador'
      ? `Se busca con un navegador, como una persona (${c.plataforma_detalle?.modo === 'url' ? 'con su dirección de búsqueda' : 'escribiendo en su campo Buscar'}): es más lento. Revisada el ${fecha(c.plataforma_revisada)}.`
      : `Se puede buscar (${nombre})${c.plataforma_detalle?.moneda ? `, precios en ${c.plataforma_detalle.moneda}` : ''}. Revisada el ${fecha(c.plataforma_revisada)}.`]
    : c.plataforma === 'sin_buscador'
      ? ['Sin buscador', 'is-no', `Ni el buscador público ni el navegador lograron buscar en esta tienda. ${c.plataforma_detalle?.nota || ''} ${huellas}`.trim()]
      : !c.website
        ? ['Sin web', 'is-no', 'Agrega su página web en Cadenas para poder buscar en ella.']
        : ['Por revisar', 'is-duda', 'Se revisa en la primera búsqueda.'];
  return (
    <li className={`m3-tienda ${clase}`} title={titulo}>
      <CadenaBadge cadena={c.id} tamano="xs" title="" />
      <span className="text-on-surface">{c.nombre}</span>
      <span className="m3-tienda-estado">{texto}</span>
    </li>
  );
}

function EstadoCorrida({ corrida, arrancando }) {
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
      </div>
    );
  }
  const r = corrida.resumen || {};
  return (
    <p className="m3-body-small text-on-surface-variant">
      Última búsqueda: {fecha(corrida.fin || corrida.inicio)}
      {corrida.estado === 'fallida'
        ? <span className="text-error"> · terminó con un error{r.error ? `: ${r.error}` : ''}</span>
        : ` · ${corrida.procesados ?? 0} búsquedas · ${r.con_sugerencia ?? 0} con sugerencia`}
      {corrida.url_github && <> · <a href={corrida.url_github} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ver en GitHub</a></>}
    </p>
  );
}

function CabeceraProducto({ p }) {
  const pres = presentacion(p.registrada_dosis_mg, p.registrada_tamano, p.registrada_unidad);
  return (
    <div className="m3-sugerencias-producto">
      <div className="flex items-center gap-2 min-w-0">
        {p.es_propio && <span className="m3-chip-propio">Tú</span>}
        <span className="m3-title-small text-on-surface truncate" title={p.producto_nombre}>{p.producto_nombre}</span>
      </div>
      <div className="m3-body-small text-on-surface-variant truncate">
        {[p.id_producto_propio, p.laboratorio, pres || 'sin dosis ni tamaño registrados', !p.es_propio && p.producto_propio_nombre ? `frente a ${p.producto_propio_nombre}` : null].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

const CRITERIOS = [['laboratorio', 'Laboratorio'], ['dosis', 'Dosis'], ['tamano', 'Tamaño']];
const ICONO = { si: 'check', no: 'close', '?': 'help' };

function FilaSugerencia({ s, ver, nombreCadena, procesando, onAceptar, onDescartar, onReabrir }) {
  const d = s.detalle || {};
  return (
    <li className="m3-sugerencia">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 m3-label-medium text-on-surface-variant">
            <CadenaBadge cadena={s.cadena_id} tamano="xs" title="" />{nombreCadena(s.cadena_id)}
          </span>
          <span className={`m3-puntaje ${s.puntaje >= 100 ? 'is-alto' : s.puntaje >= 90 ? 'is-medio' : ''}`} title="Puntaje de coincidencia (0 a 100)">{s.puntaje}</span>
          {CRITERIOS.map(([k, t]) => (
            <span key={k} className={`m3-criterio is-${d[k] === 'si' ? 'si' : d[k] === 'no' ? 'no' : 'duda'}`}
              title={d[k] === 'si' ? `${t}: coincide` : d[k] === 'no' ? `${t}: no coincide` : `${t}: no se pudo comprobar`}>
              <span className="material-symbols-outlined" aria-hidden="true">{ICONO[d[k]] || 'help'}</span>{t}
            </span>
          ))}
          {s.disponible === false && <span className="m3-chip-caido">Agotado</span>}
        </div>
        <a href={s.url} target="_blank" rel="noopener noreferrer" className="m3-body-medium text-on-surface hover:underline mt-1 inline-flex items-center gap-1 max-w-full" title="Abrir en la tienda">
          <span className="truncate">{s.nombre_tienda || s.url}</span>
          <span className="material-symbols-outlined text-[16px] text-on-surface-variant shrink-0" aria-hidden="true">open_in_new</span>
        </a>
        <div className="m3-body-small text-on-surface-variant truncate">
          {[s.marca_tienda, d.consulta ? `buscado como «${d.consulta}»` : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="text-right tabular-nums m3-body-medium text-on-surface whitespace-nowrap">{precio(s.precio, s.moneda)}</div>
      <div className="m3-sugerencia-acciones">
        {ver === 'pendiente' ? (
          s.ya_tiene_enlace ? (
            <>
              <span className="m3-body-small text-on-surface-variant">Ya tiene enlace en esta cadena</span>
              <button type="button" onClick={onDescartar} disabled={procesando} className="m3-btn-text">Descartar</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onDescartar} disabled={procesando} className="m3-btn-text">Descartar</button>
              <button type="button" onClick={onAceptar} disabled={procesando} className="m3-btn-primary h-10 px-4" title="Crear el enlace en Competencia">
                {procesando ? 'Creando…' : 'Aceptar'}
              </button>
            </>
          )
        ) : ver === 'descartada' ? (
          <button type="button" onClick={onReabrir} disabled={procesando} className="m3-btn-outline h-10 px-4">
            <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">undo</span>
            Volver a revisar
          </button>
        ) : (
          <Link to={`/competencia?producto=${encodeURIComponent(s.id_producto_propio)}`} className="m3-btn-text">
            <span className="material-symbols-outlined" aria-hidden="true">link</span>
            Ver en Competencia
          </Link>
        )}
      </div>
    </li>
  );
}
