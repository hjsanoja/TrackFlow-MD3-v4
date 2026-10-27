import { useEffect, useMemo, useRef, useState } from 'react';
import BarraFiltros from './BarraFiltros';
import Segmentado from './Segmentado';
import StatCard from './StatCard';
import FiltroChip from './FiltroChip';
import Select from './Select';
import CadenaBadge from './CadenaBadge';
import InfoGrafico from './InfoGrafico';
import ProductDetailModal from './ProductDetailModal';
import { normalizar } from './formulario';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { useAnalisisPrecios } from '../hooks/useAnalisisPrecios';
import { usePreferenciaGuardada } from '../hooks/usePreferenciaGuardada';
import { exportarExcel } from '../utils/exportarExcel';
import { describirPresentacion } from '../utils/presentacion';
import { crearFormato, pct, mediana, GRUPOS, grupoDe } from './dashboard/comun';
import { AYUDA_OFERTA, textoPromo } from '../utils/promociones';

// Margen por cadena: tu PVP (el precio al que le vendes a la cadena) frente
// al precio al que la cadena lo vende, y ese precio frente a los laboratorios
// que elijas en la misma cadena.
//   - Precio teorico = PVP x factor (1,5 = la cadena le suma 50 %). El factor
//     es general y se puede cambiar por producto.
//   - Margen real = precio en la cadena / PVP - 1.
//   - GAP = precio del competidor / tu precio en la cadena - 1 (negativo: el
//     competidor esta mas barato).
// Todo se calcula en dolares a la tasa del dia; el PVP se carga en dolares.
// Cada usuario guarda lo que elige (cadena, factor, laboratorios...) en
// preferencias_usuario (fase 52).

const MAX_LABS = 9;
const DIAS_VIEJO = 3;
const INICIAL = {
  cadena: null, factor: 1.5, factores: {}, labs: null, moneda: 'bs', precio: 'lista', vista: 'labs',
};

// Colores del GAP, leidos desde tu lado: rojo = el competidor esta mas barato.
const TRAMOS_GAP = [
  { id: 'muy_caro', corto: 'Competidor 15 % o más barato', hasta: -15 },
  { id: 'caro', corto: '5 a 15 % más barato', hasta: -5 },
  { id: 'parejo', corto: 'Parejo (±5 %)', hasta: 5 },
  { id: 'barato', corto: '5 a 15 % más caro', hasta: 15 },
  { id: 'muy_barato', corto: 'Competidor 15 % o más caro', hasta: Infinity },
];
const tramoGap = (gap) => TRAMOS_GAP.find(t => gap < t.hasta) || TRAMOS_GAP[4];

// Margen real frente al teorico: rojo = la cadena lo vende por encima del
// factor (te encarece); azul = por debajo.
const TEXTO_VS_TEORICO = { muy_barato: 'muy por debajo del teórico', barato: 'por debajo del teórico', parejo: 'en el teórico (±5 %)', caro: 'por encima del teórico', muy_caro: 'muy por encima del teórico' };

const clave = (v) => normalizar(String(v || '')).trim();
const textoMargen = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('es-VE')} %`);
const textoFactor = (f) => `×${Number(f).toLocaleString('es-VE', { maximumFractionDigits: 2 })}`;
const diasDesde = (fecha) => (fecha ? (Date.now() - new Date(fecha).getTime()) / 86400000 : null);
const fechaCorta = (fecha) => (fecha ? new Date(fecha).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' }) : '');
const menor = (lista) => lista.reduce((a, b) => (!a || b.priceUsd < a.priceUsd ? b : a), null);

export default function MargenPorCadena() {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [], loadingInitial: loading } = useData();
  const bcv = useBcvRate();
  const [pref, cambiarPref] = usePreferenciaGuardada('margen_cadena', INICIAL);
  const { moneda, precio: modoPrecio, vista } = pref;
  // Siempre por unidad (tableta, ml o g): cajas de distinto tamano se comparan bien.
  const modoAnalisis = 'unidosis';
  const factorGeneral = Number(pref.factor) > 0 ? Number(pref.factor) : 1.5;

  const [filtroUnidad, setFiltroUnidad] = useState('todos');
  const [mostrar, setMostrar] = useState('todos'); // todos | pierdo | encarece | sin_precio
  const [search, setSearch] = useState('');
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });
  const [paginaActual, setPaginaActual] = useState(1);
  const [itemsPorPagina, setItemsPorPagina] = useState(25);
  const [editando, setEditando] = useState(null);
  const [ficha, setFicha] = useState(null);

  const { analizados, nombreCadena, idCadena } = useAnalisisPrecios({
    productos, productosCompetencia, cadenas, variaciones, tasa: bcv.rate, modoPrecio, modoAnalisis,
  });
  const { fmt, fmtUnidad } = crearFormato(moneda, bcv.rate);
  const fmtModo = modoAnalisis === 'unidosis' ? fmtUnidad : fmt;

  const claveUnidad = (p) => (p.unidad_negocio || 'La Sante').toLowerCase().replace(/\s/g, '');
  const unidadesNegocio = useMemo(() => {
    const m = new Map();
    productos.forEach(p => m.set(claveUnidad(p), p.unidad_negocio || 'La Sante'));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [productos]);

  // Cadenas donde tienes al menos un precio leido; la elegida por defecto es
  // la que tiene mas.
  const cadenasConPrecio = useMemo(() => {
    const n = new Map();
    for (const x of analizados) {
      for (const c of new Set(x.precios.filter(o => o.tipo === 'propio').map(o => o.cadena))) n.set(c, (n.get(c) || 0) + 1);
    }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([id, total]) => ({ id, total }));
  }, [analizados]);
  const cadena = cadenasConPrecio.some(c => c.id === pref.cadena) ? pref.cadena : cadenasConPrecio[0]?.id || null;

  // Laboratorios con precio del robot en la cadena elegida (productos distintos).
  const labsCadena = useMemo(() => {
    const m = new Map();
    for (const x of analizados) {
      const vistos = new Set();
      for (const o of x.precios) {
        if (o.tipo === 'propio' || o.cadena !== cadena || !o.laboratorio) continue;
        const k = clave(o.laboratorio);
        if (vistos.has(k)) continue;
        vistos.add(k);
        const previo = m.get(k) || { clave: k, nombre: o.laboratorio, total: 0 };
        previo.total += 1;
        m.set(k, previo);
      }
    }
    return [...m.values()].sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre));
  }, [analizados, cadena]);
  // Los elegidos que tienen precio en esta cadena, en el orden en que se eligieron.
  const labsElegidos = useMemo(() => {
    const disponibles = new Map(labsCadena.map(l => [l.clave, l]));
    // Sin eleccion guardada: los 3 con mas productos en la cadena.
    if (!Array.isArray(pref.labs)) return labsCadena.slice(0, 3);
    return pref.labs.map(clave).filter(k => disponibles.has(k)).map(k => disponibles.get(k)).slice(0, MAX_LABS);
  }, [labsCadena, pref.labs]);
  const labsFuera = (pref.labs || []).filter(l => !labsCadena.some(x => x.clave === clave(l)));

  // Una fila por producto: PVP, teorico, tu precio en la cadena y cada laboratorio.
  const base = useMemo(() => analizados
    .filter(({ producto: p }) =>
      filtroUnidad === 'todos' || claveUnidad(p) === filtroUnidad)
    .map(x => {
      const p = x.producto;
      const pvp = Number(p.pvp_propio_usd) > 0 ? Number(p.pvp_propio_usd) / (modoAnalisis === 'unidosis' ? x.unidadesPropio : 1) : null;
      const f = Number(pref.factores?.[p.id_interno]) > 0 ? Number(pref.factores[p.id_interno]) : factorGeneral;
      const teorico = pvp != null ? pvp * f : null;
      const enlacesEn = (cad, lab) => x.competencia.filter(c => idCadena(c.cadena) === cad
        && (lab == null ? String(c.tipo || '').toLowerCase() === 'propio' : String(c.tipo || '').toLowerCase() !== 'propio' && clave(c.laboratorio || c.marca) === lab));

      const enCadena = (cad) => {
        const real = menor(x.precios.filter(o => o.tipo === 'propio' && o.cadena === cad));
        const margen = real && pvp ? (real.priceUsd / pvp - 1) * 100 : null;
        const vsTeorico = real && teorico ? (real.priceUsd / teorico - 1) * 100 : null;
        const motivo = real ? null : enlacesEn(cad, null).length ? 'Tu enlace no tiene precio leído hoy' : 'No tienes enlace en esta cadena';
        return { real, margen, vsTeorico, motivo };
      };
      const propio = enCadena(cadena);
      const porCadena = vista === 'cadenas' ? new Map(cadenasConPrecio.map(c => [c.id, enCadena(c.id)])) : null;

      const labs = new Map(labsElegidos.map(l => {
        const comp = menor(x.precios.filter(o => o.tipo !== 'propio' && o.cadena === cadena && clave(o.laboratorio) === l.clave));
        const gap = comp && propio.real ? (comp.priceUsd / propio.real.priceUsd - 1) * 100 : null;
        const motivo = comp ? (propio.real ? null : 'Sin tu precio en la cadena para comparar')
          : enlacesEn(cadena, l.clave).length ? `El enlace de ${l.nombre} no tiene precio leído hoy` : `${l.nombre} no tiene este producto enlazado aquí`;
        return [l.clave, { comp, gap, motivo }];
      }));
      const gaps = [...labs.values()].map(v => v.gap).filter(v => v != null);
      return {
        ...x, pvp, factor: f, factorPropio: f !== factorGeneral, teorico, ...propio, porCadena, labs,
        peorGap: gaps.length ? Math.min(...gaps) : null,
      };
    }), [analizados, filtroUnidad, modoAnalisis, pref.factores, factorGeneral, cadena, vista, cadenasConPrecio, labsElegidos, idCadena]);

  const conPvp = useMemo(() => base.filter(x => x.pvp != null), [base]);
  const resumen = useMemo(() => {
    const conPrecio = conPvp.filter(x => x.real);
    const fechas = conPrecio.map(x => x.real.fecha).filter(Boolean).sort();
    return {
      conPrecio: conPrecio.length,
      margenTipico: mediana(conPrecio.map(x => x.margen)),
      encarece: conPrecio.filter(x => x.vsTeorico > 5).length,
      pierdo: conPrecio.filter(x => x.peorGap != null && x.peorGap < -0.5).length,
      ultimaFecha: fechas.at(-1) || null,
      viejos: conPrecio.filter(x => diasDesde(x.real.fecha) > DIAS_VIEJO).length,
    };
  }, [conPvp]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = conPvp.filter(x =>
      (mostrar === 'todos'
        || (mostrar === 'pierdo' && x.peorGap != null && x.peorGap < -0.5)
        || (mostrar === 'encarece' && x.vsTeorico > 5)
        || (mostrar === 'sin_precio' && !x.real)) &&
      (!term || normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)));
    const signo = orden.dir === 'asc' ? 1 : -1;
    const valor = (x) => {
      if (orden.campo === 'pvp') return x.pvp;
      if (orden.campo === 'margen') return x.margen;
      if (orden.campo === 'peor') return x.peorGap;
      if (orden.campo.startsWith('lab:')) return x.labs.get(orden.campo.slice(4))?.gap ?? null;
      if (orden.campo.startsWith('cad:')) return x.porCadena?.get(orden.campo.slice(4))?.margen ?? null;
      return null;
    };
    return lista.sort((a, b) => {
      if (orden.campo === 'nombre') return (a.producto.nombre || '').localeCompare(b.producto.nombre || '', 'es', { sensitivity: 'base' }) * signo;
      const va = valor(a);
      const vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * signo;
    });
  }, [conPvp, search, mostrar, orden]);

  // Fila de promedios al pie (de las filas filtradas).
  const promedios = useMemo(() => {
    const prom = (vals) => { const v = vals.filter(n => n != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return {
      margen: prom(filas.map(x => x.margen)),
      teorico: prom(filas.map(x => (x.factor - 1) * 100)),
      labs: new Map(labsElegidos.map(l => [l.clave, prom(filas.map(x => x.labs.get(l.clave)?.gap))])),
      cadenas: new Map(cadenasConPrecio.map(c => [c.id, prom(filas.map(x => x.porCadena?.get(c.id)?.margen))])),
    };
  }, [filas, labsElegidos, cadenasConPrecio]);

  useEffect(() => { setPaginaActual(1); }, [search, mostrar, filtroUnidad, orden, itemsPorPagina, cadena]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);
  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));
  const abrirFicha = (x) => setFicha({ producto: x.producto, competencia: x.competencia });

  const cambiarFactorProducto = (id, valor) => {
    const factores = { ...(pref.factores || {}) };
    if (valor == null || !(valor > 0) || Math.abs(valor - factorGeneral) < 0.0001) delete factores[id];
    else factores[id] = valor;
    cambiarPref({ factores });
  };
  const factoresPropios = Object.keys(pref.factores || {}).length;

  const [exportando, setExportando] = useState(false);
  const exportar = async () => {
    if (!filas.length || exportando) return;
    const tasa = bcv.rate || 0;
    const precio = (usd) => (usd == null ? null : moneda === 'usd' ? usd : usd * tasa);
    const celdaPrecio = (o, color, nota) => ({ v: precio(o?.priceUsd), formato: 'moneda', color, nota });
    const producto = (x) => ({ v: `${x.producto.nombre}\n${x.producto.id_interno}`, formato: 'texto' });
    const base = [
      { titulo: 'Producto', columnas: [{ ancho: 34 }] },
      { titulo: 'PVP', columnas: [{ ancho: 13 }] },
      { titulo: 'Teórico', columnas: [{ titulo: 'Precio', ancho: 13 }, { titulo: 'Margen', ancho: 9 }] },
    ];
    const inicio = (x) => [
      producto(x),
      { v: precio(x.pvp), formato: 'moneda' },
      { v: precio(x.teorico), formato: 'moneda', nota: x.factorPropio ? `Factor propio ${textoFactor(x.factor)}` : null },
      { v: (x.factor - 1) * 100, formato: 'pct' },
    ];
    const conColor = (v, grupo) => (v.real ? grupo : null);
    let grupos;
    let filasExcel;
    let pie;
    let leyenda;
    if (vista === 'cadenas') {
      grupos = [...base, ...cadenasConPrecio.map(c => ({ titulo: nombreCadena(c.id), columnas: [{ titulo: 'Precio', ancho: 13 }, { titulo: 'Margen', ancho: 9 }] }))];
      filasExcel = filas.map(x => [...inicio(x), ...cadenasConPrecio.flatMap(c => {
        const v = x.porCadena.get(c.id);
        const color = conColor(v, v.vsTeorico != null ? grupoDe(v.vsTeorico).id : null);
        return [celdaPrecio(v.real, color, v.motivo), { v: v.margen, formato: 'pct', color }];
      })]);
      pie = [{ v: `Promedio (${filas.length} productos)`, formato: 'texto' }, null, null, { v: promedios.teorico, formato: 'pct' },
        ...cadenasConPrecio.flatMap(c => [null, { v: promedios.cadenas.get(c.id), formato: 'pct' }])];
      leyenda = GRUPOS.map(g => ({ color: g.id, texto: `Margen real ${TEXTO_VS_TEORICO[g.id]}` }));
    } else {
      grupos = [...base,
        { titulo: nombreSel, columnas: [{ titulo: 'Precio', ancho: 13 }, { titulo: 'Margen', ancho: 9 }] },
        ...labsElegidos.map(l => ({ titulo: l.nombre, columnas: [{ titulo: 'Precio', ancho: 13 }, { titulo: 'GAP', ancho: 9 }] }))];
      filasExcel = filas.map(x => {
        const colorPropio = conColor(x, x.vsTeorico != null ? grupoDe(x.vsTeorico).id : null);
        return [...inicio(x),
          celdaPrecio(x.real, colorPropio, x.motivo), { v: x.margen, formato: 'pct', color: colorPropio },
          ...labsElegidos.flatMap(l => {
            const v = x.labs.get(l.clave);
            const color = v?.gap != null ? tramoGap(v.gap).id : null;
            return [celdaPrecio(v?.comp, color, v?.motivo), { v: v?.gap, formato: 'pct', color }];
          })];
      });
      pie = [{ v: `Promedio (${filas.length} productos)`, formato: 'texto' }, null, null, { v: promedios.teorico, formato: 'pct' },
        null, { v: promedios.margen, formato: 'pct' }, ...labsElegidos.flatMap(l => [null, { v: promedios.labs.get(l.clave), formato: 'pct' }])];
      leyenda = TRAMOS_GAP.map(g => ({ color: g.id, texto: `GAP: ${g.corto}` }));
    }
    const detalle = [
      `${vista === 'cadenas' ? 'Todas las cadenas' : `Cadena: ${nombreSel}`} · Factor ${textoFactor(factorGeneral)} (${textoMargen((factorGeneral - 1) * 100)}) · Precio de ${modoPrecio === 'lista' ? 'lista' : 'oferta'} · Por unidad (tableta, ml o g) · ${moneda === 'usd' ? 'Dólares' : `Bolívares a tasa BCV ${tasa.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`}`,
      `Margen real = precio en la cadena ÷ PVP − 1${vista === 'cadenas' ? ' · El color compara el precio de la cadena con tu precio teórico' : ' · GAP = precio del competidor ÷ tu precio en la cadena − 1 (negativo: el competidor está más barato)'}${resumen.ultimaFecha ? ` · Precios al ${fechaCorta(resumen.ultimaFecha)}` : ''}`,
    ];
    setExportando(true);
    try {
      await exportarExcel({
        archivo: `margen_por_cadena_${vista === 'cadenas' ? 'todas' : nombreSel}`.replace(/\s+/g, '_').toLowerCase(),
        hoja: vista === 'cadenas' ? 'Cadenas' : nombreSel,
        titulo: `Margen por cadena · ${vista === 'cadenas' ? 'Todas las cadenas' : nombreSel}`,
        detalle, grupos, filas: filasExcel, pie, leyenda, moneda, decimales: moneda === 'usd' ? 3 : 2,
      });
    } finally {
      setExportando(false);
    }
  };

  if (loading && productos.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="h-96 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const sinPvp = base.length - conPvp.length;
  const hayFiltros = filtroUnidad !== 'todos' || mostrar !== 'todos';
  const nombreSel = cadena ? nombreCadena(cadena) : '—';

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="m3-body-medium text-on-surface-variant">
          {vista === 'cadenas'
            ? 'Cada columna es una cadena: tu precio ahí y el margen que le suma a tu PVP. El color compara ese precio con tu precio teórico.'
            : `Tu PVP, el precio que debería tener ${nombreSel} con tu factor, el precio real ahí y cuánto más barato o caro está cada laboratorio que elijas.`}
        </p>
        <button onClick={exportar} disabled={exportando || !filas.length} className="m3-btn-outline self-start md:self-auto" title="Descargar en Excel, con los colores y los filtros de la pantalla">
          <span className="material-symbols-outlined text-base">{exportando ? 'hourglass_top' : 'download'}</span>
          <span>{exportando ? 'Preparando…' : 'Exportar a Excel'}</span>
        </button>
      </div>

      <BarraFiltros
        limpiar={{ visible: hayFiltros, onClick: () => { setFiltroUnidad('todos'); setMostrar('todos'); } }}
        etiqueta="Filtros de margen por cadena"
        filtrar={(
          <>
            <Select value={cadena || ''} onChange={e => cambiarPref({ cadena: e.target.value })} aria-label="Cadena que analizas"
              className="m3-filter-chip is-active" leadingIcon="storefront">
              {cadenasConPrecio.map(c => <option key={c.id} value={c.id}>{nombreCadena(c.id)}</option>)}
            </Select>
            {vista !== 'cadenas' && (
              <SelectorLabs disponibles={labsCadena} elegidos={labsElegidos} cadena={nombreSel}
                onChange={(lista) => cambiarPref({ labs: lista.map(l => l.nombre) })} />
            )}
            <FiltroChip etiqueta="Qué productos mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
              opciones={[['todos', 'Mostrar: todos'], ['pierdo', 'Algún competidor más barato'], ['encarece', 'La cadena me encarece (+5 %)'], ['sin_precio', 'Sin mi precio en la cadena']]} />
            <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad} opciones={[['todos', 'Unidad: todas'], ...unidadesNegocio]} />
          </>
        )}
        comparar={(
          <>
            <FactorGeneral valor={factorGeneral} onChange={v => cambiarPref({ factor: v })} propios={factoresPropios}
              onQuitarPropios={() => cambiarPref({ factores: {} })} />
            <Segmentado etiqueta="Qué ver" rotulo="Ver" valor={vista} onChange={v => cambiarPref({ vista: v })}
              opciones={[['labs', 'Competidores', 'Una cadena frente a los laboratorios que elijas'], ['cadenas', 'Cadenas', 'Tu precio y tu margen en todas las cadenas a la vez']]} />
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={modoPrecio} onChange={v => cambiarPref({ precio: v })}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', AYUDA_OFERTA]]} />
            <Segmentado etiqueta="Moneda" rotulo="Moneda" valor={moneda} onChange={v => cambiarPref({ moneda: v })}
              opciones={[['bs', 'Bs', 'Bolívares a la tasa BCV de hoy'], ['usd', '$', 'Dólares']]} />
          </>
        )}
      />

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Indicadores">
        <StatCard compacto label={`Con tu precio en ${nombreSel}`} value={`${resumen.conPrecio} de ${conPvp.length}`} icon="inventory_2" tono="neutral"
          hint={sinPvp ? `${sinPvp} productos sin PVP cargado no salen` : 'Productos con PVP cargado'}
          onClick={() => setMostrar(mostrar === 'sin_precio' ? 'todos' : 'sin_precio')} />
        <StatCard compacto label="Margen real típico" value={textoMargen(resumen.margenTipico)} icon="percent"
          tono={resumen.margenTipico == null ? 'neutral' : resumen.margenTipico > (factorGeneral - 1) * 100 + 5 ? 'negative' : 'primary'}
          hint={`Teórico: ${textoMargen((factorGeneral - 1) * 100)} (${textoFactor(factorGeneral)}) · mediana`} />
        <StatCard compacto label="Te encarece la cadena" value={resumen.encarece} icon="north" tono={resumen.encarece ? 'negative' : 'neutral'}
          hint="Precio real más de 5 % sobre el teórico" onClick={() => setMostrar(mostrar === 'encarece' ? 'todos' : 'encarece')} />
        <StatCard compacto label="Algún competidor más barato" value={resumen.pierdo} icon="trending_down" tono={resumen.pierdo ? 'warning' : 'neutral'}
          hint={labsElegidos.length ? `Entre ${labsElegidos.length} laboratorio${labsElegidos.length === 1 ? '' : 's'} elegido${labsElegidos.length === 1 ? '' : 's'}` : 'Elige laboratorios'}
          onClick={() => setMostrar(mostrar === 'pierdo' ? 'todos' : 'pierdo')} />
      </section>

      <section className="m3-data-table" aria-label="Margen por cadena">
        <div className="m3-data-table-toolbar">
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
            <div className="m3-calor-leyenda" aria-label="Leyenda de colores">
              {vista === 'cadenas'
                ? GRUPOS.map(g => <span key={g.id}><i className={`m3-calor-${g.id}`} />{TEXTO_VS_TEORICO[g.id]}</span>)
                : TRAMOS_GAP.map(g => <span key={g.id}><i className={`m3-calor-${g.id}`} />{g.corto}</span>)}
            </div>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">
                {filas.length === conPvp.length ? `${conPvp.length} productos` : `${filas.length} de ${conPvp.length} productos`}
              </span>
              <InfoGrafico alinear="derecha" titulo="Margen por cadena"
                ejemplo="Clopi 75 x 30: PVP 5.604 Bs × 1,5 = teórico 8.406 Bs. Farmatodo lo vende a 7.967 Bs: margen real 42 %. Genven está a 6.525 Bs: GAP −18 % (18 % más barato que tú ahí)."
                que="Cuánto le suma cada cadena a tu PVP y cómo queda tu precio ahí frente a los laboratorios que elijas."
                formula={[
                  'Precio teórico = PVP × factor (1,5 = 50 % de margen)',
                  'Margen real = precio en la cadena ÷ PVP − 1',
                  'GAP = precio del competidor ÷ tu precio en la cadena − 1',
                ]}
                lectura="Un GAP negativo (rojo) es un competidor más barato que tú en esa cadena. Un margen real por encima del teórico (rojo en la vista Cadenas) es una cadena que te encarece. «—» siempre explica por qué falta al pasar el mouse." />
            </div>
          </div>
          {(resumen.ultimaFecha || labsFuera.length > 0) && vista !== 'cadenas' && (
            <p className="m3-body-small text-on-surface-variant mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {resumen.ultimaFecha && (
                <span className="inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-base" aria-hidden="true">event</span>
                  Precios de {nombreSel} al {fechaCorta(resumen.ultimaFecha)}
                  {resumen.viejos > 0 && ` · ${resumen.viejos} con más de ${DIAS_VIEJO} días (marcados con reloj)`}
                </span>
              )}
              {labsFuera.length > 0 && <span>Sin precio en {nombreSel}: {labsFuera.join(', ')}</span>}
            </p>
          )}
        </div>

        {filas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">search_off</span>
            <div className="m3-title-medium text-on-surface">{conPvp.length ? 'Ningún producto coincide' : 'Aún no hay productos con PVP cargado'}</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Productos">
              {filasPagina.map(x => (
                <li key={x.producto.id_interno}>
                  <button type="button" onClick={() => abrirFicha(x)} className="w-full text-left px-4 py-3 space-y-2">
                    <div className="m3-cell-primary">{x.producto.nombre}</div>
                    <div className="m3-body-small text-on-surface-variant">
                      PVP {fmtModo(x.pvp)} · teórico {fmtModo(x.teorico)} ({textoFactor(x.factor)})
                    </div>
                    {vista === 'cadenas' ? (
                      <div className="flex flex-wrap gap-1.5">
                        {cadenasConPrecio.filter(c => x.porCadena.get(c.id)?.real).map(c => {
                          const v = x.porCadena.get(c.id);
                          return (
                            <span key={c.id} className={`m3-calor-chip m3-calor-${grupoDe(v.vsTeorico ?? 0).id}`}>
                              <CadenaBadge cadena={c.id} tamano="xs" title="" />{fmtModo(v.real.priceUsd)} · {textoMargen(v.margen)}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <>
                        <div className="m3-body-medium">
                          {nombreSel}: {x.real ? <><b className="tabular-nums">{fmtModo(x.real.priceUsd)}</b> · margen {textoMargen(x.margen)}</> : <span className="text-on-surface-variant">{x.motivo}</span>}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {labsElegidos.filter(l => x.labs.get(l.clave)?.comp).map(l => {
                            const v = x.labs.get(l.clave);
                            return (
                              <span key={l.clave} className={`m3-calor-chip ${v.gap != null ? `m3-calor-${tramoGap(v.gap).id}` : ''}`}>
                                {l.nombre} {fmtModo(v.comp.priceUsd)}{v.gap != null && ` · ${pct(v.gap, 0)}`}
                              </span>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-x-auto">
              <table className="m3-table m3-table-calor m3-table-margen">
                <thead className="m3-sticky-header">
                  <tr>
                    <th className="m3-dash-col-producto"><Orden campo="nombre" orden={orden} onClick={ordenarPor}>Producto</Orden></th>
                    <th className="text-right"><Orden campo="pvp" orden={orden} onClick={ordenarPor}>PVP</Orden></th>
                    <th className="text-right m3-dash-col-sep" title="PVP × factor">Teórico</th>
                    {vista === 'cadenas' ? cadenasConPrecio.map(c => (
                      <th key={c.id} className="text-center m3-dash-col-sep">
                        <Orden campo={`cad:${c.id}`} orden={orden} onClick={ordenarPor}>
                          <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={c.id} tamano="xs" title="" />{nombreCadena(c.id)}</span>
                        </Orden>
                      </th>
                    )) : (
                      <>
                        <th className="text-center m3-dash-col-sep m3-margen-col-cadena">
                          <Orden campo="margen" orden={orden} onClick={ordenarPor}>
                            <span className="inline-flex items-center gap-1.5">{cadena && <CadenaBadge cadena={cadena} tamano="xs" title="" />}{nombreSel}</span>
                          </Orden>
                        </th>
                        {labsElegidos.map(l => (
                          <th key={l.clave} className="text-center m3-dash-col-sep">
                            <Orden campo={`lab:${l.clave}`} orden={orden} onClick={ordenarPor}>{l.nombre}</Orden>
                          </th>
                        ))}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filasPagina.map(x => (
                    <tr key={x.producto.id_interno} onClick={() => abrirFicha(x)} className="cursor-pointer" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) abrirFicha(x); }}>
                      <td className="m3-dash-col-producto">
                        <div className="m3-cell-primary m3-cell-clamp" title={x.producto.nombre}>{x.producto.nombre}</div>
                        <div className="m3-cell-secondary">{[x.producto.id_interno, x.producto.concentracion, describirPresentacion(x.producto)].filter(v => v && v !== '—').join(' · ')}</div>
                      </td>
                      <td className="text-right tabular-nums whitespace-nowrap">{fmtModo(x.pvp)}</td>
                      <td className="text-right whitespace-nowrap m3-dash-col-sep" onClick={e => e.stopPropagation()}>
                        <CeldaTeorico fila={x} fmt={fmtModo} editando={editando === x.producto.id_interno}
                          onEditar={() => setEditando(x.producto.id_interno)} onCerrar={() => setEditando(null)}
                          onGuardar={(v) => { cambiarFactorProducto(x.producto.id_interno, v); setEditando(null); }} />
                      </td>
                      {vista === 'cadenas' ? cadenasConPrecio.map(c => {
                        const v = x.porCadena.get(c.id);
                        return <CeldaCadena key={c.id} v={v} fmt={fmtModo} nombre={nombreCadena(c.id)} />;
                      }) : (
                        <>
                          <CeldaCadena v={x} fmt={fmtModo} nombre={nombreSel} principal />
                          {labsElegidos.map(l => {
                            const v = x.labs.get(l.clave);
                            if (!v?.comp) return <td key={l.clave} className="text-center text-on-surface-variant m3-dash-col-sep" title={v?.motivo}>—</td>;
                            const viejo = diasDesde(v.comp.fecha) > DIAS_VIEJO;
                            return (
                              <td key={l.clave} className={`m3-calor-celda m3-dash-col-sep ${v.gap != null ? `m3-calor-${tramoGap(v.gap).id}` : ''}`}
                                title={`${l.nombre} en ${nombreSel}: ${fmtModo(v.comp.priceUsd)}${v.comp.marca ? ` (${v.comp.marca})` : ''}${v.comp.promo ? ` · ${textoPromo(v.comp.promo)}` : ''}${v.comp.fecha ? ` · leído el ${fechaCorta(v.comp.fecha)}` : ''}${v.motivo ? ` · ${v.motivo}` : ''}`}>
                                <div className="font-medium tabular-nums">{fmtModo(v.comp.priceUsd)}{viejo && <Reloj />}</div>
                                <div className="m3-calor-precio tabular-nums">{v.gap != null ? `GAP ${pct(v.gap, 0)}` : 'sin GAP'}</div>
                              </td>
                            );
                          })}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="m3-margen-promedio">
                    <td className="m3-dash-col-producto"><span className="m3-label-large">Promedio</span> <span className="m3-cell-secondary">({filas.length} productos)</span></td>
                    <td />
                    <td className="text-right tabular-nums m3-dash-col-sep">{textoMargen(promedios.teorico)}</td>
                    {vista === 'cadenas'
                      ? cadenasConPrecio.map(c => <td key={c.id} className="text-center tabular-nums m3-dash-col-sep">{textoMargen(promedios.cadenas.get(c.id))}</td>)
                      : (
                        <>
                          <td className="text-center tabular-nums m3-dash-col-sep">{textoMargen(promedios.margen)}</td>
                          {labsElegidos.map(l => <td key={l.clave} className="text-center tabular-nums m3-dash-col-sep">GAP {pct(promedios.labs.get(l.clave), 0)}</td>)}
                        </>
                      )}
                  </tr>
                </tfoot>
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

      {ficha && (
        <ProductDetailModal
          producto={ficha.producto}
          competencia={ficha.competencia}
          currency={moneda}
          bcvRate={bcv.rate}
          initialPriceMode={modoPrecio}
          initialAnalisisMode={modoAnalisis}
          onClose={() => setFicha(null)}
        />
      )}
    </div>
  );
}

function Reloj() {
  return <span className="material-symbols-outlined m3-margen-reloj" aria-label={`Precio de hace más de ${DIAS_VIEJO} días`}>schedule</span>;
}

// Tu precio en una cadena con su margen real; el color lo compara con el teorico.
function CeldaCadena({ v, fmt, nombre, principal = false }) {
  if (!v?.real) return <td className="text-center text-on-surface-variant m3-dash-col-sep" title={v?.motivo}>—</td>;
  const viejo = diasDesde(v.real.fecha) > DIAS_VIEJO;
  const grupo = v.vsTeorico != null ? grupoDe(v.vsTeorico) : null;
  return (
    <td className={`m3-calor-celda m3-dash-col-sep ${grupo ? `m3-calor-${grupo.id}` : ''} ${principal ? 'm3-margen-col-cadena' : ''}`}
      title={`Tu precio en ${nombre}: ${fmt(v.real.priceUsd)}${v.real.promo ? ` · ${textoPromo(v.real.promo)}` : ''} · margen real ${textoMargen(v.margen)}${grupo ? ` · ${TEXTO_VS_TEORICO[grupo.id]} (${pct(v.vsTeorico, 0)})` : ''}${v.real.fecha ? ` · leído el ${fechaCorta(v.real.fecha)}` : ''}`}>
      <div className="font-medium tabular-nums">{fmt(v.real.priceUsd)}{viejo && <Reloj />}</div>
      <div className="m3-calor-precio tabular-nums">Margen {textoMargen(v.margen)}</div>
    </td>
  );
}

// Precio teorico con su factor; el lapiz cambia el factor solo de ese producto.
function CeldaTeorico({ fila, fmt, editando, onEditar, onCerrar, onGuardar }) {
  const [texto, setTexto] = useState('');
  useEffect(() => { if (editando) setTexto(String(fila.factor).replace('.', ',')); }, [editando, fila.factor]);
  if (editando) {
    const guardar = () => { const v = Number(String(texto).replace(',', '.')); onGuardar(v > 0 ? v : null); };
    return (
      <form className="inline-flex items-center gap-1" onSubmit={e => { e.preventDefault(); guardar(); }}>
        <span className="m3-body-small text-on-surface-variant">×</span>
        <input autoFocus inputMode="decimal" value={texto} onChange={e => setTexto(e.target.value)} className="m3-input m3-margen-factor-input"
          aria-label={`Factor de ${fila.producto.nombre}`} onKeyDown={e => { if (e.key === 'Escape') onCerrar(); }} />
        <button type="submit" className="m3-icon-btn m3-icon-btn-sm" aria-label="Guardar factor"><span className="material-symbols-outlined">check</span></button>
        {fila.factorPropio && (
          <button type="button" className="m3-icon-btn m3-icon-btn-sm" onClick={() => onGuardar(null)} aria-label="Volver al factor general" title="Volver al factor general">
            <span className="material-symbols-outlined">restart_alt</span>
          </button>
        )}
      </form>
    );
  }
  return (
    <div className="inline-flex items-center gap-1 justify-end">
      <div>
        <div className="font-medium tabular-nums">{fmt(fila.teorico)}</div>
        <div className={`m3-calor-precio tabular-nums ${fila.factorPropio ? 'm3-margen-factor-propio' : ''}`} title={fila.factorPropio ? 'Factor propio de este producto' : 'Factor general'}>
          {textoFactor(fila.factor)} · {textoMargen((fila.factor - 1) * 100)}
        </div>
      </div>
      <button type="button" className="m3-icon-btn m3-icon-btn-sm m3-margen-editar" onClick={onEditar} aria-label={`Cambiar el factor de ${fila.producto.nombre}`} title="Cambiar el factor solo de este producto">
        <span className="material-symbols-outlined">edit</span>
      </button>
    </div>
  );
}

// Factor general (PVP x factor = precio teorico).
function FactorGeneral({ valor, onChange, propios, onQuitarPropios }) {
  const [texto, setTexto] = useState(String(valor).replace('.', ','));
  useEffect(() => { setTexto(String(valor).replace('.', ',')); }, [valor]);
  const aplicar = () => {
    const v = Number(String(texto).replace(',', '.'));
    if (v > 0 && v <= 10) onChange(Math.round(v * 1000) / 1000);
    else setTexto(String(valor).replace('.', ','));
  };
  return (
    <span className="m3-margen-factor" title="Precio teórico = PVP × factor. 1,5 = la cadena le suma 50 %">
      <span className="m3-segmentado-rotulo">Factor</span>
      <span aria-hidden="true">×</span>
      <input inputMode="decimal" value={texto} onChange={e => setTexto(e.target.value)} onBlur={aplicar}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} className="m3-input m3-margen-factor-input" aria-label="Factor general" />
      <span className="text-on-surface-variant">= {textoMargen((valor - 1) * 100)}</span>
      {propios > 0 && (
        <button type="button" className="m3-btn-text m3-margen-quitar" onClick={onQuitarPropios} title="Usar el factor general en todos los productos">
          {propios} propio{propios === 1 ? '' : 's'} · quitar
        </button>
      )}
    </span>
  );
}

// Elegir de 1 a 9 laboratorios con precio en la cadena; las columnas salen en
// el orden en que se eligen.
function SelectorLabs({ disponibles, elegidos, cadena, onChange }) {
  const [abierto, setAbierto] = useState(false);
  const [buscar, setBuscar] = useState('');
  const raiz = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!raiz.current?.contains(e.target)) setAbierto(false); };
    const tecla = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', tecla); };
  }, [abierto]);

  const marcados = new Set(elegidos.map(l => l.clave));
  const lleno = elegidos.length >= MAX_LABS;
  const term = normalizar(buscar);
  const lista = disponibles.filter(l => !term || normalizar(l.nombre).includes(term));
  const alternar = (l) => {
    if (marcados.has(l.clave)) onChange(elegidos.filter(x => x.clave !== l.clave));
    else if (!lleno) onChange([...elegidos, l]);
  };
  const resumen = elegidos.length === 0 ? 'Laboratorios: ninguno'
    : `${elegidos.slice(0, 2).map(l => l.nombre).join(', ')}${elegidos.length > 2 ? ` +${elegidos.length - 2}` : ''}`;

  return (
    <span ref={raiz} className="relative inline-flex">
      <button type="button" className={`m3-filter-chip ${elegidos.length ? 'is-active' : ''}`} onClick={() => setAbierto(a => !a)}
        aria-expanded={abierto} aria-haspopup="dialog" title="Laboratorios que comparas (de 1 a 9)">
        <span className="material-symbols-outlined" aria-hidden="true">science</span>
        <span>{resumen}</span>
        <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
      </button>
      {abierto && (
        <div className="m3-menu-panel m3-margen-labs" role="dialog" aria-label="Elegir laboratorios">
          <div className="px-4 pb-2 m3-body-small text-on-surface-variant">
            Con precio en {cadena} · {elegidos.length} de {MAX_LABS} elegidos
          </div>
          <div className="px-3 pb-2">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar laboratorio" aria-label="Buscar laboratorio" autoFocus />
            </label>
          </div>
          <ul className="m3-margen-labs-lista">
            {lista.map(l => {
              const activo = marcados.has(l.clave);
              const orden = elegidos.findIndex(x => x.clave === l.clave) + 1;
              return (
                <li key={l.clave}>
                  <label className={`m3-menu-item ${!activo && lleno ? 'opacity-40' : ''}`}>
                    <input type="checkbox" className="m3-checkbox" checked={activo} disabled={!activo && lleno} onChange={() => alternar(l)} />
                    <span className="flex-1 truncate">{l.nombre}</span>
                    <span className="m3-body-small text-on-surface-variant">{activo ? `#${orden}` : `${l.total} prod.`}</span>
                  </label>
                </li>
              );
            })}
            {lista.length === 0 && <li className="px-4 py-3 m3-body-small text-on-surface-variant">Ningún laboratorio con precio aquí</li>}
          </ul>
          {elegidos.length > 0 && (
            <div className="px-3 pt-2 flex justify-end">
              <button type="button" className="m3-btn-text" onClick={() => onChange([])}>Quitar todos</button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function Orden({ campo, orden, onClick, children }) {
  const activo = orden.campo === campo;
  return (
    <button type="button" onClick={() => onClick(campo)} className={`m3-sort-btn ${activo ? 'is-active' : ''}`}>
      {children}
      <span className="material-symbols-outlined" aria-hidden="true">{activo ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
    </button>
  );
}
