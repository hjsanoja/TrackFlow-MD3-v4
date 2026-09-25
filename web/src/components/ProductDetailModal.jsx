import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer, BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LabelList, Legend,
} from 'recharts';
import StatCard from './StatCard';
import Select from './Select';
import CadenaBadge from './CadenaBadge';
import ConfirmModal from './ConfirmModal';
import { normalizar } from './formulario';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { supabase, isSupabaseActive } from '../supabase';
import { getChainColor } from '../utils/brandColors';
import { tokensGrafico } from '../utils/chartTokens';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { dbClearHistoricoPrecioForProduct } from '../utils/dbClient';
import { describirPresentacion } from '../utils/presentacion';
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

const PERIODOS = [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [180, 'Últimos 180 días']];
const MAX_SERIES = 8;
const colorCategorico = (i) => leerColor(`--md-sys-color-data-cat-${i + 1}`, ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'][i]);
const diaCorto = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });

function leerMeta() {
  try { return Number(localStorage.getItem('dashboard.meta')) || 0; } catch { return 0; }
}

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose, initialPriceMode = 'lista', initialAnalisisMode = 'empaque' }) {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [] } = useData() || {};
  const { addToast } = useToast();

  const [activo, setActivo] = useState(producto);
  const [moneda, setMoneda] = useState(currency || 'usd');
  const [modoPrecio, setModoPrecio] = useState(initialPriceMode === 'descuento' ? 'descuento' : 'lista');
  const [modoAnalisis, setModoAnalisis] = useState(initialAnalisisMode === 'unidosis' ? 'unidosis' : 'empaque');
  const [dias, setDias] = useState(90);
  const [vistaHistoria, setVistaHistoria] = useState('resumen'); // resumen | ofertas
  const [historia, setHistoria] = useState({ cargando: true, filas: [] });
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
    const base = { id: e.id, enlace: e, tipo, cadena: idCadena(e.cadena), marca: e.marca, laboratorio: e.laboratorio, unidades, url: e.url, fecha: e.ultimo_scrape };
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

  const conPrecio = ofertas.filter(o => !o.sinPrecio);
  const tuyas = conPrecio.filter(o => o.tipo === 'propio');
  const comp = conPrecio.filter(o => o.tipo !== 'propio');
  const pvp = Number(activo?.pvp_propio_usd || 0) > 0 ? Number(activo.pvp_propio_usd) / (porUnidad ? unidadesPropio : 1) : null;
  const tuPrecio = tuyas.length ? Math.min(...tuyas.map(o => o.priceUsd)) : pvp;
  const minimo = comp.length ? Math.min(...comp.map(o => o.priceUsd)) : null;
  const promedio = comp.length ? comp.reduce((a, o) => a + o.priceUsd, 0) / comp.length : null;
  const ofertaMin = comp.find(o => o.priceUsd === minimo);
  const difMin = tuPrecio != null && minimo > 0 ? (tuPrecio / minimo - 1) * 100 : null;
  const difProm = tuPrecio != null && promedio > 0 ? (tuPrecio / promedio - 1) * 100 : null;
  const ajuste = calcularAjuste(tuPrecio, promedio, meta);
  const { fmt, fmtUnidad } = crearFormato(moneda, bcvRate);
  const fmtModo = porUnidad ? fmtUnidad : fmt;

  // ---------------------------------------------------------------------
  // Historia (solo de este producto)
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!pId || !isSupabaseActive()) { setHistoria({ cargando: false, filas: [] }); return undefined; }
    let vigente = true;
    setHistoria(h => ({ ...h, cargando: true }));
    const desde = new Date(Date.now() - (dias + 7) * 864e5).toISOString();
    (async () => {
      const filas = [];
      for (let pagina = 0; pagina < 10; pagina++) {
        const { data, error } = await supabase.from('historico_precios')
          .select('publicacion_id,cadena,marca,tipo,precio_full_bs,precio_desc_bs,tasa_bcv,fecha_local,scraped_at')
          .eq('id_producto_propio', pId).gte('scraped_at', desde)
          .order('scraped_at', { ascending: true })
          .range(pagina * 1000, pagina * 1000 + 999);
        if (error || !data?.length) break;
        filas.push(...data);
        if (data.length < 1000) break;
      }
      if (vigente) setHistoria({ cargando: false, filas });
    })().catch(() => { if (vigente) setHistoria({ cargando: false, filas: [] }); });
    return () => { vigente = false; };
  }, [pId, dias]);

  const serieHistoria = useMemo(() => {
    const unidadesPorPub = new Map(enlaces.map(e => [e.publicacion_id, unidadesDe(e)]));
    // Ultimo precio de cada enlace por dia.
    const porPub = new Map();
    for (const h of historia.filas) {
      const bs = conDescuento ? (h.precio_desc_bs ?? h.precio_full_bs) : h.precio_full_bs;
      const tasa = Number(h.tasa_bcv) || bcvRate;
      if (!bs || !tasa) continue;
      const dia = h.fecha_local || String(h.scraped_at).slice(0, 10);
      const unidades = unidadesPorPub.get(h.publicacion_id) || (String(h.tipo) === 'propio' ? unidadesPropio : unidadesPropio);
      const usd = bs / tasa / (porUnidad ? unidades : 1);
      if (!porPub.has(h.publicacion_id)) porPub.set(h.publicacion_id, { tipo: h.tipo, cadena: idCadena(h.cadena), marca: h.marca, dias: new Map() });
      porPub.get(h.publicacion_id).dias.set(dia, usd);
    }
    // Dias del periodo; cada enlace arrastra su ultimo precio hasta 7 dias.
    const hoy = new Date();
    const fechas = Array.from({ length: dias }, (_, i) => new Date(hoy.getTime() - (dias - 1 - i) * 864e5).toISOString().slice(0, 10));
    const pubs = [...porPub.entries()];
    const ultimoConocido = (dias, fecha) => {
      for (let k = 0; k < 7; k++) {
        const f = new Date(new Date(`${fecha}T12:00:00Z`).getTime() - k * 864e5).toISOString().slice(0, 10);
        if (dias.has(f)) return dias.get(f);
      }
      return null;
    };
    const lineas = pubs
      .sort((a, b) => (a[1].tipo === 'propio' ? -1 : 0) - (b[1].tipo === 'propio' ? -1 : 0))
      .slice(0, MAX_SERIES)
      .map(([pub, info], i) => ({ clave: `p${pub}`, nombre: `${info.tipo === 'propio' ? 'Tuyo · ' : ''}${info.marca} (${nombreCadena(info.cadena)})`, color: colorCategorico(i) }));
    const puntos = fechas.map(fecha => {
      const fila = { fecha };
      const tuyos = [];
      const otros = [];
      for (const [pub, info] of pubs) {
        const v = ultimoConocido(info.dias, fecha);
        if (v == null) continue;
        fila[`p${pub}`] = v;
        (info.tipo === 'propio' ? tuyos : otros).push(v);
      }
      if (tuyos.length) fila.tuyo = Math.min(...tuyos);
      if (otros.length) {
        fila.minimo = Math.min(...otros);
        fila.promedio = otros.reduce((a, b) => a + b, 0) / otros.length;
      }
      return fila;
    }).filter(f => f.tuyo != null || f.minimo != null);
    return { puntos, lineas, ocultas: Math.max(0, pubs.length - MAX_SERIES) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historia.filas, conDescuento, porUnidad, dias, bcvRate, enlaces, cadenaPorClave]);

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
  const datosBarras = conPrecio.map(o => ({
    ...o,
    etiqueta: `${o.tipo === 'propio' ? 'Tuyo · ' : ''}${String(o.marca || '').slice(0, 26)}${String(o.marca || '').length > 26 ? '…' : ''}`,
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
                        <span className="truncate text-left">{p.nombre}</span>
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
        {/* Ajustes de vista */}
        <section className="m3-dash-filtros" aria-label="Ajustes de la ficha">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={modoPrecio} onChange={e => setModoPrecio(e.target.value)} aria-label="Precio que se compara" className="m3-filter-chip" leadingIcon="receipt_long">
              <option value="lista">Precio de lista</option>
              <option value="descuento">Precio con oferta</option>
            </Select>
            <Select value={modoAnalisis} onChange={e => setModoAnalisis(e.target.value)} aria-label="Comparar por" className="m3-filter-chip" leadingIcon="medication">
              <option value="empaque">Por empaque</option>
              <option value="unidosis">Por unidad (tableta, cápsula…)</option>
            </Select>
          </div>
          <div className="flex items-center gap-3 lg:ml-auto">
            <span className="m3-body-small text-on-surface-variant">Tasa BCV: Bs {bcvRate ? bcvRate.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
            <label className="m3-switch-label whitespace-nowrap">
              <span className={moneda === 'bs' ? 'text-on-surface-variant' : 'font-medium'}>$</span>
              <input type="checkbox" role="switch" checked={moneda === 'bs'} onChange={e => setMoneda(e.target.checked ? 'bs' : 'usd')}
                className="m3-switch" aria-label="Ver los precios en bolívares" />
              <span className={moneda === 'bs' ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
            </label>
          </div>
        </section>

        {/* Indicadores */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-label="Indicadores del producto">
          <StatCard label={`Tu precio${porUnidad ? ' por unidad' : ''}`} value={fmtModo(tuPrecio)} icon="sell" tono="primary"
            hint={tuyas.length ? `${tuyas.length === 1 ? 'Tu enlace' : `El más bajo de tus ${tuyas.length} enlaces`}` : pvp ? 'PVP cargado en Productos' : 'Sin precio tuyo'} />
          <StatCard label="Mínimo de la competencia" value={fmtModo(minimo)} icon="south" tono="neutral"
            hint={ofertaMin ? `${ofertaMin.marca} en ${nombreCadena(ofertaMin.cadena)}` : 'Sin precios de la competencia'} />
          <StatCard label="Frente al mínimo" value={pct(difMin)} icon="trending_up" tono={difMin > 0.5 ? 'negative' : difMin != null ? 'positive' : 'neutral'}
            hint={difMin == null ? 'Falta tu precio o el de la competencia' : difMin > 0.5 ? 'Otra cadena lo vende más barato' : 'Eres el más barato'} />
          <StatCard label="Frente al promedio" value={pct(difProm)} icon="balance" tono={difProm > 5 ? 'negative' : 'neutral'}
            hint={ajuste ? (ajuste.estado === 'en_meta' ? `En tu meta (${textoMeta(meta)})` : `${ajuste.estado === 'bajar' ? 'Bajar' : 'Subir'} ${fmtModo(Math.abs(ajuste.usd))} para ${textoMeta(meta)}`) : `Promedio: ${fmtModo(promedio)}`} />
        </section>

        {/* Precios de hoy */}
        <section className="m3-data-table" aria-label="Precios de hoy">
          <div className="m3-data-table-toolbar">
            <h2 className="m3-title-medium text-on-surface">Precios de hoy</h2>
            <p className="m3-body-small text-on-surface-variant">
              El último precio leído de cada enlace{porUnidad ? ', por unidad' : ''}, del más barato al más caro. La línea marca el promedio de la competencia.
            </p>
          </div>
          {conPrecio.length > 0 && (
            <div className="px-4 pt-4" style={{ height: Math.max(140, datosBarras.length * 34 + 40) }} role="img" aria-label="Precio de cada oferta">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={datosBarras} layout="vertical" margin={{ top: 16, right: 64, left: 8, bottom: 4 }} barCategoryGap="24%">
                  <CartesianGrid horizontal={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                  <XAxis type="number" hide domain={[0, 'dataMax']} />
                  <YAxis type="category" dataKey="etiqueta" width={190} tick={{ fill: tg.eje, fontSize: 12 }} tickLine={false} axisLine={false} />
                  {promedio > 0 && (
                    <ReferenceLine x={promedio} stroke={tg.eje} strokeOpacity={0.7}
                      label={{ value: 'Promedio', position: 'top', fill: tg.eje, fontSize: 11 }} />
                  )}
                  <Tooltip cursor={{ fill: tg.rejilla, fillOpacity: 0.25 }} content={<TooltipOferta fmt={fmtModo} nombreCadena={nombreCadena} />} />
                  <Bar dataKey="priceUsd" radius={[0, 4, 4, 0]} maxBarSize={20}>
                    {datosBarras.map(o => <Cell key={o.id} fill={o.color} fillOpacity={o.tipo === 'propio' ? 1 : 0.85} />)}
                    <LabelList dataKey="priceUsd" position="right" formatter={fmtModo} fill={tg.texto} fontSize={12} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-ficha">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Cadena</th>
                  <th className="text-right">Unidades</th>
                  <th className="text-right">Precio</th>
                  <th className="text-right">Por unidad</th>
                  <th className="text-right" title="Cuánto más caro (rojo) o barato (azul) es tu precio que esta oferta">Tú frente a esta</th>
                  <th className="text-right">Cambio 7 días</th>
                  <th>Última lectura</th>
                  <th className="m3-sticky-actions"><span className="sr-only">Enlace</span></th>
                </tr>
              </thead>
              <tbody>
                {ofertas.map(o => (
                  <tr key={o.id}>
                    <td>
                      <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={o.marca}>{o.marca}</div>
                      <div className="m3-cell-secondary">
                        {o.tipo === 'propio' ? <span className="m3-chip-propio">Tuyo</span> : (o.laboratorio || 'Competidor')}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={o.cadena} tamano="xs" title="" />{nombreCadena(o.cadena)}</span>
                    </td>
                    <td className="text-right tabular-nums">{o.unidades}</td>
                    <td className="text-right whitespace-nowrap tabular-nums">{o.sinPrecio ? <span className="text-on-surface-variant">Sin precio</span> : fmt(o.empaqueUsd)}</td>
                    <td className="text-right whitespace-nowrap tabular-nums">{o.sinPrecio ? '—' : fmtUnidad(o.unitUsd)}</td>
                    <td className="text-right whitespace-nowrap">
                      {o.sinPrecio || o.tipo === 'propio' || tuPrecio == null ? '—' : <Diferencia valor={(tuPrecio / o.priceUsd - 1) * 100} />}
                    </td>
                    <td className="text-right whitespace-nowrap">{o.cambio != null && Math.abs(o.cambio) > UMBRAL_CAMBIO ? <Diferencia valor={o.cambio} /> : <span className="text-on-surface-variant">Sin cambio</span>}</td>
                    <td className="whitespace-nowrap m3-body-small text-on-surface-variant" title={o.fecha ? fechaHora(o.fecha) : ''}>{o.fecha ? haceCuanto(o.fecha) : 'Nunca'}</td>
                    <td className="m3-sticky-actions">
                      {o.url && (
                        <a href={o.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir en la tienda" aria-label={`Abrir ${o.marca} en ${nombreCadena(o.cadena)}`}>
                          <span className="material-symbols-outlined">open_in_new</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {ofertas.length === 0 && (
                  <tr><td colSpan={9} className="text-center text-on-surface-variant py-8">Este producto no tiene enlaces. Vincúlalos en Competencia.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {ajuste && (
            <p className="m3-body-small text-on-surface-variant px-4 py-3 border-t border-outline-variant flex flex-wrap items-center gap-2">
              Para quedar en tu meta ({textoMeta(meta)}, se cambia en el Dashboard) el precio sería {fmtModo(ajuste.objetivo)}:
              <AjusteMeta ajuste={ajuste} fmt={fmtModo} />
            </p>
          )}
        </section>

        {/* Historia */}
        <section className="m3-dash-card" aria-label="Historia de precios">
          <header className="m3-dash-card-header">
            <div className="min-w-0">
              <h2 className="m3-title-medium text-on-surface">Historia de precios</h2>
              <p className="m3-body-small text-on-surface-variant">
                En dólares, cada día a la tasa de ese día{porUnidad ? ' y por unidad' : ''}. Si un día no hubo lectura se toma el último precio de la semana.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
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
            <div className="h-56 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined text-3xl" aria-hidden="true">show_chart</span>
              <span className="m3-body-medium">Aún no hay historia de precios para este producto en este periodo.</span>
            </div>
          ) : (
            <div className={`h-80 ${historia.cargando ? 'opacity-60' : ''}`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={serieHistoria.puntos} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                  <XAxis dataKey="fecha" tickFormatter={diaCorto} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={{ stroke: tg.rejilla }} minTickGap={28} />
                  <YAxis tickFormatter={v => fmtModo(v)} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={false} width={72} domain={['auto', 'auto']} />
                  <Tooltip content={<TooltipHistoria fmt={fmtModo} />} cursor={{ stroke: tg.eje, strokeOpacity: 0.3 }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} formatter={v => <span style={{ color: tg.eje }}>{v}</span>} />
                  {vistaHistoria === 'resumen' ? (
                    [
                      <Line key="tuyo" type="monotone" dataKey="tuyo" name="Tu precio" stroke={colorCategorico(0)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />,
                      <Line key="minimo" type="monotone" dataKey="minimo" name="Mínimo de la competencia" stroke={colorCategorico(1)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />,
                      <Line key="promedio" type="monotone" dataKey="promedio" name="Promedio de la competencia" stroke={colorCategorico(2)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />,
                    ]
                  ) : (
                    serieHistoria.lineas.map(l => (
                      <Line key={l.clave} type="monotone" dataKey={l.clave} name={l.nombre} stroke={l.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    ))
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {vistaHistoria === 'ofertas' && serieHistoria.ocultas > 0 && (
            <p className="m3-body-small text-on-surface-variant mt-2">Se muestran {MAX_SERIES} ofertas; {serieHistoria.ocultas} más no caben en el gráfico.</p>
          )}
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
      <div className="font-medium">{new Date(`${label}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      {payload.filter(p => p.value != null).sort((a, b) => a.value - b.value).map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <i className="inline-block w-3 h-0.5 shrink-0" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="tabular-nums font-medium">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
