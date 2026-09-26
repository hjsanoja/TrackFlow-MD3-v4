import LimpiarFiltros from '../components/LimpiarFiltros';
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
import { dbClearAllHistoricoPrecios } from '../utils/dbClient';
import { exportToCSV } from '../utils/exportUtils';
import { fechaHora, haceCuanto } from '../utils/usuarios';
import { normalizar } from '../components/formulario';
import TendenciaPosicion, { diaLargo } from '../components/dashboard/TendenciaPosicion';
import InfoGrafico from '../components/InfoGrafico';
import { describirPresentacion } from '../utils/presentacion';
import {
  UMBRAL_CAMBIO, UMBRAL_EMPATE, VENTANAS, METAS, textoMeta, usePreferencia, leerColor, mediana, pct,
  crearFormato, Diferencia, calcularAjuste, AjusteMeta, GRUPOS, grupoDe,
} from '../components/dashboard/comun';
import { useCambiosDesdeVisita } from '../hooks/useCambiosDesdeVisita';
import { useAnalisisPrecios } from '../hooks/useAnalisisPrecios';
import { supabase } from '../supabase';


export default function Dashboard({ userDoc }) {
  const {
    productos = [],
    productosCompetencia = [],
    cadenas = [],
    bcvRates: bcvHistorico = [],
    variaciones = [],
    ultimaCorrida,
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
  // Meta: promedio del mercado ± X %. Dice cuanto subir o bajar.
  const [meta, setMeta] = usePreferencia('dashboard.meta', 0, METAS.map(([v]) => v));

  // Filtros de todo el panel
  const [filtroUnidad, setFiltroUnidad] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroCategoria, setFiltroCategoria] = useState('todos');
  // Comparar solo contra una cadena ('todos' = todas).
  const [cadenaComp, setCadenaComp] = useState('todos');
  const [tipoComp, setTipoComp] = useState('todos'); // todos | GENERICO | MARCA

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

  const { analizados, idCadena, nombreCadena } = useAnalisisPrecios({
    productos, productosCompetencia, cadenas, variaciones, tasa: bcv.rate, modoPrecio, modoAnalisis, ventana, cadenaComp, tipoComp,
  });

  const ajusteDe = useCallback((x) => calcularAjuste(x.tuPrecio, x.promedio, meta, x.precios.filter(o => o.tipo !== 'propio').length), [meta]);

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

  const hayFiltros = filtroUnidad !== 'todos' || filtroTipo !== 'todos' || filtroCategoria !== 'todos' || cadenaComp !== 'todos' || tipoComp !== 'todos';

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
      deben: comparables.map(ajusteDe).filter(a => a?.estado === 'bajar').length,
      pueden: comparables.map(ajusteDe).filter(a => a?.estado === 'subir').length,
    };
  }, [base, ajusteDe]);

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

  // Cadenas con precios de la competencia, para "Comparar contra".
  const cadenasComparables = useMemo(() => {
    const ids = new Set();
    for (const e of productosCompetencia) {
      if (e.activo && String(e.tipo).toLowerCase() !== 'propio' && e.ultimo_precio_full_bs) ids.add(idCadena(e.cadena));
    }
    return [...ids].sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));
  }, [productosCompetencia, idCadena, nombreCadena]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = base.filter(x => {
      if (term && !normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)) return false;
      if (mostrar === 'mas_caro') return x.comparable && x.difMin > UMBRAL_EMPATE;
      if (mostrar === 'mas_barato') return x.comparable && x.difMin <= UMBRAL_EMPATE;
      if (mostrar === 'cambios') return x.cambios.length > 0;
      if (mostrar === 'sin_comparar') return !x.comparable;
      if (mostrar === 'con_precio') return !x.sinPrecio;
      if (mostrar === 'bajar') return ajusteDe(x)?.estado === 'bajar';
      if (mostrar === 'subir') return ajusteDe(x)?.estado === 'subir';
      return true;
    });
    const valor = {
      nombre: x => x.producto.nombre || '',
      tuPrecio: x => x.tuPrecio,
      minimo: x => x.minimo,
      promedio: x => x.promedio,
      difMin: x => x.difMin,
      difProm: x => x.difProm,
      posicion: x => (x.posicion ? x.posicion.lugar / x.posicion.de : null),
      ajuste: x => ajusteDe(x)?.porcentaje,
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
  }, [base, search, mostrar, orden, ajusteDe]);

  useEffect(() => { setPaginaActual(1); }, [search, mostrar, filtroUnidad, filtroTipo, filtroCategoria, orden, itemsPorPagina]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);

  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));

  // ------------------------------------------------------------------------
  // Formatos
  // ------------------------------------------------------------------------
  // Por unidad los precios son pequenos ($0.060): llevan un decimal mas.
  const { fmt: fmtEmpaque, fmtUnidad } = crearFormato(moneda, bcv.rate);
  const fmt = modoAnalisis === 'unidosis' ? fmtUnidad : fmtEmpaque;
  const porUnidad = modoAnalisis === 'unidosis' ? ' por unidad' : '';

  // ------------------------------------------------------------------------
  // Detalle en modal
  // ------------------------------------------------------------------------
  const colProducto = {
    titulo: 'Producto',
    celda: x => (
      <div className="min-w-0">
        <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={x.producto.nombre}>{x.producto.nombre}</div>
        <div className="m3-cell-secondary">{subtituloProducto(x.producto)}</div>
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
  const colDifMin = { titulo: 'Tú frente al mínimo', alinear: 'right', celda: x => <Diferencia valor={x.difMin} /> };
  const colDifProm = { titulo: 'Tú frente al promedio', alinear: 'right', celda: x => <Diferencia valor={x.difProm} /> };
  const colAjuste = { titulo: 'Para la meta', alinear: 'right', celda: x => <AjusteMeta ajuste={ajusteDe(x)} fmt={fmt} /> };

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

  // Cruces genérico/marca: tu genérico cuesta más que una marca de la
  // competencia, o tu marca cuesta menos que un genérico.
  const cruces = useMemo(() => base.filter(x => x.cruce), [base]);
  const detalleCruces = () => abrirDetalle({
    titulo: 'Cruces genérico / marca',
    subtitulo: 'Tus genéricos que cuestan más que una marca de la competencia, y tus marcas que cuestan menos que un genérico. Mismo producto y mismo empaque (o por unidad).',
    icono: 'swap_vert',
    filas: [...cruces].sort((a, b) => Math.abs(b.cruce.dif) - Math.abs(a.cruce.dif)),
    columnas: [
      colProducto,
      colTuPrecio,
      { titulo: 'Frente a', celda: x => (
        <span className="inline-flex items-center gap-1.5">
          <CadenaBadge cadena={x.cruce.ref.cadena} tamano="xs" title={nombreCadena(x.cruce.ref.cadena)} />
          <span>{x.cruce.ref.marca} <span className="text-on-surface-variant">({x.cruce.tipo === 'generico_caro' ? 'marca' : 'genérico'})</span></span>
        </span>
      ) },
      { titulo: 'Su precio', alinear: 'right', celda: x => fmt(x.cruce.ref.priceUsd) },
      { titulo: 'Tu diferencia', alinear: 'right', celda: x => <Diferencia valor={x.cruce.dif} /> },
    ],
    vacio: 'No hay cruces con estos filtros.',
  });

  const detalleFrentePromedio = () => abrirDetalle({
    titulo: 'Tu precio frente al promedio',
    subtitulo: `Cada producto con tu precio y el de la competencia. "Para la meta" dice cuánto subir o bajar para quedar en ${textoMeta(meta)}. Primero los que más deben bajar.`,
    icono: 'balance',
    filas: [...kpi.comparables].sort((a, b) => (ajusteDe(a)?.porcentaje ?? 0) - (ajusteDe(b)?.porcentaje ?? 0)),
    columnas: [colProducto, colTuPrecio, colPromedio, colDifProm, colAjuste],
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
    subtitulo: 'Productos en este grupo, según la diferencia de tu precio con el promedio del mercado.',
    icono: 'balance',
    filas: [...g.items].sort((a, b) => a.difProm - b.difProm),
    columnas: [colProducto, colTuPrecio, colPromedio, colDifProm, colAjuste],
  });

  // Un dia de la tendencia: la posicion de cada producto ese dia (fase 28).
  const productosFiltrados = hayFiltros ? base.map(x => x.producto.id_interno) : null;
  const detalleDia = async (fecha) => {
    const { data, error } = await supabase.rpc('fn_posicion_productos', {
      p_desde: fecha, p_hasta: fecha,
      p_con_descuento: modoPrecio === 'descuento',
      p_por_unidad: modoAnalisis === 'unidosis',
      p_cadena: cadenaComp === 'todos' ? null : cadenaComp,
      p_productos: productosFiltrados,
      // Solo si se filtra: asi funciona aunque falte la fase 30.
      ...(tipoComp !== 'todos' ? { p_tipo_mercado: tipoComp } : {}),
    });
    if (error) { addToast(`No se pudo leer ese día: ${error.message}`, 'error'); return; }
    const porId = new Map(base.map(x => [String(x.producto.id_interno), x]));
    const filasDia = (data || [])
      .filter(f => f.dif_promedio != null && porId.has(String(f.id_interno)))
      .map(f => ({ ...f, item: porId.get(String(f.id_interno)) }))
      .sort((a, b) => Number(a.dif_promedio) - Number(b.dif_promedio));
    abrirDetalle({
      titulo: `Tu posición el ${diaLargo(fecha)}`,
      subtitulo: 'Tu precio y el promedio del mercado (la competencia y tú) ese día, con el último precio leído de cada enlace, en dólares a la tasa de ese día.',
      icono: 'show_chart',
      filas: filasDia,
      clave: f => String(f.id_interno),
      abrir: f => f.item,
      vacio: 'Ese día no hay productos con tu precio y el de la competencia.',
      columnas: [
        { ...colProducto, celda: f => colProducto.celda(f.item) },
        { titulo: 'Tu precio', alinear: 'right', celda: f => fmt(Number(f.tu_precio_usd)) },
        { titulo: 'Promedio', alinear: 'right', celda: f => fmt(Number(f.promedio_usd)) },
        { titulo: 'Tú frente al promedio', alinear: 'right', celda: f => <Diferencia valor={Number(f.dif_promedio)} /> },
      ],
    });
  };

  // Cambios desde tu ultima visita (fase 28).
  const cambiosVisita = useCambiosDesdeVisita(userDoc?.email);
  const cambiosDesdeVisita = useMemo(() => {
    const porPub = new Map();
    for (const e of productosCompetencia) {
      if (e.publicacion_id == null || !e.activo) continue;
      if (!porPub.has(e.publicacion_id)) porPub.set(e.publicacion_id, []);
      porPub.get(e.publicacion_id).push(e);
    }
    const porId = new Map(base.map(x => [String(x.producto.id_interno).trim(), x]));
    const conDescuento = modoPrecio === 'descuento';
    const lista = [];
    for (const f of cambiosVisita.filas) {
      const antesBs = conDescuento ? (f.antes_desc_bs ?? f.antes_full_bs) : f.antes_full_bs;
      const ahoraBs = conDescuento ? (f.ahora_desc_bs ?? f.ahora_full_bs) : f.ahora_full_bs;
      if (!(antesBs > 0) || !(ahoraBs > 0) || !(f.antes_tasa > 0) || !(f.ahora_tasa > 0)) continue;
      const antesUsd = antesBs / f.antes_tasa;
      const ahoraUsd = ahoraBs / f.ahora_tasa;
      const cambio = (ahoraUsd / antesUsd - 1) * 100;
      if (Math.abs(cambio) <= UMBRAL_CAMBIO) continue;
      for (const e of porPub.get(f.publicacion_id) || []) {
        const item = porId.get(String(e.id_producto_propio).trim());
        if (!item) continue;
        lista.push({ clave: `${f.publicacion_id}_${e.id}`, item, enlace: e, cadena: idCadena(e.cadena), antesUsd, ahoraUsd, cambio });
      }
    }
    return lista.sort((a, b) => Math.abs(b.cambio) - Math.abs(a.cambio));
  }, [cambiosVisita.filas, productosCompetencia, base, modoPrecio, idCadena]);

  const detalleVisita = () => abrirDetalle({
    titulo: 'Desde tu última visita',
    subtitulo: `Precios que cambiaron desde ${fechaHora(cambiosVisita.desde)}, en dólares (a la tasa de cada día). Primero los mayores.`,
    icono: 'history',
    filas: cambiosDesdeVisita,
    clave: f => f.clave,
    abrir: f => f.item,
    columnas: [
      { ...colProducto, celda: f => colProducto.celda(f.item) },
      {
        titulo: 'Cadena · marca',
        celda: f => (
          <div className="flex items-center gap-2 min-w-0">
            <CadenaBadge cadena={f.cadena} tamano="xs" title={nombreCadena(f.cadena)} />
            <span className="m3-cell-clamp max-w-[12rem]" title={f.enlace.marca}>{String(f.enlace.tipo).toLowerCase() === 'propio' ? 'Tu producto' : f.enlace.marca}</span>
          </div>
        ),
      },
      { titulo: 'Antes', alinear: 'right', celda: f => fmt(f.antesUsd) },
      { titulo: 'Ahora', alinear: 'right', celda: f => fmt(f.ahoraUsd) },
      { titulo: 'Cambio', alinear: 'right', celda: f => <Diferencia valor={f.cambio} /> },
    ],
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
      { key: 'prom', label: `Promedio del mercado, con tu precio (${sufijoMoneda})` },
      { key: 'difMin', label: 'Tú frente al mínimo (%)' },
      { key: 'posicion', label: 'Posición (1 = el más barato)' },
      { key: 'difProm', label: 'Tú frente al promedio (%)' },
      { key: 'meta', label: `Precio meta: ${textoMeta(meta)} (${sufijoMoneda})` },
      { key: 'ajuste', label: 'Para la meta (%)' },
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
      posicion: x.posicion ? `${x.posicion.lugar} de ${x.posicion.de}` : '',
      difProm: x.difProm == null ? '' : x.difProm.toFixed(1),
      meta: valor(ajusteDe(x)?.objetivo),
      ajuste: ajusteDe(x) ? ajusteDe(x).porcentaje.toFixed(1) : '',
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
            <LecturaRobot corrida={ultimaCorrida} ultimaLectura={ultimaLectura} />
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

      {cambiosVisita.listo && cambiosVisita.desde && (
        <div className="m3-banner m3-banner-info" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">history</span>
          <span className="m3-body-medium flex-1 min-w-0">
            <strong>Desde tu última visita</strong> ({haceCuanto(cambiosVisita.desde).toLowerCase()}):{' '}
            {cambiosDesdeVisita.length === 0 ? 'ningún precio cambió.' : (
              <>
                {cambiosDesdeVisita.length} {cambiosDesdeVisita.length === 1 ? 'precio cambió' : 'precios cambiaron'}
                {' · '}{cambiosDesdeVisita.filter(c => c.cambio > 0).length} subieron, {cambiosDesdeVisita.filter(c => c.cambio < 0).length} bajaron.
              </>
            )}
          </span>
          {cambiosDesdeVisita.length > 0 && <button type="button" onClick={detalleVisita} className="m3-btn-text">Ver cambios</button>}
        </div>
      )}

      {cruces.length > 0 && (
        <div className="m3-banner m3-banner-warning" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">swap_vert</span>
          <span className="m3-body-medium flex-1 min-w-0">
            <strong>Cruces genérico / marca:</strong>{' '}
            {[
              cruces.filter(x => x.cruce.tipo === 'generico_caro').length && `${cruces.filter(x => x.cruce.tipo === 'generico_caro').length} de tus genéricos cuestan más que una marca de la competencia`,
              cruces.filter(x => x.cruce.tipo === 'marca_barata').length && `${cruces.filter(x => x.cruce.tipo === 'marca_barata').length} de tus marcas cuestan menos que un genérico`,
            ].filter(Boolean).join(' · ')}.
          </span>
          <button type="button" onClick={detalleCruces} className="m3-btn-text">Ver cuáles</button>
        </div>
      )}

      {/* Filtros y ajustes */}
      <section className="m3-dash-filtros" aria-label="Filtros del Dashboard">
        <div className="flex flex-wrap items-center gap-2">
          <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad}
            opciones={[['todos', 'Unidad: todas'], ...unidades]} />
          <FiltroChip etiqueta="Tipo" icono="category" valor={filtroTipo} onChange={setFiltroTipo}
            opciones={[['todos', 'Tipo: todos'], ['generico', 'Genéricos'], ['marca', 'Marca']]} />
          <FiltroChip etiqueta="Categoría" icono="sell" valor={filtroCategoria} onChange={setFiltroCategoria}
            opciones={[['todos', 'Categoría: todas'], ...categorias.map(c => [c, c])]} />
          <FiltroChip etiqueta="Comparar contra" icono="storefront" valor={cadenaComp} onChange={setCadenaComp}
            opciones={[['todos', 'Cadenas: todas'], ...cadenasComparables.map(c => [c, `Solo ${nombreCadena(c)}`])]} />
          <FiltroChip etiqueta="Competidores: marca o genérico" icono="verified" valor={tipoComp} onChange={setTipoComp}
            opciones={[['todos', 'Marcas y genéricos'], ['GENERICO', 'Solo genéricos'], ['MARCA', 'Solo marcas']]} />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <LimpiarFiltros visible={hayFiltros} onClick={() => { setFiltroUnidad('todos'); setFiltroTipo('todos'); setFiltroCategoria('todos'); setCadenaComp('todos'); setTipoComp('todos'); }} />
          <AjusteChip etiqueta="Precio que se compara" icono="receipt_long" valor={modoPrecio} onChange={setModoPrecio}
            opciones={[['lista', 'Precio de lista'], ['descuento', 'Precio con oferta']]} />
          <AjusteChip etiqueta="Comparar por" icono="medication" valor={modoAnalisis} onChange={setModoAnalisis}
            opciones={[['empaque', 'Por empaque'], ['unidosis', 'Por unidad']]} />
          <AjusteChip etiqueta="Periodo de los cambios" icono="history" valor={String(ventana)} onChange={v => setVentana(Number(v))}
            opciones={[['1', 'Cambios: 24 horas'], ['7', 'Cambios: 7 días'], ['15', 'Cambios: 15 días']]} />
          <AjusteChip etiqueta="Tu meta de precio" icono="flag" valor={String(meta)} onChange={v => setMeta(Number(v))}
            opciones={METAS.map(([v, t]) => [String(v), t])} />
          <label className="m3-switch-label whitespace-nowrap ml-1" title="Moneda de todo el Dashboard">
            <span className={moneda === 'bs' ? 'text-on-surface-variant' : 'font-medium'}>$</span>
            <input type="checkbox" role="switch" checked={moneda === 'bs'} onChange={e => setMoneda(e.target.checked ? 'bs' : 'usd')}
              className="m3-switch" aria-label="Ver los precios en bolívares" />
            <span className={moneda === 'bs' ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
          </label>
        </div>
      </section>

      {/* Indicadores */}
      <section className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3" aria-label="Indicadores">
        <StatCard
          compacto
          label="Tú frente al promedio"
          value={pct(kpi.frentePromedio)}
          hint={kpi.frentePromedio == null ? 'Sin productos para comparar' : `${kpi.deben} deben bajar · ${kpi.pueden} pueden subir`}
          icon="balance"
          tono={kpi.frentePromedio == null ? 'neutral' : kpi.frentePromedio > 5 ? 'negative' : kpi.frentePromedio < -UMBRAL_EMPATE ? 'primary' : 'neutral'}
          onClick={detalleFrentePromedio}
          title="La diferencia típica (mediana) de tu precio con el promedio del mercado. Toca para ver cada producto y cuánto subir o bajar para llegar a tu meta."
        />
        <StatCard
          compacto
          label="Eres el más barato"
          value={`${kpi.masBaratos.length} de ${kpi.comparables.length}`}
          hint={kpi.comparables.length ? `${Math.round((kpi.masBaratos.length / kpi.comparables.length) * 100)} % de los comparables` : 'Sin productos para comparar'}
          icon="workspace_premium"
          tono="primary"
          onClick={detalleMasBaratos}
          title="Ver los productos donde eres el más barato"
        />
        <StatCard
          compacto
          label="Más caros que el mínimo"
          value={kpi.masCaros.length}
          hint="Otra cadena es más barata"
          icon="trending_up"
          tono={kpi.masCaros.length ? 'negative' : 'neutral'}
          onClick={detalleMasCaros}
          title="Ver los productos donde la competencia es más barata"
        />
        <StatCard
          compacto
          label="Cambios de precio"
          value={kpi.cambios.length}
          hint={`${kpi.productosConCambios} ${kpi.productosConCambios === 1 ? 'producto' : 'productos'} · ${{ 1: '24 h', 7: '7 días', 15: '15 días' }[ventana]}`}
          icon="swap_vert"
          tono={kpi.cambios.length ? 'warning' : 'neutral'}
          onClick={detalleCambios}
          title="Ver qué precios cambiaron"
        />
        <StatCard
          compacto
          label="Sin comparar"
          value={kpi.sinComparar.length}
          hint="Falta tu precio o el de la competencia"
          icon="help"
          tono={kpi.sinComparar.length ? 'warning' : 'neutral'}
          onClick={detalleSinComparar}
          title="Ver qué productos no se pueden comparar y por qué"
        />
        <TarjetaBcv resumen={bcvResumen} bcv={bcv} color={tg.eje} onClick={() => setShowBcvModal(true)} />
      </section>

      {/* Graficos: los tres en una fila */}
      <section className={`grid grid-cols-1 lg:grid-cols-2 ${cadenaComp === 'todos' ? '2xl:grid-cols-3' : ''} gap-4`} aria-label="Gráficos">
        <TendenciaPosicion
          productos={productosFiltrados}
          conDescuento={modoPrecio === 'descuento'}
          porUnidad={modoAnalisis === 'unidosis'}
          cadena={cadenaComp === 'todos' ? null : cadenaComp}
          tipoMercado={tipoComp === 'todos' ? null : tipoComp}
          meta={meta}
          tg={tg}
          onDia={detalleDia}
        />
        <div className="m3-dash-card">
          <header className="m3-dash-card-header items-center">
            <div className="min-w-0 flex items-center gap-1">
              <h2 className="m3-title-medium text-on-surface">¿Dónde está tu precio?</h2>
              <InfoGrafico
                titulo="¿Dónde está tu precio?"
                que="Cuántos de tus productos caen en cada rango frente al promedio del mercado. Toca una barra para ver la lista."
                formula={[
                  'Diferencia = tu precio ÷ promedio del mercado − 1',
                  'Promedio del mercado = (suma de la competencia + tu precio) ÷ (competidores + 1)',
                  'Rangos: −15 % o menos · −15 a −5 % · parejo (±5 %) · +5 a +15 % · +15 % o más',
                ]}
                lectura="Azul a la izquierda: más barato que el mercado. Gris al centro: parejo. Rojo a la derecha: más caro. Mientras más productos en rojo, más caro estás frente a la competencia."
              />
            </div>
          </header>
          {kpi.comparables.length === 0 ? (
            <SinDatos texto="Aún no hay productos con tu precio y el de la competencia." />
          ) : (
            <>
              <div className="h-44" role="img" aria-label="Productos por grupo de diferencia con el promedio">
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

        {cadenaComp === 'todos' && <div className="m3-dash-card">
          <header className="m3-dash-card-header items-center">
            <div className="min-w-0 flex items-center gap-1">
              <h2 className="m3-title-medium text-on-surface">¿Qué cadena tiene el precio más bajo?</h2>
              <InfoGrafico
                titulo="¿Qué cadena tiene el precio más bajo?"
                que="En cuántos productos cada cadena tiene el precio más bajo de la competencia. Toca una barra para ver la lista."
                formula="Por producto: la cadena con el precio mínimo de la competencia suma 1"
                lectura="La barra más larga es la cadena más agresiva en precio. Tus propios enlaces no cuentan aquí."
                alinear="derecha"
              />
            </div>
          </header>
          {lideres.length === 0 ? (
            <SinDatos texto="Aún no hay precios de la competencia." />
          ) : (
            <div style={{ height: Math.min(200, Math.max(150, lideres.length * 34 + 16)) }} role="img" aria-label="Productos donde cada cadena es la más barata">
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
        </div>}
      </section>

      {/* Tabla */}
      <section ref={tablaRef} className="m3-data-table scroll-mt-4" aria-label="Precios por cadena">
        <div className="m3-data-table-titulo">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div>
              <h2 className="m3-title-medium text-on-surface">Precios por cadena</h2>
              <p className="m3-body-small text-on-surface-variant">
                {`El precio más bajo de la competencia en cada cadena${porUnidad}; resaltado, el mínimo. "Posición": el lugar de tu precio del más barato al más caro. "Para la meta": cuánto subir o bajar para quedar en ${textoMeta(meta)}.`}
              </p>
            </div>
            <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
              {filas.length === totalBase ? `${totalBase} productos` : `${filas.length} de ${totalBase} productos`}
            </div>
          </div>
        </div>
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
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
                    ['con_precio', 'Ocultar sin precio'],
                    ['mas_caro', 'Más caros que el mínimo'],
                    ['mas_barato', 'Eres el más barato'],
                    ['cambios', 'Con cambios de precio'],
                    ['sin_comparar', 'Sin comparar'],
                    ['bajar', 'Deben bajar para la meta'],
                    ['subir', 'Pueden subir hasta la meta'],
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
                    <div className="m3-cell-secondary">{subtituloProducto(x.producto)}</div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 m3-body-small">
                      <span>Tu precio <strong className="font-medium">{fmt(x.tuPrecio)}</strong></span>
                      <span className="inline-flex items-center gap-1">Mínimo {x.cadenasMin[0] && <CadenaBadge cadena={x.cadenasMin[0]} tamano="xs" />}<strong className="font-medium">{fmt(x.minimo)}</strong></span>
                      <AjusteMeta ajuste={ajusteDe(x)} fmt={fmt} />
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
                    <th className="text-right" title="Promedio del mercado: la competencia y tu precio"><BotonOrden campo="promedio" orden={orden} onClick={ordenarPor}>Promedio</BotonOrden></th>
                    <th className="text-right m3-dash-col-sep"><BotonOrden campo="tuPrecio" orden={orden} onClick={ordenarPor}>Tu precio</BotonOrden></th>
                    <th className="text-right" title="Lugar de tu precio entre todas las ofertas, del más barato (1) al más caro"><BotonOrden campo="posicion" orden={orden} onClick={ordenarPor}>Posición</BotonOrden></th>
                    <th className="text-right" title="Cuánto más caro (rojo) o más barato (azul) es tu precio que el mínimo de la competencia y que el promedio del mercado">
                      <div className="flex flex-col items-end">
                        <span>Tu diferencia</span>
                        <span className="inline-flex gap-3">
                          <BotonOrden campo="difMin" orden={orden} onClick={ordenarPor}>vs mín.</BotonOrden>
                          <BotonOrden campo="difProm" orden={orden} onClick={ordenarPor}>vs prom.</BotonOrden>
                        </span>
                      </div>
                    </th>
                    <th className="text-right"><BotonOrden campo="ajuste" orden={orden} onClick={ordenarPor}>Para la meta</BotonOrden></th>
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
                          <div className="m3-cell-secondary m3-cell-clamp" title={subtituloProducto(x.producto)}>{subtituloProducto(x.producto)}</div>
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
                        <td className="text-right whitespace-nowrap"><Posicion p={x.posicion} /></td>
                        <td className="text-right whitespace-nowrap"><DiferenciaDoble min={x.difMin} prom={x.difProm} /></td>
                        <td className="text-right whitespace-nowrap"><AjusteMeta ajuste={ajusteDe(x)} fmt={fmt} /></td>
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
          ancho={detalle.ancho}
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

// Una sola columna con las dos diferencias: frente al minimo y al promedio.
function DiferenciaDoble({ min, prom }) {
  if (min == null && prom == null) return <span className="text-on-surface-variant">—</span>;
  return (
    <div className="m3-dif-doble">
      <span><small>vs mín.</small><Diferencia valor={min} /></span>
      <span><small>vs prom.</small><Diferencia valor={prom} /></span>
    </div>
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
  if (resumen.diario != null) partes.push(`${pct(resumen.diario, 2)} hoy`);
  if (resumen.mensual != null) partes.push(`${pct(resumen.mensual)} en 30 d`);
  return (
    <button type="button" onClick={onClick} className="m3-stat m3-stat-compact cursor-pointer m3-interactive text-left w-full" title="Ver la historia de la tasa BCV o cambiarla a mano">
      <div className="m3-stat-body">
        <div className="m3-stat-label">Tasa BCV (por dólar)</div>
        <div className="m3-stat-value">{valor}</div>
        <div className="m3-stat-hint" title={partes.join(' · ')}>{partes.join(' · ') || 'Toca para ver la historia'}</div>
      </div>
      {resumen.serie.length > 1 && (
        <div className="w-16 h-9 shrink-0" aria-hidden="true">
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

// "Ultima lectura del robot": la corrida completa (todas las cadenas) o, si no
// hay corridas registradas, el precio mas reciente de los enlaces.
function LecturaRobot({ corrida, ultimaLectura }) {
  if (corrida?.started_at) {
    const fallaron = corrida.fallidos || 0;
    return (
      <span title={`Empezó ${fechaHora(corrida.started_at)}${corrida.finished_at ? ` · terminó ${fechaHora(corrida.finished_at)}` : ''}`}>
        Última lectura del robot:{' '}
        <strong className="font-medium text-on-surface">{haceCuanto(corrida.started_at).toLowerCase()}</strong>
        {corrida.en_proceso ? ' (en curso)' : ''}
        {corrida.total > 0 && <> · {corrida.exitosos} de {corrida.total} enlaces leídos</>}
        {fallaron > 0 && <> · <Link to="/cadenas" className="text-primary hover:underline">{fallaron} {fallaron === 1 ? 'falló' : 'fallaron'}</Link></>}
      </span>
    );
  }
  return (
    <span title={ultimaLectura ? fechaHora(ultimaLectura) : ''}>
      Última lectura del robot: <strong className="font-medium text-on-surface">{ultimaLectura ? haceCuanto(ultimaLectura).toLowerCase() : 'sin lecturas'}</strong>
    </span>
  );
}

// "140216 · Genérico · 500 mg · 20 tabletas": lo que distingue a dos
// productos con el mismo nombre.
function subtituloProducto(p) {
  const tipo = (p.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico';
  return [p.id_interno, tipo, p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ');
}

// "2 de 5": el lugar de tu precio entre todas las ofertas (la tuya y las de
// la competencia), del mas barato al mas caro.
function Posicion({ p }) {
  if (!p) return <span className="text-on-surface-variant">—</span>;
  const extremo = p.lugar === 1 ? 'is-barato' : p.lugar === p.de ? 'is-caro' : '';
  return (
    <span className={`m3-diferencia ${extremo}`} title={`Tu precio es el ${p.lugar}.º más barato de ${p.de} ofertas`}>
      {p.lugar} de {p.de}
    </span>
  );
}
