import BarraFiltros from './BarraFiltros';
import Segmentado from './Segmentado';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer, BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LabelList, Legend,
} from 'recharts';
import StatCard from './StatCard';
import FiltroChip from './FiltroChip';
import Select from './Select';
import CadenaBadge from './CadenaBadge';
import ConfirmModal from './ConfirmModal';
import InfoGrafico from './InfoGrafico';
import { normalizar } from './formulario';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { useHistoricoProducto } from '../hooks/useHistoricoProducto';
import { getChainColor } from '../utils/brandColors';
import { tokensGrafico } from '../utils/chartTokens';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { dbClearHistoricoPrecioForProduct } from '../utils/dbClient';
import { describirPresentacion } from '../utils/presentacion';
import { esMarca } from '../utils/tipoMercado';
import { fechaHora, haceCuanto } from '../utils/usuarios';
import {
  crearFormato, Diferencia, AjusteMeta, calcularAjuste, pct, leerColor, textoMeta, UMBRAL_CAMBIO,
} from './dashboard/comun';

// Ficha de un producto: sus precios de hoy en cada cadena, cuanto se aleja
// del minimo y del promedio de la competencia, y la historia de los precios.
// Pantalla completa, con el mismo lenguaje que el Dashboard.
//
// La historia se pide solo para ESTE producto al abrir la ficha (antes
// dependia del historico completo de todos los productos).

const PERIODOS = [[7, 'Últimos 7 días'], [15, 'Últimos 15 días'], [30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [180, 'Últimos 180 días']];
const MAX_SERIES = 8;
const COLUMNAS_HISTORIA = 'publicacion_id,cadena,marca,tipo,precio_full_bs,precio_desc_bs,tasa_bcv,fecha_local,scraped_at';
const colorCategorico = (i) => leerColor(`--md-sys-color-data-cat-${i + 1}`, ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'][i]);
const diaCorto = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });

// "Atamel 500 mg x 20 tabletas recubiertas" -> "Atamel": el nombre sin la
// concentracion ni el empaque (lo que va desde la primera cifra).
export function nombreCorto(nombre) {
  const t = String(nombre || '').trim();
  const corte = t.search(/\s\S*\d/);
  const corto = (corte > 0 ? t.slice(0, corte) : t).replace(/(\s+(x|de|por|con))+$/i, '').replace(/[\s,.;:-]+$/, '');
  return corto || t;
}

function leerMeta() {
  try { return Number(localStorage.getItem('dashboard.meta')) || 0; } catch { return 0; }
}

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose, initialPriceMode = 'lista', initialAnalisisMode = 'empaque' }) {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [] } = useData() || {};
  const { addToast } = useToast();
  const tasaBcv = useBcvRate();

  const [activo, setActivo] = useState(producto);
  const [moneda, setMoneda] = useState(currency || 'usd');
  const [modoPrecio, setModoPrecio] = useState(initialPriceMode === 'descuento' ? 'descuento' : 'lista');
  const [modoAnalisis, setModoAnalisis] = useState(initialAnalisisMode === 'unidosis' ? 'unidosis' : 'empaque');
  const [dias, setDias] = useState(7);
  const [relacion, setRelacion] = useState('todos'); // todos | propio | competencia
  const [cadenaFiltro, setCadenaFiltro] = useState('todos');
  const [tipoFiltro, setTipoFiltro] = useState('todos'); // todos | GENERICO | MARCA (competidores)
  const [vistaHistoria, setVistaHistoria] = useState('resumen'); // resumen | ofertas
  const [buscador, setBuscador] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [confirmBorrar, setConfirmBorrar] = useState(false);
  const menuRef = useRef(null);
  const meta = leerMeta();

  useEffect(() => { setActivo(producto); }, [producto]);

  // Escape cierra; la pagina de fondo no se desplaza.
  useEffect(() => {
    const alTeclear = (e) => { if (e.key === 'Escape' && !confirmBorrar) (buscador ? setBuscador(false) : onClose()); };
    window.addEventListener('keydown', alTeclear);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', alTeclear); document.body.style.overflow = overflow; };
  }, [onClose, buscador, confirmBorrar]);

  const cadenaPorClave = useMemo(() => {
    const m = new Map();
    for (const c of cadenas) { m.set(String(c.id).toLowerCase(), c); m.set(String(c.nombre).toLowerCase(), c); }
    return m;
  }, [cadenas]);
  const idCadena = (v) => cadenaPorClave.get(String(v || '').toLowerCase())?.id || v;
  const nombreCadena = (v) => cadenaPorClave.get(String(v || '').toLowerCase())?.nombre || v || '—';

  const pId = String(activo?.id_interno || activo?.id || '').trim();
  const enlaces = useMemo(() => {
    const deContexto = productosCompetencia.filter(e => e.activo !== false && String(e.id_producto_propio || '').trim() === pId);
    return deContexto.length || activo !== producto ? deContexto : (competencia || []).filter(e => e.activo !== false);
  }, [productosCompetencia, pId, competencia, activo, producto]);

  const unidadesPropio = Math.max(parseUnidosisCount(activo?.tamano || activo?.presentacion, activo?.nombre, activo?.unidosis || activo?.unidades_empaque), 1);
  const porUnidad = modoAnalisis === 'unidosis';
  const conDescuento = modoPrecio === 'descuento';
  const unidadesDe = (e) => {
    const leidas = Number(e.unidades_empaque || e.unidosis) > 1 ? Number(e.unidades_empaque || e.unidosis)
      : String(e.tipo).toLowerCase() === 'propio' ? unidadesPropio
        : parseUnidosisCount(e.tamano, e.marca, null);
    return Math.max(leidas > 1 ? leidas : unidadesPropio, 1);
  };

  // ---------------------------------------------------------------------
  // Precios de hoy
  // ---------------------------------------------------------------------
  const variacionPorPub = useMemo(() => new Map((variaciones || []).map(v => [v.publicacion_id, v])), [variaciones]);
  const ofertas = useMemo(() => enlaces.map(e => {
    const bs = conDescuento ? (e.ultimo_precio_desc_bs || e.ultimo_precio_full_bs) : e.ultimo_precio_full_bs;
    const unidades = unidadesDe(e);
    const tipo = String(e.tipo || '').toLowerCase();
    const base = { id: e.id, enlace: e, tipo, tipoMercado: esMarca(e) ? 'MARCA' : 'GENERICO', cadena: idCadena(e.cadena), marca: e.marca, laboratorio: e.laboratorio, unidades, url: e.url, fecha: e.ultimo_scrape };
    if (!bs || !bcvRate) return { ...base, sinPrecio: true };
    // Cambio en 7 dias, en dolares a la tasa de cada dia.
    const v = variacionPorPub.get(e.publicacion_id);
    let cambio = null;
    if (v?.precio_7d_full_bs && v?.precio_actual_full_bs) {
      const ahora = (conDescuento ? (v.precio_actual_desc_bs ?? v.precio_actual_full_bs) : v.precio_actual_full_bs) / (Number(v.tasa_actual) || bcvRate);
      const antes = (conDescuento ? (v.precio_7d_desc_bs ?? v.precio_7d_full_bs) : v.precio_7d_full_bs) / (Number(v.tasa_7d) || Number(v.tasa_actual) || bcvRate);
      if (antes > 0) cambio = (ahora / antes - 1) * 100;
    }
    return {
      ...base,
      priceUsd: bs / bcvRate / (porUnidad ? unidades : 1),
      unitUsd: bs / bcvRate / unidades,
      empaqueUsd: bs / bcvRate,
      cambio,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }).sort((a, b) => (a.sinPrecio ? 1 : 0) - (b.sinPrecio ? 1 : 0) || (a.priceUsd ?? 0) - (b.priceUsd ?? 0)), [enlaces, conDescuento, bcvRate, porUnidad, variacionPorPub, cadenaPorClave]);

  // Los filtros Relacion y Cadena definen que ofertas cuentan: minimo,
  // promedio, maximo, graficos y tabla se calculan solo sobre esas.
  // tm: marca o generico del competidor (tus enlaces no se filtran por esto).
  const pasaFiltros = (tipo, cadena, tm) =>
    (relacion === 'todos' || (relacion === 'propio' ? tipo === 'propio' : tipo !== 'propio')) &&
    (cadenaFiltro === 'todos' || cadena === cadenaFiltro) &&
    (tipoFiltro === 'todos' || tipo === 'propio' || tm === tipoFiltro);
  const cadenasOfertas = [...new Set(ofertas.map(o => o.cadena))].sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));
  const ofertasVisibles = ofertas.filter(o => pasaFiltros(o.tipo, o.cadena, o.tipoMercado));
  const visibles = ofertasVisibles.filter(o => !o.sinPrecio);
  const tuyas = ofertas.filter(o => !o.sinPrecio && o.tipo === 'propio' && (cadenaFiltro === 'todos' || o.cadena === cadenaFiltro));
  const pvp = Number(activo?.pvp_propio_usd || 0) > 0 ? Number(activo.pvp_propio_usd) / (porUnidad ? unidadesPropio : 1) : null;
  const tuPrecio = tuyas.length ? Math.min(...tuyas.map(o => o.priceUsd)) : pvp;
  const valores = visibles.map(o => o.priceUsd);
  const minimo = valores.length ? Math.min(...valores) : null;
  const maximo = valores.length ? Math.max(...valores) : null;
  // Con "Relación: todas" el promedio es el del mercado, como en el Dashboard:
  // la competencia visible mas tu precio (uno solo, el mas bajo). Con un
  // filtro de relacion es el promedio simple de las ofertas que se ven.
  const valoresComp = visibles.filter(o => o.tipo !== 'propio').map(o => o.priceUsd);
  const deMercado = relacion === 'todos' && tuPrecio != null && valoresComp.length > 0;
  const promedio = deMercado
    ? (valoresComp.reduce((a, b) => a + b, 0) + tuPrecio) / (valoresComp.length + 1)
    : valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
  const ofertaMin = visibles.find(o => o.priceUsd === minimo);
  const ofertaMax = visibles.find(o => o.priceUsd === maximo);
  const difProm = tuPrecio != null && promedio > 0 ? (tuPrecio / promedio - 1) * 100 : null;
  const ajuste = calcularAjuste(tuPrecio, promedio, meta, deMercado ? valoresComp.length : 0);
  const sufijoGrupo = relacion === 'propio' ? '(tuyos)' : relacion === 'competencia' ? '(competencia)' : '(todas)';
  const sufijoPromedio = deMercado ? '(mercado)' : sufijoGrupo;
  const { fmt, fmtUnidad } = crearFormato(moneda, bcvRate);
  const fmtModo = porUnidad ? fmtUnidad : fmt;

  // ---------------------------------------------------------------------
  // Historia (solo de este producto)
  // ---------------------------------------------------------------------
  // Se piden 7 dias de mas para arrastrar el ultimo precio al primer dia.
  const [historia, setHistoria] = useHistoricoProducto(pId, dias + 7, COLUMNAS_HISTORIA);

  const serieHistoria = useMemo(() => {
    const unidadesPorPub = new Map(enlaces.map(e => [e.publicacion_id, unidadesDe(e)]));
    const tmPorPub = new Map(enlaces.map(e => [e.publicacion_id, esMarca(e) ? 'MARCA' : 'GENERICO']));
    // Ultimo precio de cada enlace por dia.
    const porPub = new Map();
    const tasaPorDia = new Map();
    for (const h of historia.filas) {
      const bs = conDescuento ? (h.precio_desc_bs ?? h.precio_full_bs) : h.precio_full_bs;
      const tasa = Number(h.tasa_bcv) || bcvRate;
      if (!bs || !tasa) continue;
      const dia = h.fecha_local || String(h.scraped_at).slice(0, 10);
      const unidades = unidadesPorPub.get(h.publicacion_id) || (String(h.tipo) === 'propio' ? unidadesPropio : unidadesPropio);
      const usd = bs / tasa / (porUnidad ? unidades : 1);
      const cadena = idCadena(h.cadena);
      if (!pasaFiltros(String(h.tipo), cadena, tmPorPub.get(h.publicacion_id)) && !(String(h.tipo) === 'propio' && (cadenaFiltro === 'todos' || cadena === cadenaFiltro))) continue;
      if (!porPub.has(h.publicacion_id)) {
        const enlace = enlaces.find(e => e.publicacion_id === h.publicacion_id);
        porPub.set(h.publicacion_id, { tipo: h.tipo, tm: tmPorPub.get(h.publicacion_id), cadena, marca: h.marca, laboratorio: enlace?.laboratorio || '', unidades: unidadesPorPub.get(h.publicacion_id) || unidadesPropio, dias: new Map() });
      }
      porPub.get(h.publicacion_id).dias.set(dia, usd);
      if (Number(h.tasa_bcv) > 0) tasaPorDia.set(dia, Number(h.tasa_bcv));
    }
    // Dias del periodo; cada enlace arrastra su ultimo precio hasta 7 dias.
    const hoy = new Date();
    const fechas = Array.from({ length: dias }, (_, i) => new Date(hoy.getTime() - (dias - 1 - i) * 864e5).toISOString().slice(0, 10));
    const pubs = [...porPub.entries()];
    const visiblesPub = pubs.filter(([, info]) => pasaFiltros(String(info.tipo), info.cadena, info.tm));
    const ultimoConocido = (dias, fecha) => {
      for (let k = 0; k < 7; k++) {
        const f = new Date(new Date(`${fecha}T12:00:00Z`).getTime() - k * 864e5).toISOString().slice(0, 10);
        if (dias.has(f)) return dias.get(f);
      }
      return null;
    };
    const lineas = visiblesPub
      .sort((a, b) => (a[1].tipo === 'propio' ? -1 : 0) - (b[1].tipo === 'propio' ? -1 : 0))
      .slice(0, MAX_SERIES)
      .map(([pub, info], i) => ({
        clave: `p${pub}`,
        nombre: `${nombreCorto(info.marca)}${info.tipo === 'propio' ? ' (tuyo)' : info.laboratorio ? ` · ${info.laboratorio}` : ''}`,
        detalle: `${info.marca} · ${nombreCadena(info.cadena)} · ${info.unidades} ${info.unidades === 1 ? 'unidad' : 'unidades'}${info.laboratorio ? ` · ${info.laboratorio}` : ''}`,
        color: colorCategorico(i),
      }));
    // Dos lineas con el mismo nombre (mismo producto en dos cadenas): se
    // distinguen por la cadena.
    const repetidos = new Set(lineas.map(l => l.nombre).filter((n, i, a) => a.indexOf(n) !== i));
    for (const l of lineas) {
      if (repetidos.has(l.nombre)) l.nombre = `${l.nombre} (${l.detalle.split(' · ')[1]})`;
    }
    const puntos = fechas.map(fecha => {
      const fila = { fecha, tasa: tasaPorDia.get(fecha) ?? null };
      const tuyos = [];
      const otros = [];
      const comp = [];
      for (const [pub, info] of pubs) {
        const v = ultimoConocido(info.dias, fecha);
        if (v == null) continue;
        const visible = pasaFiltros(String(info.tipo), info.cadena, info.tm);
        if (visible) { fila[`p${pub}`] = v; otros.push(v); if (info.tipo !== 'propio') comp.push(v); }
        if (info.tipo === 'propio') tuyos.push(v);
      }
      if (tuyos.length) fila.tuyo = Math.min(...tuyos);
      if (otros.length) {
        fila.minimo = Math.min(...otros);
        // Con "todas": promedio del mercado (competencia + tu precio).
        fila.promedio = relacion === 'todos' && tuyos.length && comp.length
          ? (comp.reduce((a, b) => a + b, 0) + fila.tuyo) / (comp.length + 1)
          : otros.reduce((a, b) => a + b, 0) / otros.length;
      }
      return fila;
    }).filter(f => f.tuyo != null || f.minimo != null);
    return { puntos, lineas, ocultas: Math.max(0, pubs.length - MAX_SERIES) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historia.filas, conDescuento, porUnidad, dias, bcvRate, enlaces, cadenaPorClave, relacion, cadenaFiltro, tipoFiltro]);

  // ---------------------------------------------------------------------
  // Cambiar de producto
  // ---------------------------------------------------------------------
  const activos = useMemo(() => productos.filter(p => p.activo !== false)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es')), [productos]);
  const indice = activos.findIndex(p => String(p.id_interno) === pId);
  const irA = (p) => { if (p) { setActivo(p); setBuscador(false); setBusqueda(''); } };
  const encontrados = useMemo(() => {
    const t = normalizar(busqueda);
    return activos.filter(p => !t || normalizar(`${p.id_interno} ${p.nombre} ${p.principio_activo || ''}`).includes(t)).slice(0, 60);
  }, [activos, busqueda]);

  const borrarHistoria = async () => {
    try {
      await dbClearHistoricoPrecioForProduct(pId);
      setHistoria({ cargando: false, filas: [] });
      addToast('Historia de precios de este producto borrada.', 'success');
    } catch (err) {
      addToast(`No se pudo borrar: ${err?.message || err}`, 'error');
    } finally {
      setConfirmBorrar(false);
    }
  };

  const tg = tokensGrafico();
  if (!activo) return null;
  const tipoMercado = (activo.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico';
  const presentacion = [activo.concentracion, describirPresentacion(activo)].filter(v => v && v !== '—').join(' · ');
  const datosBarras = visibles.map(o => ({
    ...o,
    etiqueta: `${nombreCorto(o.marca)}${o.tipo === 'propio' ? ' (tuyo)' : ''}`,
    // El color configurado en Cadenas, sin transparencia.
    color: getChainColor(o.cadena),
  }));

  return createPortal(
    <div className="m3-ficha-pantalla" role="dialog" aria-modal="true" aria-label={`Ficha de ${activo.nombre}`}>
      {/* Barra superior */}
      <header className="m3-ficha-appbar">
        <button type="button" onClick={onClose} className="m3-icon-btn" title="Volver (Esc)" aria-label="Volver">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="m3-title-large text-on-surface truncate" title={activo.nombre}>{activo.nombre}</div>
          <div className="m3-body-small text-on-surface-variant truncate">
            <span className="font-mono">{activo.id_interno}</span> · {tipoMercado}
            {activo.categoria ? ` · ${activo.categoria}` : ''}{presentacion ? ` · ${presentacion}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className="m3-icon-btn" disabled={indice <= 0} onClick={() => irA(activos[indice - 1])} title="Producto anterior" aria-label="Producto anterior">
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <div className="relative">
            <button type="button" className="m3-btn-outline" onClick={() => setBuscador(b => !b)} aria-expanded={buscador}>
              <span className="material-symbols-outlined text-base">swap_horiz</span>
              <span className="hidden sm:inline">Cambiar producto</span>
            </button>
            {buscador && (
              <div className="m3-ficha-buscador">
                <label className="m3-search-field">
                  <span className="material-symbols-outlined" aria-hidden="true">search</span>
                  <input autoFocus type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="ID, nombre o molécula" aria-label="Buscar producto" />
                </label>
                <ul className="max-h-80 overflow-auto mt-2" role="listbox">
                  {encontrados.map(p => (
                    <li key={p.id_interno}>
                      <button type="button" onClick={() => irA(p)} role="option" aria-selected={String(p.id_interno) === pId}
                        className={`m3-menu-item w-full ${String(p.id_interno) === pId ? 'text-primary' : ''}`}>
                        <span className="font-mono text-on-surface-variant w-16 shrink-0 text-left">{p.id_interno}</span>
                        <span className="min-w-0 text-left">
                          <span className="block truncate">{p.nombre}</span>
                          <span className="block truncate m3-body-small text-on-surface-variant">
                            {[p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ')}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {encontrados.length === 0 && <li className="m3-body-medium text-on-surface-variant p-3">Ningún producto coincide.</li>}
                </ul>
              </div>
            )}
          </div>
          <button type="button" className="m3-icon-btn" disabled={indice < 0 || indice >= activos.length - 1} onClick={() => irA(activos[indice + 1])} title="Producto siguiente" aria-label="Producto siguiente">
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
          <details ref={menuRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger"
                onClick={() => { menuRef.current?.removeAttribute('open'); setConfirmBorrar(true); }}>
                <span className="material-symbols-outlined">delete_sweep</span>
                Borrar la historia de este producto
              </button>
            </div>
          </details>
        </div>
      </header>

      <main className="m3-ficha-contenido">
        {/* Filtros y ajustes */}
        <BarraFiltros
        limpiar={{ visible: relacion !== 'todos' || cadenaFiltro !== 'todos' || tipoFiltro !== 'todos', onClick: () => { setRelacion('todos'); setCadenaFiltro('todos'); setTipoFiltro('todos'); } }}
          etiqueta="Filtros de la ficha"
          filtrar={(
            <>
              <FiltroChip etiqueta="Relación" icono="group" valor={relacion} onChange={setRelacion}
                opciones={[['todos', 'Relación: todas'], ['propio', 'Solo tus enlaces'], ['competencia', 'Solo competencia']]} />
              <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadenaFiltro} onChange={setCadenaFiltro}
                opciones={[['todos', 'Cadena: todas'], ...cadenasOfertas.map(c => [c, nombreCadena(c)])]} />
              <FiltroChip etiqueta="Competidores: marca o genérico" icono="verified" valor={tipoFiltro} onChange={setTipoFiltro}
                opciones={[['todos', 'Marcas y genéricos'], ['GENERICO', 'Solo genéricos'], ['MARCA', 'Solo marcas']]} />
          
            </>
          )}
          comparar={(
            <>
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={modoPrecio} onChange={setModoPrecio}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', 'Precio con oferta']]} />
            <Segmentado etiqueta="Comparar por" rotulo="Por" valor={modoAnalisis} onChange={setModoAnalisis}
              opciones={[['empaque', 'Empaque', 'Precio de la caja'], ['unidosis', 'Unidad', 'Precio por tableta, ml o g']]} />
            <Segmentado etiqueta="Moneda" valor={moneda} onChange={setMoneda}
              opciones={[['usd', '$', 'Dólares'], ['bs', 'Bs', 'Bolívares a la tasa BCV']]} />
            </>
          )}
        />

        {/* Indicadores: sobre las ofertas que dejan ver los filtros */}
        <section className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3" aria-label="Indicadores del producto">
          <StatCard compacto label={`Tu precio${porUnidad ? ' por unidad' : ''}`} value={fmtModo(tuPrecio)} icon="sell" tono="primary"
            hint={tuyas.length ? (tuyas.length === 1 ? 'Tu enlace' : `El más bajo de tus ${tuyas.length} enlaces`) : pvp ? 'PVP cargado en Productos' : 'Sin precio tuyo'} />
          <StatCard compacto label={`Mínimo ${sufijoGrupo}`} value={fmtModo(minimo)} icon="south" tono="neutral"
            hint={ofertaMin ? `${nombreCorto(ofertaMin.marca)} en ${nombreCadena(ofertaMin.cadena)}` : 'Sin precios'} />
          <StatCard compacto label={`Promedio ${sufijoPromedio}`} value={fmtModo(promedio)} icon="balance" tono="neutral"
            hint={`${visibles.length} ${visibles.length === 1 ? 'oferta' : 'ofertas'}`} />
          <StatCard compacto label={`Máximo ${sufijoGrupo}`} value={fmtModo(maximo)} icon="north" tono="neutral"
            hint={ofertaMax ? `${nombreCorto(ofertaMax.marca)} en ${nombreCadena(ofertaMax.cadena)}` : 'Sin precios'} />
          <StatCard compacto label="Tú frente al promedio" value={pct(difProm)} icon="percent" tono={difProm > 5 ? 'negative' : difProm < -0.5 ? 'primary' : 'neutral'}
            hint={ajuste ? (ajuste.estado === 'en_meta' ? `En tu meta (${textoMeta(meta)})` : `${ajuste.estado === 'bajar' ? 'Bajar' : 'Subir'} ${fmtModo(Math.abs(ajuste.usd))} para tu meta`) : 'Falta tu precio o el promedio'} />
          <StatCard compacto label="Tasa BCV (Bs por dólar)" value={bcvRate ? bcvRate.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} icon="currency_exchange" tono="neutral"
            hint={tasaBcv.updatedAt ? `Del ${new Date(tasaBcv.updatedAt).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' })} · la historia usa la de cada día` : 'La historia usa la de cada día'} />
        </section>

        {/* Ofertas */}
        <section className="m3-data-table" aria-label="Ofertas">
          <div className="m3-data-table-titulo pb-3 border-b border-outline-variant flex flex-wrap items-center gap-2">
            <h2 className="m3-title-medium text-on-surface">Ofertas</h2>
            <span className="m3-body-small text-on-surface-variant">
              {ofertasVisibles.length} {ofertasVisibles.length === 1 ? 'oferta' : 'ofertas'}{porUnidad ? ' · precios por unidad' : ''}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-ficha m3-table-apilada">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cadena</th>
                  <th className="text-right">Unidades</th>
                  <th className="text-right">{porUnidad ? 'Precio por unidad' : 'Precio'}</th>
                  <th className="text-right" title="Cuánto más caro (rojo) o barato (azul) es tu precio que esta oferta">Tú frente a esta</th>
                  <th className="text-right">Cambio 7 días</th>
                  <th>Última lectura</th>
                  <th className="m3-sticky-actions"><span className="sr-only">Enlace</span></th>
                </tr>
              </thead>
              <tbody>
                {ofertasVisibles.map(o => (
                  <tr key={o.id}>
                    <td>
                      <div className="m3-cell-primary m3-cell-clamp max-w-[20rem]" title={o.marca}>{o.marca}</div>
                      <div className="m3-cell-secondary">
                        {o.tipo === 'propio' ? <span className="m3-chip-propio">Tuyo</span> : (
                          <>{o.laboratorio || 'Competidor'} · <span className={o.tipoMercado === 'MARCA' ? 'm3-chip-marca' : 'm3-chip-generico'}>{o.tipoMercado === 'MARCA' ? 'Marca' : 'Genérico'}</span></>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap" data-label="Cadena">
                      <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={o.cadena} tamano="xs" title="" />{nombreCadena(o.cadena)}</span>
                    </td>
                    <td className="text-right tabular-nums" data-label="Unidades">{o.unidades}</td>
                    <td className="text-right whitespace-nowrap tabular-nums font-medium" data-label={porUnidad ? 'Precio por unidad' : 'Precio'}>{o.sinPrecio ? <span className="text-on-surface-variant font-normal">Sin precio</span> : fmtModo(o.priceUsd)}</td>
                    <td className="text-right whitespace-nowrap" data-label="Tú frente a esta">
                      {o.sinPrecio || o.tipo === 'propio' || tuPrecio == null ? '—' : <Diferencia valor={(tuPrecio / o.priceUsd - 1) * 100} />}
                    </td>
                    <td className="text-right whitespace-nowrap" data-label="Cambio 7 días">{o.cambio != null && Math.abs(o.cambio) > UMBRAL_CAMBIO ? <Diferencia valor={o.cambio} /> : <span className="text-on-surface-variant">Sin cambio</span>}</td>
                    <td className="whitespace-nowrap m3-body-small text-on-surface-variant" data-label="Última lectura" title={o.fecha ? fechaHora(o.fecha) : ''}>{o.fecha ? haceCuanto(o.fecha) : 'Nunca'}</td>
                    <td className="m3-sticky-actions">
                      {o.url && (
                        <a href={o.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir en la tienda" aria-label={`Abrir ${o.marca} en ${nombreCadena(o.cadena)}`}>
                          <span className="material-symbols-outlined">open_in_new</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {ofertasVisibles.length === 0 && (
                  <tr><td colSpan={8} className="text-center text-on-surface-variant py-8">{ofertas.length ? 'Ninguna oferta con estos filtros.' : 'Este producto no tiene enlaces. Vincúlalos en Competencia.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {ajuste && (
            <p className="m3-body-small text-on-surface-variant px-4 py-3 border-t border-outline-variant flex flex-wrap items-center gap-2">
              Para quedar en tu meta ({textoMeta(meta)}, se cambia en el Dashboard) tu precio sería {fmtModo(ajuste.objetivo)}:
              <AjusteMeta ajuste={ajuste} fmt={fmtModo} />
            </p>
          )}
        </section>

        {/* Graficos juntos */}
        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4" aria-label="Gráficos">
          <div className="m3-dash-card">
            <header className="m3-dash-card-header items-center">
              <div className="min-w-0 flex items-center gap-1">
                <h2 className="m3-title-medium text-on-surface">Precios de hoy</h2>
                <InfoGrafico
                  titulo="Precios de hoy"
                  que={`El último precio leído de cada oferta${porUnidad ? ', por unidad' : ''}, del más barato al más caro. Solo las ofertas que dejan ver los filtros Relación y Cadena.`}
                  formula={[
                    `Precio en $ = precio en Bs ÷ tasa BCV de hoy${porUnidad ? ' ÷ unidades del empaque' : ''}`,
                    'Promedio = suma de los precios ÷ número de ofertas',
                  ]}
                  lectura="Cada columna tiene el color de su cadena; la tuya va con borde. La línea horizontal es el promedio: si tu columna queda por encima, estás más caro que el promedio."
                />
              </div>
            </header>
            {visibles.length === 0 ? (
              <div className="h-72 flex items-center justify-center text-on-surface-variant m3-body-medium">No hay precios con estos filtros.</div>
            ) : (
              <div className="h-72" role="img" aria-label="Precio de cada oferta">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={datosBarras} margin={{ top: 20, right: 64, left: 0, bottom: 0 }} barCategoryGap="22%">
                    <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                    <XAxis dataKey="etiqueta" interval={0} tick={<TickOferta color={tg.eje} />} tickLine={false} axisLine={{ stroke: tg.rejilla }} height={40} />
                    <YAxis tickFormatter={v => fmtModo(v)} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
                    {promedio > 0 && (
                      <ReferenceLine y={promedio} stroke={tg.eje} strokeOpacity={0.7}
                        label={<EtiquetaPromedio valor={fmtModo(promedio)} color={tg.texto} />} />
                    )}
                    <Tooltip cursor={{ fill: tg.rejilla, fillOpacity: 0.25 }} content={<TooltipOferta fmt={fmtModo} nombreCadena={nombreCadena} />} />
                    <Bar dataKey="priceUsd" radius={[4, 4, 0, 0]} maxBarSize={48}>
                      {datosBarras.map(o => <Cell key={o.id} fill={o.color} stroke={o.tipo === 'propio' ? tg.texto : undefined} strokeWidth={o.tipo === 'propio' ? 2 : 0} />)}
                      <LabelList dataKey="priceUsd" position="top" formatter={fmtModo} fill={tg.texto} stroke="none" fontSize={11} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="m3-dash-card">
            <header className="m3-dash-card-header flex-wrap items-center">
              <div className="min-w-0 flex items-center gap-1 mr-auto">
                <h2 className="m3-title-medium text-on-surface">Historia de precios</h2>
                <InfoGrafico
                  titulo="Historia de precios"
                  que="Cómo se movieron los precios día a día. Con «Tuyo, mínimo y promedio» ves las tres líneas resumen; con «Cada oferta», una línea por enlace (pasa el mouse por la leyenda para ver el detalle)."
                  formula={[
                    `Precio del día en $ = precio en Bs ÷ tasa BCV de ese día${porUnidad ? ' ÷ unidades' : ''}`,
                    'Si un día no hubo lectura, se usa el último precio de hasta 7 días antes',
                    'Tuyo = el más bajo de tus enlaces · Mínimo y promedio = de las ofertas filtradas',
                  ]}
                  lectura="Si tu línea se separa hacia arriba del promedio, te estás encareciendo frente a la competencia. Como se usa la tasa de cada día, la subida del dólar no se ve como subida de precio."
                  alinear="derecha"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={vistaHistoria} onChange={e => setVistaHistoria(e.target.value)} aria-label="Qué ver" className="m3-filter-chip" leadingIcon="stacked_line_chart">
                  <option value="resumen">Tuyo, mínimo y promedio</option>
                  <option value="ofertas">Cada oferta</option>
                </Select>
                <Select value={String(dias)} onChange={e => setDias(Number(e.target.value))} aria-label="Periodo" className="m3-filter-chip" leadingIcon="date_range">
                  {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </Select>
              </div>
            </header>
            {historia.cargando && serieHistoria.puntos.length === 0 ? (
              <div className="h-72 rounded-2xl m3-skeleton" aria-busy="true" />
            ) : serieHistoria.puntos.length < 2 ? (
              <div className="h-72 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-3xl" aria-hidden="true">show_chart</span>
                <span className="m3-body-medium">Aún no hay historia de precios en este periodo.</span>
              </div>
            ) : (
              <div className={`h-72 ${historia.cargando ? 'opacity-60' : ''}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={serieHistoria.puntos} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                    <XAxis dataKey="fecha" tickFormatter={diaCorto} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={{ stroke: tg.rejilla }} minTickGap={24} />
                    <YAxis tickFormatter={v => fmtModo(v)} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
                    <Tooltip content={<TooltipHistoria fmt={fmtModo} />} cursor={{ stroke: tg.eje, strokeOpacity: 0.3 }} />
                    <Legend content={<LeyendaHistoria color={tg.eje} />} />
                    {vistaHistoria === 'resumen' ? (
                      [
                        <Line key="tuyo" type="monotone" dataKey="tuyo" name="Tu precio" stroke={colorCategorico(0)} strokeWidth={2} dot={serieHistoria.puntos.length <= 15} connectNulls isAnimationActive={false} />,
                        <Line key="minimo" type="monotone" dataKey="minimo" name={`Mínimo ${sufijoGrupo}`} stroke={colorCategorico(1)} strokeWidth={2} dot={serieHistoria.puntos.length <= 15} connectNulls isAnimationActive={false} />,
                        <Line key="promedio" type="monotone" dataKey="promedio" name={`Promedio ${relacion === 'todos' ? '(mercado)' : sufijoGrupo}`} stroke={colorCategorico(2)} strokeWidth={2} dot={serieHistoria.puntos.length <= 15} connectNulls isAnimationActive={false} />,
                      ]
                    ) : (
                      serieHistoria.lineas.map(l => (
                        <Line key={l.clave} type="monotone" dataKey={l.clave} name={l.nombre} detalle={l.detalle} stroke={l.color} strokeWidth={2} dot={serieHistoria.puntos.length <= 15} connectNulls isAnimationActive={false} />
                      ))
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {vistaHistoria === 'ofertas' && serieHistoria.ocultas > 0 && (
              <p className="m3-body-small text-on-surface-variant mt-2">Se muestran {MAX_SERIES} ofertas; {serieHistoria.ocultas} más no caben en el gráfico.</p>
            )}
          </div>
        </section>
      </main>

      <ConfirmModal
        isOpen={confirmBorrar}
        title="¿Borrar la historia de este producto?"
        message={`Se borran las capturas de precio guardadas de ${activo.nombre} en todas las cadenas. Los enlaces no se tocan. No se puede deshacer.`}
        confirmText="Borrar historia"
        cancelText="Cancelar"
        isDanger
        onConfirm={borrarHistoria}
        onCancel={() => setConfirmBorrar(false)}
      />
    </div>,
    document.body
  );
}

function TooltipOferta({ active, payload, fmt, nombreCadena }) {
  if (!active || !payload?.length) return null;
  const o = payload[0].payload;
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium">{o.marca}</div>
      <div className="text-on-surface-variant">{o.tipo === 'propio' ? 'Tuyo · ' : ''}{nombreCadena(o.cadena)} · {o.unidades} {o.unidades === 1 ? 'unidad' : 'unidades'}</div>
      <div>{fmt(o.priceUsd)}</div>
    </div>
  );
}

function TooltipHistoria({ active, payload, label, fmt }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="m3-chart-tooltip max-w-xs">
      <div className="font-medium first-letter:uppercase">{new Date(`${label}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      {payload.filter(p => p.value != null).sort((a, b) => a.value - b.value).map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <i className="inline-block w-3 h-0.5 shrink-0" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="tabular-nums font-medium">{fmt(p.value)}</span>
        </div>
      ))}
      {payload[0]?.payload?.tasa > 0 && (
        <div className="text-on-surface-variant border-t border-outline-variant mt-1 pt-1">
          Tasa BCV del día: Bs {payload[0].payload.tasa.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
}

// Etiqueta de la linea del promedio: a la derecha de la zona de columnas
// (en el margen), asi nunca se monta sobre una columna.
function EtiquetaPromedio({ viewBox, valor, color }) {
  if (!viewBox) return null;
  const x = viewBox.x + viewBox.width + 6;
  return (
    <text x={x} y={viewBox.y} fill={color} fontSize={11}>
      <tspan x={x} dy={-2}>Promedio</tspan>
      <tspan x={x} dy={13} fontWeight={600}>{valor}</tspan>
    </text>
  );
}

// Etiqueta de cada columna: el nombre corto en dos lineas como maximo.
function TickOferta({ x, y, payload, color }) {
  const texto = String(payload.value);
  const palabras = texto.split(' ');
  const l1 = [];
  const l2 = [];
  for (const p of palabras) ((l1.join(' ').length + p.length) < 13 && l2.length === 0 ? l1 : l2).push(p);
  const segunda = l2.join(' ');
  return (
    <text x={x} y={y + 12} textAnchor="middle" fill={color} fontSize={11}>
      <title>{texto}</title>
      <tspan x={x} dy={0}>{l1.join(' ') || texto.slice(0, 12)}</tspan>
      {segunda && <tspan x={x} dy={13}>{segunda.length > 14 ? `${segunda.slice(0, 13)}…` : segunda}</tspan>}
    </text>
  );
}

// Leyenda: nombre corto y laboratorio; al pasar el mouse, el detalle completo.
function LeyendaHistoria({ payload, color }) {
  if (!payload?.length) return null;
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-2" style={{ fontSize: 12 }}>
      {payload.map(p => (
        <li key={p.dataKey} className="inline-flex items-center gap-1.5 cursor-default" title={p.payload?.detalle || p.value}>
          <i className="inline-block w-3 h-0.5" style={{ background: p.color }} />
          <span style={{ color }}>{p.value}</span>
        </li>
      ))}
    </ul>
  );
}
