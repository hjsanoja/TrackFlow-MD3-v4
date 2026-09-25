import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList, LineChart, Line,
} from 'recharts';
import StatCard from '../components/StatCard';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import CadenaBadge from '../components/CadenaBadge';
import AvisoRobot from '../components/AvisoRobot';
import DetalleLista from '../components/DetalleLista';
import ProductDetailModal from '../components/ProductDetailModal';
import BcvDetailModal from '../components/BcvDetailModal';
import ConfirmModal from '../components/ConfirmModal';
import GitHubConfigModal from '../components/GitHubConfigModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { useRobot, estimarMinutos } from '../hooks/useRobot';
import { tokensGrafico } from '../utils/chartTokens';
import { getChainColor } from '../utils/brandColors';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { dbClearAllHistoricoPrecios } from '../utils/dbClient';
import { exportToCSV } from '../utils/exportUtils';
import { fechaHora, haceCuanto } from '../utils/usuarios';
import { normalizar } from '../components/formulario';

// Preferencias de vista que se recuerdan en el navegador.
function usePreferencia(clave, inicial, validos) {
  const [valor, setValor] = useState(() => {
    try {
      const guardado = localStorage.getItem(clave);
      if (guardado == null) return inicial;
      const v = typeof inicial === 'number' ? Number(guardado) : guardado;
      return !validos || validos.includes(v) ? v : inicial;
    } catch { return inicial; }
  });
  const cambiar = useCallback((v) => {
    setValor(v);
    try { localStorage.setItem(clave, String(v)); } catch { /* sin almacenamiento */ }
  }, [clave]);
  return [valor, cambiar];
}

// Un cambio de precio cuenta si se movio mas de 0,05 %.
const UMBRAL_CAMBIO = 0.05;
// Diferencia con el minimo por debajo de la cual se considera "empatado".
const UMBRAL_EMPATE = 0.5;

const VENTANAS = { 1: 'últimas 24 horas', 7: 'últimos 7 días', 15: 'últimos 15 días' };

// Grupos del grafico "Tu precio frente al promedio". Divergente: azul mas
// barato, gris parejo, rojo mas caro (tokens validados en m3-tokens.css).
const GRUPOS = [
  { id: 'muy_barato', corto: '15 % o más barato', eje: '−15 %|o más', desde: -Infinity, hasta: -15, token: '--md-sys-color-data-div-cheap-2', respaldo: '#2a78d6' },
  { id: 'barato', corto: '5 a 15 % más barato', eje: '−5 a|−15 %', desde: -15, hasta: -5, token: '--md-sys-color-data-div-cheap-1', respaldo: '#6aa1e6' },
  { id: 'parejo', corto: 'Parejo (±5 %)', eje: '±5 %', desde: -5, hasta: 5, token: '--md-sys-color-data-div-mid', respaldo: '#a9a8a3' },
  { id: 'caro', corto: '5 a 15 % más caro', eje: '+5 a|+15 %', desde: 5, hasta: 15, token: '--md-sys-color-data-div-dear-1', respaldo: '#ec7a79' },
  { id: 'muy_caro', corto: '15 % o más caro', eje: '+15 %|o más', desde: 15, hasta: Infinity, token: '--md-sys-color-data-div-dear-2', respaldo: '#e34948' },
];
const grupoDe = (dif) => GRUPOS.find(g => dif > g.desde && dif <= g.hasta) || (dif <= -15 ? GRUPOS[0] : GRUPOS[4]);

function leerColor(token, respaldo) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || respaldo;
  } catch { return respaldo; }
}

function mediana(valores) {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

// "−4,2 %" / "+3 %"
function pct(v, decimales = 1) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v).toLocaleString('es-VE', { maximumFractionDigits: decimales });
  if (Math.abs(v) < 0.05) return '0 %';
  return `${v > 0 ? '+' : '−'}${abs} %`;
}

// Diferencia con signo y color: azul/verde si eres mas barato, rojo si mas caro.
function Diferencia({ valor, invertir = false }) {
  if (valor == null || isNaN(valor)) return <span className="text-on-surface-variant">—</span>;
  const parejo = Math.abs(valor) < UMBRAL_EMPATE;
  const caro = invertir ? valor < 0 : valor > 0;
  return (
    <span className={`m3-diferencia ${parejo ? '' : caro ? 'is-caro' : 'is-barato'}`}>
      {!parejo && <span className="material-symbols-outlined" aria-hidden="true">{valor > 0 ? 'arrow_upward' : 'arrow_downward'}</span>}
      {pct(valor)}
    </span>
  );
}

export default function Dashboard({ userDoc }) {
  const {
    productos = [],
    productosCompetencia = [],
    cadenas = [],
    bcvRates: bcvHistorico = [],
    historicoPrecios = [],
    variaciones = [],
    loadingInitial: loading,
    refreshData,
    vaciarHistorico,
  } = useData();
  const { addToast } = useToast();
  const bcv = useBcvRate();
  const isAdmin = userDoc?.rol === 'administrador';

  // Vista
  const [moneda, setMoneda] = usePreferencia('trackflow_pref_currency', 'usd', ['usd', 'bs']);
  const [modoAnalisis, setModoAnalisis] = usePreferencia('trackflow_pref_analisis_mode', 'empaque', ['empaque', 'unidosis']);
  const [modoPrecio, setModoPrecio] = usePreferencia('dashboard.precio', 'lista', ['lista', 'descuento']);
  const [ventana, setVentana] = usePreferencia('trackflow_pref_ventana_variacion', 1, [1, 7, 15]);

  // Filtros de todo el panel
  const [filtroUnidad, setFiltroUnidad] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroCategoria, setFiltroCategoria] = useState('todos');

  // Tabla
  const [search, setSearch] = useState('');
  const [mostrar, setMostrar] = useState('todos');
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });
  const [paginaActual, setPaginaActual] = useState(1);
  const [itemsPorPagina, setItemsPorPagina] = usePreferencia('dashboard.filas', 10, [10, 25, 50, 100]);
  const tablaRef = useRef(null);
  const menuMasRef = useRef(null);

  // Modales
  const [detalle, setDetalle] = useState(null);         // lista detras de un indicador
  const [ficha, setFicha] = useState(null);             // { producto, competencia }
  const [volverA, setVolverA] = useState(null);         // lista a la que vuelve la ficha
  const [showBcvModal, setShowBcvModal] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [confirmRobot, setConfirmRobot] = useState(false);
  const [confirmBorrar, setConfirmBorrar] = useState(false);
  const [borrando, setBorrando] = useState(false);

  const robot = useRobot({
    onTerminado: async () => {
      await refreshData(true);
      addToast('Robot terminado: precios actualizados.', 'success');
    },
    onError: (mensaje, { faltaConfig } = {}) => {
      if (faltaConfig) setShowGithubModal(true);
      addToast(mensaje, faltaConfig ? 'info' : 'error');
    },
  });
  const enlacesActivos = useMemo(() => productosCompetencia.filter(e => e.activo !== false), [productosCompetencia]);

  // Cadenas: los enlaces viejos traen el nombre en vez del id.
  const cadenaPorClave = useMemo(() => {
    const m = new Map();
    for (const c of cadenas || []) {
      m.set(String(c.id).toLowerCase(), c);
      m.set(String(c.nombre).toLowerCase(), c);
    }
    return m;
  }, [cadenas]);
  const idCadena = useCallback((v) => cadenaPorClave.get(String(v || '').toLowerCase())?.id || v, [cadenaPorClave]);
  const nombreCadena = useCallback((v) => cadenaPorClave.get(String(v || '').toLowerCase())?.nombre || v || '—', [cadenaPorClave]);

  // ------------------------------------------------------------------------
  // Analisis por producto
  // ------------------------------------------------------------------------
  const analizados = useMemo(() => {
    // v_variacion: por enlace, el precio actual y los de hace 1, 7 y 15 dias.
    const mapaVariacion = new Map();
    (variaciones || []).forEach(v => { if (v.publicacion_id != null) mapaVariacion.set(v.publicacion_id, v); });

    // Respaldo para enlaces viejos sin publicacion_id: el historico completo.
    const claveHist = (id, cadena, marca) => `${id}_${cadena}_${marca}`.toLowerCase().replace(/[\s/\\]+/g, '_');
    const historial = {};
    historicoPrecios.forEach(h => {
      if (!h.id_producto_propio || !h.cadena || !h.marca) return;
      const k = claveHist(h.id_producto_propio, h.cadena, h.marca);
      (historial[k] ||= []).push(h);
    });
    const diaDe = (h) => h.fecha_local || (h.scraped_at ? new Date(h.scraped_at).toISOString().slice(0, 10) : null);
    const conDescuento = modoPrecio === 'descuento';
    const suf = ventana === 1 ? '1d' : ventana === 7 ? '7d' : '15d';

    const enlacesPorProducto = new Map();
    for (const e of productosCompetencia) {
      if (!e.activo || !e.id_producto_propio) continue;
      const id = String(e.id_producto_propio).trim();
      if (!enlacesPorProducto.has(id)) enlacesPorProducto.set(id, []);
      enlacesPorProducto.get(id).push(e);
    }

    return productos.filter(p => p.activo).map(p => {
      const pId = String(p.id_interno || p.id || '').trim();
      const competencia = enlacesPorProducto.get(pId) || [];
      const unidadesPropio = parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis || p.unidades_empaque);
      const factorPropio = modoAnalisis === 'unidosis' ? Math.max(unidadesPropio, 1) : 1;

      const precios = competencia.map(c => {
        const bs = conDescuento ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs) : c.ultimo_precio_full_bs;
        if (!bs || !bcv.rate) return null;
        const unidades = parseUnidosisCount(c.tamano, c.marca, c.unidosis || c.unidades_empaque) || unidadesPropio;
        const factor = modoAnalisis === 'unidosis' ? Math.max(unidades, 1) : 1;

        let ahora = null;
        let antes = null;
        const fila = c.publicacion_id != null ? mapaVariacion.get(c.publicacion_id) : null;
        if (fila) {
          ahora = conDescuento ? (fila.precio_actual_desc_bs ?? fila.precio_actual_full_bs) : fila.precio_actual_full_bs;
          antes = conDescuento ? (fila[`precio_${suf}_desc_bs`] ?? fila[`precio_${suf}_full_bs`]) : fila[`precio_${suf}_full_bs`];
        } else {
          const lista = historial[claveHist(p.id_interno, c.cadena, c.marca)] || [];
          const actual = lista[0];
          const dia = actual && diaDe(actual);
          if (dia) {
            const corte = new Date(`${dia}T00:00:00Z`);
            corte.setUTCDate(corte.getUTCDate() - ventana);
            const diaCorte = corte.toISOString().slice(0, 10);
            const previo = lista.find(x => { const d = diaDe(x); return d && d <= diaCorte; });
            const valor = h => (conDescuento ? (h.precio_desc_bs || h.precio_full_bs) : h.precio_full_bs);
            ahora = valor(actual);
            antes = previo ? valor(previo) : null;
          }
        }
        const valorAhora = ahora != null ? Number(ahora) / factor : bs / factor;
        const valorAntes = antes != null ? Number(antes) / factor : null;
        const cambio = valorAntes > 0 ? ((valorAhora - valorAntes) / valorAntes) * 100 : 0;

        return {
          id: c.id,
          tipo: String(c.tipo || '').toLowerCase(),
          cadena: idCadena(c.cadena),
          marca: c.marca,
          priceUsd: bs / factor / bcv.rate,
          antesUsd: valorAntes != null ? valorAntes / bcv.rate : null,
          cambio,
        };
      }).filter(v => v && v.priceUsd > 0);

      const propios = precios.filter(x => x.tipo === 'propio');
      const competidores = precios.filter(x => x.tipo !== 'propio');
      const valores = competidores.map(x => x.priceUsd);
      const minimo = valores.length ? Math.min(...valores) : null;
      const promedio = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
      const cadenasMin = minimo == null ? [] : [...new Set(competidores.filter(x => Math.abs(x.priceUsd - minimo) < 0.0005).map(x => x.cadena))];

      const pvp = Number(p.pvp_propio_usd || 0) > 0 ? Number(p.pvp_propio_usd) / factorPropio : null;
      const tuPrecio = propios.length ? Math.min(...propios.map(x => x.priceUsd)) : pvp;
      const fuenteTuPrecio = propios.length ? 'enlace' : pvp ? 'pvp' : null;
      const difMin = tuPrecio != null && minimo > 0 ? ((tuPrecio - minimo) / minimo) * 100 : null;
      const difProm = tuPrecio != null && promedio > 0 ? ((tuPrecio - promedio) / promedio) * 100 : null;

      // Precio de la competencia por cadena (el mas bajo si hay varios).
      const porCadena = new Map();
      for (const x of competidores) {
        const previo = porCadena.get(x.cadena);
        if (!previo || x.priceUsd < previo.priceUsd) porCadena.set(x.cadena, x);
      }

      return {
        producto: p,
        competencia,
        precios,
        porCadena,
        minimo,
        promedio,
        cadenasMin,
        tuPrecio,
        fuenteTuPrecio,
        difMin,
        difProm,
        cambios: precios.filter(x => Math.abs(x.cambio) > UMBRAL_CAMBIO),
        comparable: tuPrecio != null && minimo != null,
        sinPrecio: precios.length === 0 && tuPrecio == null,
      };
    });
  }, [productos, productosCompetencia, bcv.rate, modoPrecio, historicoPrecios, modoAnalisis, ventana, variaciones, idCadena]);

  // ------------------------------------------------------------------------
  // Filtros de todo el panel (indicadores, graficos y tabla)
  // ------------------------------------------------------------------------
  const claveUnidad = (p) => (p.unidad_negocio || 'La Sante').toLowerCase().replace(/\s/g, '');
  const unidades = useMemo(() => {
    const m = new Map();
    productos.forEach(p => m.set(claveUnidad(p), p.unidad_negocio || 'La Sante'));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [productos]);
  const categorias = useMemo(() => [...new Set(productos.map(p => p.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [productos]);

  const base = useMemo(() => analizados.filter(({ producto: p }) =>
    (filtroUnidad === 'todos' || claveUnidad(p) === filtroUnidad) &&
    (filtroTipo === 'todos' || (p.market_type || 'GENERICO').toLowerCase() === filtroTipo) &&
    (filtroCategoria === 'todos' || p.categoria === filtroCategoria)
  ), [analizados, filtroUnidad, filtroTipo, filtroCategoria]);

  const hayFiltros = filtroUnidad !== 'todos' || filtroTipo !== 'todos' || filtroCategoria !== 'todos';

  // ------------------------------------------------------------------------
  // Indicadores
  // ------------------------------------------------------------------------
  const kpi = useMemo(() => {
    const comparables = base.filter(x => x.comparable);
    const difs = comparables.map(x => x.difProm).filter(v => v != null);
    const cambios = base.flatMap(x => x.cambios.map(c => ({ item: x, cambio: c })))
      .sort((a, b) => Math.abs(b.cambio.cambio) - Math.abs(a.cambio.cambio));
    return {
      comparables,
      // Mediana y no media: un solo producto muy desfasado no mueve el numero.
      frentePromedio: mediana(difs),
      masBaratos: comparables.filter(x => x.difMin <= UMBRAL_EMPATE),
      masCaros: comparables.filter(x => x.difMin > UMBRAL_EMPATE).sort((a, b) => b.difMin - a.difMin),
      cambios,
      productosConCambios: new Set(cambios.map(c => c.item.producto.id_interno)).size,
      sinComparar: base.filter(x => !x.comparable),
    };
  }, [base]);

  const gruposSinColor = useMemo(() => GRUPOS.map(g => {
    const items = kpi.comparables.filter(x => x.difProm != null && grupoDe(x.difProm).id === g.id);
    return { ...g, total: items.length, items };
  }), [kpi.comparables]);
  // El color se lee en cada pintado para seguir el tema claro u oscuro.
  const grupos = gruposSinColor.map(g => ({ ...g, color: leerColor(g.token, g.respaldo) }));

  const lideres = useMemo(() => {
    const m = new Map();
    for (const x of base) {
      for (const c of x.cadenasMin) {
        if (!m.has(c)) m.set(c, []);
        m.get(c).push(x);
      }
    }
    return [...m.entries()]
      .map(([cadena, items]) => ({ cadena, nombre: nombreCadena(cadena), total: items.length, items, color: getChainColor(cadena) }))
      .sort((a, b) => b.total - a.total);
  }, [base, nombreCadena]);

  const bcvResumen = useMemo(() => {
    const orden = [...(bcvHistorico || [])].filter(r => r.valor > 0)
      .sort((a, b) => new Date(a.rawDate || 0) - new Date(b.rawDate || 0));
    const ultimo = bcv.rate || orden.at(-1)?.valor || null;
    const previo = orden.length >= 2 ? orden.at(-2).valor : null;
    const hace30 = new Date(Date.now() - 30 * 864e5);
    const mes = [...orden].reverse().find(r => r.rawDate && new Date(r.rawDate) <= hace30) || orden[0];
    return {
      ultimo,
      diario: previo && ultimo ? ((ultimo - previo) / previo) * 100 : null,
      mensual: mes?.valor && ultimo ? ((ultimo - mes.valor) / mes.valor) * 100 : null,
      serie: orden.slice(-30).map(r => ({ v: r.valor })),
    };
  }, [bcvHistorico, bcv.rate]);

  const ultimaLectura = useMemo(() => {
    let max = null;
    for (const e of productosCompetencia) {
      if (e.ultimo_scrape && (!max || e.ultimo_scrape > max)) max = e.ultimo_scrape;
    }
    return max;
  }, [productosCompetencia]);

  // ------------------------------------------------------------------------
  // Tabla
  // ------------------------------------------------------------------------
  const cadenasTabla = useMemo(() => {
    const ids = new Set();
    for (const x of base) for (const c of x.porCadena.keys()) ids.add(c);
    return [...ids].sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));
  }, [base, nombreCadena]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = base.filter(x => {
      if (term && !normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)) return false;
      if (mostrar === 'mas_caro') return x.comparable && x.difMin > UMBRAL_EMPATE;
      if (mostrar === 'mas_barato') return x.comparable && x.difMin <= UMBRAL_EMPATE;
      if (mostrar === 'cambios') return x.cambios.length > 0;
      if (mostrar === 'sin_comparar') return !x.comparable;
      return true;
    });
    const valor = {
      nombre: x => x.producto.nombre || '',
      tuPrecio: x => x.tuPrecio,
      minimo: x => x.minimo,
      promedio: x => x.promedio,
      difMin: x => x.difMin,
      difProm: x => x.difProm,
    }[orden.campo];
    const signo = orden.dir === 'asc' ? 1 : -1;
    return lista.sort((a, b) => {
      // Los productos sin ningun precio van siempre al final.
      if (a.sinPrecio !== b.sinPrecio) return a.sinPrecio ? 1 : -1;
      const va = valor(a);
      const vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb, 'es', { sensitivity: 'base' }) : va - vb) * signo;
    });
  }, [base, search, mostrar, orden]);

  useEffect(() => { setPaginaActual(1); }, [search, mostrar, filtroUnidad, filtroTipo, filtroCategoria, orden, itemsPorPagina]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);

  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));

  // ------------------------------------------------------------------------
  // Formatos
  // ------------------------------------------------------------------------
  const fmt = (usd) => {
    if (usd == null || isNaN(usd)) return '—';
    if (moneda === 'usd') return `$${usd.toFixed(2)}`;
    if (!bcv.rate) return '—';
    return `Bs ${(usd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const porUnidad = modoAnalisis === 'unidosis' ? ' por unidad' : '';

  // ------------------------------------------------------------------------
  // Detalle en modal
  // ------------------------------------------------------------------------
  const colProducto = {
    titulo: 'Producto',
    celda: x => (
      <div className="min-w-0">
        <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={x.producto.nombre}>{x.producto.nombre}</div>
        <div className="m3-cell-secondary font-mono">{x.producto.id_interno}</div>
      </div>
    ),
  };
  const colTuPrecio = { titulo: 'Tu precio', alinear: 'right', celda: x => fmt(x.tuPrecio) };
  const colMinimo = {
    titulo: 'Mínimo', alinear: 'right',
    celda: x => (
      <span className="inline-flex items-center gap-1.5">
        {x.cadenasMin[0] && <CadenaBadge cadena={x.cadenasMin[0]} tamano="xs" title={nombreCadena(x.cadenasMin[0])} />}
        {fmt(x.minimo)}
      </span>
    ),
  };
  const colPromedio = { titulo: 'Promedio', alinear: 'right', celda: x => fmt(x.promedio) };
  const colDifMin = { titulo: 'Frente al mínimo', alinear: 'right', celda: x => <Diferencia valor={x.difMin} /> };
  const colDifProm = { titulo: 'Frente al promedio', alinear: 'right', celda: x => <Diferencia valor={x.difProm} /> };

  const abrirDetalle = (d) => setDetalle(d);
  const abrirFicha = (item, desde = null) => {
    setVolverA(desde);
    setDetalle(null);
    setFicha({ producto: item.producto, competencia: item.competencia });
  };
  const cerrarFicha = () => {
    setFicha(null);
    if (volverA) { setDetalle(volverA); setVolverA(null); }
  };
  const verEnTabla = (valor) => {
    setDetalle(null);
    setSearch('');
    setMostrar(valor);
    setTimeout(() => tablaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const detalleFrentePromedio = () => abrirDetalle({
    titulo: 'Tu precio frente al promedio',
    subtitulo: 'Cada producto con precio tuyo y de la competencia, del más barato al más caro frente al promedio.',
    icono: 'balance',
    filas: [...kpi.comparables].sort((a, b) => a.difProm - b.difProm),
    columnas: [colProducto, colTuPrecio, colPromedio, colDifProm],
  });
  const detalleMasBaratos = () => abrirDetalle({
    titulo: 'Eres el más barato',
    subtitulo: 'Productos donde tu precio es igual o menor que el más bajo de la competencia.',
    icono: 'workspace_premium',
    filas: [...kpi.masBaratos].sort((a, b) => a.difMin - b.difMin),
    columnas: [colProducto, colTuPrecio, colMinimo, colDifMin],
    tabla: 'mas_barato',
    vacio: 'En ningún producto eres el más barato con estos filtros.',
  });
  const detalleMasCaros = () => abrirDetalle({
    titulo: 'Más caros que el mínimo',
    subtitulo: 'Productos donde otra cadena vende una alternativa más barata que tu precio. Primero los de mayor diferencia.',
    icono: 'trending_up',
    filas: kpi.masCaros,
    columnas: [colProducto, colTuPrecio, colMinimo, colDifMin],
    tabla: 'mas_caro',
    vacio: 'Ningún producto está por encima del mínimo de la competencia.',
  });
  const detalleCambios = () => abrirDetalle({
    titulo: 'Cambios de precio',
    subtitulo: `Precios que cambiaron en ${VENTANAS[ventana]}. Primero los mayores.`,
    icono: 'swap_vert',
    filas: kpi.cambios,
    clave: f => `${f.item.producto.id_interno}_${f.cambio.id}`,
    columnas: [
      { ...colProducto, celda: f => colProducto.celda(f.item) },
      {
        titulo: 'Cadena · marca',
        celda: f => (
          <div className="flex items-center gap-2 min-w-0">
            <CadenaBadge cadena={f.cambio.cadena} tamano="xs" title={nombreCadena(f.cambio.cadena)} />
            <span className="m3-cell-clamp max-w-[12rem]" title={f.cambio.marca}>{f.cambio.tipo === 'propio' ? 'Tu producto' : f.cambio.marca}</span>
          </div>
        ),
      },
      { titulo: 'Antes', alinear: 'right', celda: f => fmt(f.cambio.antesUsd) },
      { titulo: 'Ahora', alinear: 'right', celda: f => fmt(f.cambio.priceUsd) },
      { titulo: 'Cambio', alinear: 'right', celda: f => <Diferencia valor={f.cambio.cambio} /> },
    ],
    abrir: f => f.item,
    tabla: 'cambios',
    vacio: 'Ningún precio cambió en este periodo.',
  });
  const detalleSinComparar = () => abrirDetalle({
    titulo: 'Sin comparar',
    subtitulo: 'Productos a los que les falta tu precio o el de la competencia. Vincula enlaces en Competencia o carga el PVP en Productos.',
    icono: 'help',
    filas: kpi.sinComparar,
    columnas: [colProducto, {
      titulo: 'Qué falta',
      celda: x => (x.sinPrecio ? 'Ningún precio leído' : x.tuPrecio == null ? 'Tu precio' : 'Precio de la competencia'),
    }],
    tabla: 'sin_comparar',
    vacio: 'Todos los productos se pueden comparar.',
  });
  const detalleGrupo = (g) => abrirDetalle({
    titulo: `Tu precio: ${g.corto.toLowerCase()}`,
    subtitulo: 'Productos en este grupo, según la diferencia de tu precio con el promedio de la competencia.',
    icono: 'balance',
    filas: [...g.items].sort((a, b) => a.difProm - b.difProm),
    columnas: [colProducto, colTuPrecio, colPromedio, colDifProm],
  });
  const detalleCadena = (l) => abrirDetalle({
    titulo: `Más barato en ${l.nombre}`,
    subtitulo: `Productos donde ${l.nombre} tiene el precio más bajo de la competencia.`,
    icono: 'storefront',
    filas: [...l.items].sort((a, b) => (a.producto.nombre || '').localeCompare(b.producto.nombre || '')),
    columnas: [colProducto, colMinimo, colTuPrecio, colDifMin],
  });

  // ------------------------------------------------------------------------
  // Acciones
  // ------------------------------------------------------------------------
  const cerrarMenu = () => menuMasRef.current?.removeAttribute('open');

  const exportar = () => {
    const sufijoMoneda = moneda === 'usd' ? 'USD' : 'Bs';
    const valor = (usd) => (usd == null ? '' : moneda === 'usd' ? usd.toFixed(2) : (usd * (bcv.rate || 0)).toFixed(2));
    const cols = [
      { key: 'id', label: 'ID' },
      { key: 'producto', label: 'Producto' },
      { key: 'unidad', label: 'Unidad de negocio' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'categoria', label: 'Categoría' },
      { key: 'tu', label: `Tu precio (${sufijoMoneda})` },
      { key: 'min', label: `Mínimo competencia (${sufijoMoneda})` },
      { key: 'cadMin', label: 'Cadena del mínimo' },
      { key: 'prom', label: `Promedio competencia (${sufijoMoneda})` },
      { key: 'difMin', label: 'Frente al mínimo (%)' },
      { key: 'difProm', label: 'Frente al promedio (%)' },
      ...cadenasTabla.map(c => ({ key: `c_${c}`, label: `${nombreCadena(c)} (${sufijoMoneda})` })),
    ];
    const datos = filas.map(x => ({
      id: x.producto.id_interno,
      producto: x.producto.nombre,
      unidad: x.producto.unidad_negocio || '',
      tipo: (x.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico',
      categoria: x.producto.categoria || '',
      tu: valor(x.tuPrecio),
      min: valor(x.minimo),
      cadMin: x.cadenasMin.map(nombreCadena).join(' / '),
      prom: valor(x.promedio),
      difMin: x.difMin == null ? '' : x.difMin.toFixed(1),
      difProm: x.difProm == null ? '' : x.difProm.toFixed(1),
      ...Object.fromEntries(cadenasTabla.map(c => [`c_${c}`, valor(x.porCadena.get(c)?.priceUsd)])),
    }));
    if (datos.length === 0) { addToast('No hay productos para exportar con estos filtros.', 'info'); return; }
    exportToCSV(`dashboard_precios_por_cadena${modoAnalisis === 'unidosis' ? '_por_unidad' : ''}`, cols, datos);
  };

  const borrarHistorial = async () => {
    setBorrando(true);
    try {
      await dbClearAllHistoricoPrecios();
      vaciarHistorico?.();
      addToast('Historial de precios borrado.', 'success');
      await refreshData(true);
    } catch (err) {
      addToast(`No se pudo borrar el historial: ${err?.message || err}`, 'error');
    } finally {
      setBorrando(false);
      setConfirmBorrar(false);
    }
  };

  const tg = tokensGrafico();

  if (loading && productos.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(n => <div key={n} className="h-28 rounded-2xl m3-skeleton" />)}
        </div>
        <div className="h-72 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const totalBase = base.length;

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Encabezado */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">dashboard</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Dashboard</h1>
          </div>
          <p className="text-xs text-on-surface-variant">
            Cómo están tus precios frente a la competencia.{' '}
            <span title={ultimaLectura ? fechaHora(ultimaLectura) : ''}>
              Última lectura del robot: <strong className="font-medium text-on-surface">{ultimaLectura ? haceCuanto(ultimaLectura).toLowerCase().replace(/\.$/, '') : 'sin lecturas'}</strong>.
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 self-start lg:self-auto">
          <button onClick={exportar} className="m3-btn-outline" title="Descargar en CSV la tabla de precios por cadena, con los filtros actuales">
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar</span>
          </button>
          {isAdmin && (
            <details ref={menuMasRef} className="m3-menu">
              <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
                <span className="material-symbols-outlined">more_vert</span>
              </summary>
              <div className="m3-menu-panel" role="menu">
                <button type="button" role="menuitem" className="m3-menu-item" disabled={Boolean(robot.corrida)}
                  onClick={() => { cerrarMenu(); setConfirmRobot(true); }}>
                  <span className={`material-symbols-outlined ${robot.corrida ? 'animate-spin' : ''}`}>{robot.corrida ? 'sync' : 'smart_toy'}</span>
                  {robot.corrida ? 'Robot en curso…' : 'Leer todos los precios'}
                </button>
                <button type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger" disabled={borrando}
                  onClick={() => { cerrarMenu(); setConfirmBorrar(true); }}>
                  <span className="material-symbols-outlined">delete_sweep</span>
                  {borrando ? 'Borrando…' : 'Borrar historial de precios'}
                </button>
              </div>
            </details>
          )}
        </div>
      </div>

      <AvisoRobot robot={robot} />

      {/* Filtros y vista: una sola fila sobre los indicadores y graficos */}
      <section className="m3-dash-filtros" aria-label="Filtros del Dashboard">
        <div className="flex flex-wrap items-center gap-2">
          <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad}
            opciones={[['todos', 'Unidad: todas'], ...unidades]} />
          <FiltroChip etiqueta="Tipo" icono="category" valor={filtroTipo} onChange={setFiltroTipo}
            opciones={[['todos', 'Tipo: todos'], ['generico', 'Genéricos'], ['marca', 'Marca']]} />
          <FiltroChip etiqueta="Categoría" icono="sell" valor={filtroCategoria} onChange={setFiltroCategoria}
            opciones={[['todos', 'Categoría: todas'], ...categorias.map(c => [c, c])]} />
          {hayFiltros && (
            <button type="button" className="m3-btn-text"
              onClick={() => { setFiltroUnidad('todos'); setFiltroTipo('todos'); setFiltroCategoria('todos'); }}>
              Limpiar filtros
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <AjusteChip etiqueta="Precio que se compara" icono="receipt_long" valor={modoPrecio} onChange={setModoPrecio}
            opciones={[['lista', 'Precio de lista'], ['descuento', 'Precio con oferta']]} />
          <AjusteChip etiqueta="Comparar por" icono="medication" valor={modoAnalisis} onChange={setModoAnalisis}
            opciones={[['empaque', 'Por empaque'], ['unidosis', 'Por unidad (tableta, cápsula…)']]} />
          <AjusteChip etiqueta="Periodo de los cambios" icono="history" valor={String(ventana)} onChange={v => setVentana(Number(v))}
            opciones={[['1', 'Cambios: 24 horas'], ['7', 'Cambios: 7 días'], ['15', 'Cambios: 15 días']]} />
          <label className="m3-switch-label whitespace-nowrap ml-1" title="Moneda de todo el Dashboard">
            <span className={moneda === 'bs' ? 'text-on-surface-variant' : 'font-medium'}>$</span>
            <input type="checkbox" role="switch" checked={moneda === 'bs'} onChange={e => setMoneda(e.target.checked ? 'bs' : 'usd')}
              className="m3-switch" aria-label="Ver los precios en bolívares" />
            <span className={moneda === 'bs' ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
          </label>
        </div>
      </section>

      {/* Indicadores */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Indicadores">
        <StatCard
          label="Frente al promedio"
          value={pct(kpi.frentePromedio)}
          hint={kpi.frentePromedio == null ? 'Sin productos para comparar' : kpi.frentePromedio < -UMBRAL_EMPATE ? 'Lo usual: tu precio más bajo que el promedio' : kpi.frentePromedio > UMBRAL_EMPATE ? 'Lo usual: tu precio más alto que el promedio' : 'Lo usual: tu precio en el promedio'}
          icon="balance"
          tono={kpi.frentePromedio == null ? 'neutral' : kpi.frentePromedio > 5 ? 'negative' : kpi.frentePromedio < -UMBRAL_EMPATE ? 'primary' : 'neutral'}
          onClick={detalleFrentePromedio}
          title="La diferencia típica (mediana) de tu precio con el promedio de la competencia. Toca para ver cada producto."
        />
        <StatCard
          label="Eres el más barato"
          value={`${kpi.masBaratos.length} de ${kpi.comparables.length}`}
          hint={kpi.comparables.length ? `${Math.round((kpi.masBaratos.length / kpi.comparables.length) * 100)} % de los productos que se pueden comparar` : 'Sin productos para comparar'}
          icon="workspace_premium"
          tono="primary"
          onClick={detalleMasBaratos}
          title="Ver los productos donde eres el más barato"
        />
        <StatCard
          label="Más caros que el mínimo"
          value={kpi.masCaros.length}
          hint="Otra cadena vende una alternativa más barata"
          icon="trending_up"
          tono={kpi.masCaros.length ? 'negative' : 'neutral'}
          onClick={detalleMasCaros}
          title="Ver los productos donde la competencia es más barata"
        />
        <StatCard
          label="Cambios de precio"
          value={kpi.cambios.length}
          hint={`En ${kpi.productosConCambios} ${kpi.productosConCambios === 1 ? 'producto' : 'productos'} · ${VENTANAS[ventana]}`}
          icon="swap_vert"
          tono={kpi.cambios.length ? 'warning' : 'neutral'}
          onClick={detalleCambios}
          title="Ver qué precios cambiaron"
        />
        <StatCard
          label="Sin comparar"
          value={kpi.sinComparar.length}
          hint={`De ${totalBase} productos activos: falta tu precio o el de la competencia`}
          icon="help"
          tono={kpi.sinComparar.length ? 'warning' : 'neutral'}
          onClick={detalleSinComparar}
          title="Ver qué productos no se pueden comparar y por qué"
        />
        <TarjetaBcv resumen={bcvResumen} bcv={bcv} color={tg.eje} onClick={() => setShowBcvModal(true)} />
      </section>

      {/* Graficos */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4" aria-label="Gráficos">
        <div className="m3-dash-card">
          <header className="m3-dash-card-header">
            <div>
              <h2 className="m3-title-medium text-on-surface">¿Dónde está tu precio?</h2>
              <p className="m3-body-small text-on-surface-variant">Productos según la diferencia de tu precio con el promedio de la competencia. Toca una barra para ver cuáles son.</p>
            </div>
          </header>
          {kpi.comparables.length === 0 ? (
            <SinDatos texto="Aún no hay productos con tu precio y el de la competencia." />
          ) : (
            <>
              <div className="h-60" role="img" aria-label="Productos por grupo de diferencia con el promedio">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={grupos} margin={{ top: 24, right: 8, left: 8, bottom: 0 }} barCategoryGap="18%">
                    <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                    <XAxis dataKey="eje" tick={<TickDosLineas color={tg.eje} />} tickLine={false} axisLine={{ stroke: tg.rejilla }} interval={0} height={36} />
                    <YAxis hide allowDecimals={false} />
                    <Tooltip cursor={{ fill: tg.rejilla, fillOpacity: 0.25 }} content={<TooltipGrupo />} />
                    <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={64} cursor="pointer" onClick={(d) => detalleGrupo(d.payload || d)}>
                      {grupos.map(g => <Cell key={g.id} fill={g.color} />)}
                      <LabelList dataKey="total" position="top" fill={tg.texto} fontSize={12} fontWeight={600} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="m3-dash-leyenda" aria-hidden="true">
                <span><i style={{ background: grupos[0].color }} />Más barato</span>
                <span><i style={{ background: grupos[2].color }} />Parejo</span>
                <span><i style={{ background: grupos[4].color }} />Más caro</span>
              </div>
            </>
          )}
        </div>

        <div className="m3-dash-card">
          <header className="m3-dash-card-header">
            <div>
              <h2 className="m3-title-medium text-on-surface">¿Qué cadena tiene el precio más bajo?</h2>
              <p className="m3-body-small text-on-surface-variant">En cuántos productos cada cadena tiene el precio más bajo de la competencia. Toca una barra para ver cuáles.</p>
            </div>
          </header>
          {lideres.length === 0 ? (
            <SinDatos texto="Aún no hay precios de la competencia." />
          ) : (
            <div style={{ height: Math.max(160, lideres.length * 40 + 24) }} role="img" aria-label="Productos donde cada cadena es la más barata">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={lideres} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 4 }} barCategoryGap="28%">
                  <CartesianGrid horizontal={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                  <XAxis type="number" hide allowDecimals={false} />
                  <YAxis type="category" dataKey="nombre" width={130} tick={{ fill: tg.eje, fontSize: 12 }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: tg.rejilla, fillOpacity: 0.25 }} content={<TooltipCadena />} />
                  <Bar dataKey="total" radius={[0, 4, 4, 0]} maxBarSize={22} cursor="pointer" onClick={(d) => detalleCadena(d.payload || d)}>
                    {lideres.map(l => <Cell key={l.cadena} fill={l.color} />)}
                    <LabelList dataKey="total" position="right" fill={tg.texto} fontSize={12} fontWeight={600} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* Tabla */}
      <section ref={tablaRef} className="m3-data-table scroll-mt-4" aria-label="Precios por cadena">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div>
                <h2 className="m3-title-medium text-on-surface">Precios por cadena</h2>
                <p className="m3-body-small text-on-surface-variant">El precio más bajo de la competencia en cada cadena{porUnidad}. Resaltado, el mínimo. Toca una fila para ver la ficha.</p>
              </div>
              <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
                {filas.length === totalBase ? `${totalBase} productos` : `${filas.length} de ${totalBase} productos`}
              </div>
            </div>
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <label className="m3-search-field">
                <span className="material-symbols-outlined" aria-hidden="true">search</span>
                <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por ID, nombre o molécula" aria-label="Buscar producto" />
                {search && (
                  <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <FiltroChip etiqueta="Mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
                  opciones={[
                    ['todos', 'Mostrar: todos'],
                    ['mas_caro', 'Más caros que el mínimo'],
                    ['mas_barato', 'Eres el más barato'],
                    ['cambios', 'Con cambios de precio'],
                    ['sin_comparar', 'Sin comparar'],
                  ]} />
                {(mostrar !== 'todos' || search) && (
                  <button type="button" onClick={() => { setMostrar('todos'); setSearch(''); }} className="m3-btn-text">Limpiar</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {filas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">search_off</span>
            <div className="m3-title-medium text-on-surface">Ningún producto coincide</div>
            <div className="m3-body-medium">Prueba con otros filtros o con otra búsqueda.</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Productos">
              {filasPagina.map(x => (
                <li key={x.producto.id_interno}>
                  <button type="button" onClick={() => abrirFicha(x)} className="w-full text-left px-4 py-3 space-y-1">
                    <div className="m3-cell-primary">{x.producto.nombre}</div>
                    <div className="m3-cell-secondary font-mono">{x.producto.id_interno}</div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 m3-body-small">
                      <span>Tu precio <strong className="font-medium">{fmt(x.tuPrecio)}</strong></span>
                      <span className="inline-flex items-center gap-1">Mínimo {x.cadenasMin[0] && <CadenaBadge cadena={x.cadenasMin[0]} tamano="xs" />}<strong className="font-medium">{fmt(x.minimo)}</strong></span>
                      <Diferencia valor={x.difMin} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-x-auto">
              <table className="m3-table m3-table-dashboard">
                <thead className="m3-sticky-header">
                  <tr>
                    <th className="m3-dash-col-producto"><BotonOrden campo="nombre" orden={orden} onClick={ordenarPor}>Producto</BotonOrden></th>
                    {cadenasTabla.map(c => (
                      <th key={c} className="text-right">
                        <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={c} tamano="xs" title="" />{nombreCadena(c)}</span>
                      </th>
                    ))}
                    <th className="text-right m3-dash-col-sep"><BotonOrden campo="minimo" orden={orden} onClick={ordenarPor}>Mínimo</BotonOrden></th>
                    <th className="text-right"><BotonOrden campo="promedio" orden={orden} onClick={ordenarPor}>Promedio</BotonOrden></th>
                    <th className="text-right m3-dash-col-sep"><BotonOrden campo="tuPrecio" orden={orden} onClick={ordenarPor}>Tu precio</BotonOrden></th>
                    <th className="text-right"><BotonOrden campo="difMin" orden={orden} onClick={ordenarPor}>Frente al mínimo</BotonOrden></th>
                    <th className="text-right"><BotonOrden campo="difProm" orden={orden} onClick={ordenarPor}>Frente al promedio</BotonOrden></th>
                  </tr>
                </thead>
                <tbody>
                  {filasPagina.map(x => {
                    const cambioPropio = x.precios.find(p => p.tipo === 'propio' && Math.abs(p.cambio) > UMBRAL_CAMBIO);
                    return (
                      <tr key={x.producto.id_interno} onClick={() => abrirFicha(x)} className="cursor-pointer"
                        tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') abrirFicha(x); }}>
                        <td className="m3-dash-col-producto">
                          <div className="m3-cell-primary m3-cell-clamp" title={x.producto.nombre}>{x.producto.nombre}</div>
                          <div className="m3-cell-secondary">
                            <span className="font-mono">{x.producto.id_interno}</span>
                            {' · '}{(x.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico'}
                          </div>
                        </td>
                        {cadenasTabla.map(c => {
                          const p = x.porCadena.get(c);
                          if (!p) return <td key={c} className="text-right text-on-surface-variant">—</td>;
                          const esMin = x.cadenasMin.includes(c);
                          return (
                            <td key={c} className={`text-right whitespace-nowrap ${esMin ? 'm3-dash-min' : ''}`} title={`${p.marca} en ${nombreCadena(c)}${esMin ? ' · el más barato' : ''}`}>
                              <div className="tabular-nums">{fmt(p.priceUsd)}</div>
                              {Math.abs(p.cambio) > UMBRAL_CAMBIO && <div className="m3-dash-cambio"><Diferencia valor={p.cambio} /></div>}
                            </td>
                          );
                        })}
                        <td className="text-right whitespace-nowrap tabular-nums m3-dash-col-sep">{fmt(x.minimo)}</td>
                        <td className="text-right whitespace-nowrap tabular-nums">{fmt(x.promedio)}</td>
                        <td className="text-right whitespace-nowrap tabular-nums m3-dash-col-sep font-medium"
                          title={x.fuenteTuPrecio === 'pvp' ? 'PVP cargado en Productos (sin enlace propio leído)' : undefined}>
                          {fmt(x.tuPrecio)}{x.fuenteTuPrecio === 'pvp' && <span className="text-on-surface-variant font-normal"> · PVP</span>}
                          {cambioPropio && <div className="m3-dash-cambio"><Diferencia valor={cambioPropio.cambio} /></div>}
                        </td>
                        <td className="text-right whitespace-nowrap"><Diferencia valor={x.difMin} /></td>
                        <td className="text-right whitespace-nowrap"><Diferencia valor={x.difProm} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <footer className="m3-data-table-footer">
              <label className="flex items-center gap-2 m3-body-medium text-on-surface-variant">
                Filas por página
                <Select value={itemsPorPagina} onChange={e => setItemsPorPagina(Number(e.target.value))} className="m3-rows-select">
                  {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                </Select>
              </label>
              <span className="m3-body-medium text-on-surface-variant sm:ml-auto">
                {Math.min(filas.length, (paginaActual - 1) * itemsPorPagina + 1)}–{Math.min(filas.length, paginaActual * itemsPorPagina)} de {filas.length}
              </span>
              {totalPaginas > 1 && (
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setPaginaActual(p => Math.max(1, p - 1))} disabled={paginaActual === 1} className="m3-icon-btn" aria-label="Página anterior">
                    <span className="material-symbols-outlined">chevron_left</span>
                  </button>
                  <span className="m3-label-large px-2">Página {paginaActual} de {totalPaginas}</span>
                  <button type="button" onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))} disabled={paginaActual === totalPaginas} className="m3-icon-btn" aria-label="Página siguiente">
                    <span className="material-symbols-outlined">chevron_right</span>
                  </button>
                </div>
              )}
            </footer>
          </>
        )}
      </section>

      {detalle && (
        <DetalleLista
          titulo={detalle.titulo}
          subtitulo={detalle.subtitulo}
          icono={detalle.icono}
          filas={detalle.filas}
          columnas={detalle.columnas}
          claveFila={detalle.clave || (x => x.producto.id_interno)}
          onFila={f => abrirFicha(detalle.abrir ? detalle.abrir(f) : f, detalle)}
          vacio={detalle.vacio}
          onVerEnTabla={detalle.tabla ? () => verEnTabla(detalle.tabla) : null}
          onClose={() => setDetalle(null)}
        />
      )}

      {ficha && (
        <ProductDetailModal
          producto={ficha.producto}
          competencia={ficha.competencia}
          currency={moneda}
          bcvRate={bcv.rate}
          initialPriceMode={modoPrecio}
          initialAnalisisMode={modoAnalisis}
          onClose={cerrarFicha}
        />
      )}

      <BcvDetailModal isOpen={showBcvModal} onClose={() => setShowBcvModal(false)} rates={bcvHistorico} currentRate={bcv.rate} bcv={bcv} />

      <ConfirmModal
        isOpen={confirmRobot}
        title="¿Leer todos los precios ahora?"
        message={`El robot leerá los ${enlacesActivos.length} enlaces activos. Tarda unos ${estimarMinutos(enlacesActivos)} minutos (GitHub necesita unos 4 para arrancar). Puedes seguir usando el panel.\n\nEl robot ya corre solo todos los días a las 4:00 a. m.`}
        confirmText="Leer precios"
        cancelText="Cancelar"
        onConfirm={() => { setConfirmRobot(false); robot.lanzar(null, enlacesActivos); }}
        onCancel={() => setConfirmRobot(false)}
      />

      <ConfirmModal
        isOpen={confirmBorrar}
        title="¿Borrar el historial de precios?"
        message="Se borran todas las capturas guardadas: las variaciones y los gráficos de historia quedan vacíos hasta la próxima lectura del robot. Los productos, enlaces y cadenas no se tocan. No se puede deshacer."
        confirmText={borrando ? 'Borrando…' : 'Borrar historial'}
        cancelText="Cancelar"
        isDanger
        onConfirm={borrarHistorial}
        onCancel={() => setConfirmBorrar(false)}
      />

      <GitHubConfigModal isOpen={showGithubModal} onClose={() => setShowGithubModal(false)} />
    </div>
  );
}

// Ajuste de vista con el mismo aspecto que los filtros, pero sin "activo":
// siempre tiene un valor elegido.
function AjusteChip({ etiqueta, icono, valor, onChange, opciones }) {
  return (
    <Select value={valor} onChange={e => onChange(e.target.value)} aria-label={etiqueta} title={etiqueta}
      className="m3-filter-chip" leadingIcon={icono}>
      {opciones.map(([v, texto]) => <option key={v} value={v}>{texto}</option>)}
    </Select>
  );
}

function BotonOrden({ campo, orden, onClick, children }) {
  const activo = orden.campo === campo;
  return (
    <button type="button" onClick={() => onClick(campo)} className={`m3-sort-btn ${activo ? 'is-active' : ''}`}
      aria-sort={activo ? (orden.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {children}
      <span className="material-symbols-outlined" aria-hidden="true">
        {activo ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
      </span>
    </button>
  );
}

// Etiqueta del eje en dos lineas ("−15 %|o más"): caben en el ancho de un movil.
function TickDosLineas({ x, y, payload, color }) {
  const lineas = String(payload.value).split('|');
  return (
    <text x={x} y={y + 12} textAnchor="middle" fill={color} fontSize={11}>
      {lineas.map((l, i) => <tspan key={i} x={x} dy={i ? 13 : 0}>{l}</tspan>)}
    </text>
  );
}

function SinDatos({ texto }) {
  return (
    <div className="h-48 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
      <span className="material-symbols-outlined text-3xl" aria-hidden="true">bar_chart</span>
      <span className="m3-body-medium">{texto}</span>
    </div>
  );
}

function TooltipGrupo({ active, payload }) {
  if (!active || !payload?.length) return null;
  const g = payload[0].payload;
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium">{g.corto} que el promedio</div>
      <div>{g.total} {g.total === 1 ? 'producto' : 'productos'}</div>
    </div>
  );
}

function TooltipCadena({ active, payload }) {
  if (!active || !payload?.length) return null;
  const l = payload[0].payload;
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium">{l.nombre}</div>
      <div>El más barato en {l.total} {l.total === 1 ? 'producto' : 'productos'}</div>
    </div>
  );
}

// Tasa BCV: pequena, con su tendencia de 30 dias. El detalle (y el cambio
// manual de la tasa) esta en su modal.
function TarjetaBcv({ resumen, bcv, color, onClick }) {
  const valor = resumen.ultimo
    ? `Bs ${resumen.ultimo.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : (bcv.loading ? '…' : 'Sin tasa');
  const partes = [];
  if (resumen.diario != null) partes.push(`${pct(resumen.diario, 2)} desde el día anterior`);
  if (resumen.mensual != null) partes.push(`${pct(resumen.mensual)} en 30 días`);
  return (
    <button type="button" onClick={onClick} className="m3-stat cursor-pointer m3-interactive text-left w-full" title="Ver la historia de la tasa BCV o cambiarla a mano">
      <div className="m3-stat-body">
        <div className="m3-stat-label">Tasa BCV (por dólar)</div>
        <div className="m3-stat-value">{valor}</div>
        <div className="m3-stat-hint" title={partes.join(' · ')}>{partes.join(' · ') || 'Toca para ver la historia'}</div>
      </div>
      {resumen.serie.length > 1 && (
        <div className="w-24 h-12 shrink-0" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={resumen.serie} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </button>
  );
}
