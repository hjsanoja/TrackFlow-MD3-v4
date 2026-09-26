import LimpiarFiltros from './LimpiarFiltros';
import { useEffect, useMemo, useState } from 'react';
import StatCard from './StatCard';
import FiltroChip from './FiltroChip';
import Select from './Select';
import CadenaBadge from './CadenaBadge';
import DetalleLista from './DetalleLista';
import ProductDetailModal from './ProductDetailModal';
import { normalizar } from './formulario';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { useAnalisisPrecios } from '../hooks/useAnalisisPrecios';
import { exportToCSV } from '../utils/exportUtils';
import { crearFormato, Diferencia, pct, usePreferencia, GRUPOS, grupoDe } from './dashboard/comun';

// Experimental: mapa por cadena. En que cadenas eres mas caro o mas barato. Cada celda compara
// tu precio con el precio mas bajo de la competencia EN ESA CADENA, con los
// mismos colores que "¿Donde esta tu precio?" del Dashboard: azul si eres mas
// barato, gris si estas parejo (±5 %), rojo si eres mas caro.

const POSICIONES = [
  ['todos', 'Posición: todas'],
  ['barato', 'Más baratos que el promedio'],
  ['parejo', 'Parejos (±5 %)'],
  ['caro', 'Más caros que el promedio'],
  ['sin_comparar', 'Sin comparar'],
];
const posicionDe = (x) => (!x.comparable || x.difProm == null ? 'sin_comparar' : x.difProm < -5 ? 'barato' : x.difProm > 5 ? 'caro' : 'parejo');

export default function MapaPorCadena() {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [], loadingInitial: loading } = useData();
  const bcv = useBcvRate();

  const [moneda, setMoneda] = usePreferencia('trackflow_pref_currency', 'usd', ['usd', 'bs']);
  const [modoAnalisis, setModoAnalisis] = usePreferencia('trackflow_pref_analisis_mode', 'empaque', ['empaque', 'unidosis']);
  const [modoPrecio, setModoPrecio] = usePreferencia('dashboard.precio', 'lista', ['lista', 'descuento']);
  const [filtroUnidad, setFiltroUnidad] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroCategoria, setFiltroCategoria] = useState('todos');
  const [filtroPosicion, setFiltroPosicion] = useState('todos');
  const [search, setSearch] = useState('');
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });
  const [paginaActual, setPaginaActual] = useState(1);
  const [itemsPorPagina, setItemsPorPagina] = usePreferencia('mapa.filas', 25, [10, 25, 50, 100]);
  const [detalle, setDetalle] = useState(null);
  const [ficha, setFicha] = useState(null);
  const [volverA, setVolverA] = useState(null);

  const { analizados, nombreCadena } = useAnalisisPrecios({
    productos, productosCompetencia, cadenas, variaciones, tasa: bcv.rate, modoPrecio, modoAnalisis,
  });
  const { fmt, fmtUnidad } = crearFormato(moneda, bcv.rate);
  const fmtModo = modoAnalisis === 'unidosis' ? fmtUnidad : fmt;

  const claveUnidad = (p) => (p.unidad_negocio || 'La Sante').toLowerCase().replace(/\s/g, '');
  const unidades = useMemo(() => {
    const m = new Map();
    productos.forEach(p => m.set(claveUnidad(p), p.unidad_negocio || 'La Sante'));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [productos]);
  const categorias = useMemo(() => [...new Set(productos.map(p => p.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [productos]);

  // Productos con algun precio (tuyo o de la competencia), segun los filtros.
  const base = useMemo(() => analizados.filter(({ producto: p, sinPrecio }) =>
    !sinPrecio &&
    (filtroUnidad === 'todos' || claveUnidad(p) === filtroUnidad) &&
    (filtroTipo === 'todos' || (p.market_type || 'GENERICO').toLowerCase() === filtroTipo) &&
    (filtroCategoria === 'todos' || p.categoria === filtroCategoria)
  ), [analizados, filtroUnidad, filtroTipo, filtroCategoria]);
  const hayFiltros = filtroUnidad !== 'todos' || filtroTipo !== 'todos' || filtroCategoria !== 'todos' || filtroPosicion !== 'todos';

  const porPosicion = useMemo(() => {
    const g = { barato: [], parejo: [], caro: [], sin_comparar: [] };
    for (const x of base) g[posicionDe(x)].push(x);
    return g;
  }, [base]);

  const cadenasTabla = useMemo(() => {
    const ids = new Map();
    for (const x of base) for (const c of x.porCadena.keys()) ids.set(c, (ids.get(c) || 0) + 1);
    return [...ids.entries()].sort((a, b) => nombreCadena(a[0]).localeCompare(nombreCadena(b[0]))).map(([id, n]) => ({ id, n }));
  }, [base, nombreCadena]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = base.filter(x =>
      (filtroPosicion === 'todos' || posicionDe(x) === filtroPosicion) &&
      (!term || normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)));
    const signo = orden.dir === 'asc' ? 1 : -1;
    return lista.sort((a, b) => {
      if (orden.campo === 'nombre') return (a.producto.nombre || '').localeCompare(b.producto.nombre || '', 'es', { sensitivity: 'base' }) * signo;
      const va = orden.campo === 'difProm' ? a.difProm : a.difMin;
      const vb = orden.campo === 'difProm' ? b.difProm : b.difMin;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * signo;
    });
  }, [base, search, filtroPosicion, orden]);

  useEffect(() => { setPaginaActual(1); }, [search, filtroPosicion, filtroUnidad, filtroTipo, filtroCategoria, orden, itemsPorPagina]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);
  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));

  const abrirFicha = (x, desde = null) => { setVolverA(desde); setDetalle(null); setFicha({ producto: x.producto, competencia: x.competencia }); };
  const cerrarFicha = () => { setFicha(null); if (volverA) { setDetalle(volverA); setVolverA(null); } };
  const colProducto = {
    titulo: 'Producto',
    celda: x => (
      <div className="min-w-0">
        <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={x.producto.nombre}>{x.producto.nombre}</div>
        <div className="m3-cell-secondary font-mono">{x.producto.id_interno}</div>
      </div>
    ),
  };
  const abrirGrupo = (clave, titulo, icono) => setDetalle({
    titulo,
    subtitulo: 'Tu precio frente al promedio de la competencia. Toca un producto para ver su ficha.',
    icono,
    filas: [...porPosicion[clave]].sort((a, b) => (a.difProm ?? 0) - (b.difProm ?? 0)),
    columnas: clave === 'sin_comparar'
      ? [colProducto, { titulo: 'Qué falta', celda: x => (x.tuPrecio == null ? 'Tu precio' : 'Precio de la competencia') }]
      : [colProducto,
        { titulo: 'Tu precio', alinear: 'right', celda: x => fmtModo(x.tuPrecio) },
        { titulo: 'Promedio', alinear: 'right', celda: x => fmtModo(x.promedio) },
        { titulo: 'Tú frente al promedio', alinear: 'right', celda: x => <Diferencia valor={x.difProm} /> }],
    posicion: clave,
  });

  const exportar = () => {
    const suf = moneda === 'usd' ? 'USD' : 'Bs';
    const valor = (usd) => (usd == null ? '' : moneda === 'usd' ? usd.toFixed(modoAnalisis === 'unidosis' ? 4 : 2) : (usd * (bcv.rate || 0)).toFixed(2));
    const cols = [
      { key: 'id', label: 'ID' }, { key: 'producto', label: 'Producto' },
      { key: 'tu', label: `Tu precio (${suf})` }, { key: 'min', label: `Mínimo competencia (${suf})` },
      { key: 'prom', label: `Promedio competencia (${suf})` }, { key: 'max', label: `Máximo competencia (${suf})` },
      { key: 'difProm', label: 'Tú frente al promedio (%)' },
      ...cadenasTabla.map(c => ({ key: `c_${c.id}`, label: `Frente a ${nombreCadena(c.id)} (%)` })),
    ];
    const datos = filas.map(x => {
      const precios = [...x.porCadena.values()].map(p => p.priceUsd);
      return {
        id: x.producto.id_interno, producto: x.producto.nombre,
        tu: valor(x.tuPrecio), min: valor(x.minimo), prom: valor(x.promedio), max: valor(precios.length ? Math.max(...precios) : null),
        difProm: x.difProm == null ? '' : x.difProm.toFixed(1),
        ...Object.fromEntries(cadenasTabla.map(c => {
          const p = x.porCadena.get(c.id);
          return [`c_${c.id}`, p && x.tuPrecio != null ? ((x.tuPrecio / p.priceUsd - 1) * 100).toFixed(1) : ''];
        })),
      };
    });
    if (datos.length) exportToCSV(`mapa_de_calor_por_cadena${modoAnalisis === 'unidosis' ? '_por_unidad' : ''}`, cols, datos);
  };

  if (loading && productos.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">{[1, 2, 3, 4].map(n => <div key={n} className="h-28 rounded-2xl m3-skeleton" />)}</div>
        <div className="h-96 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const comparables = base.length - porPosicion.sin_comparar.length;

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="m3-body-medium text-on-surface-variant">Cada celda compara tu precio con el más bajo de la competencia en esa cadena: azul si eres más barato, gris si estás parejo (±5 %), rojo si eres más caro.</p>
        <button onClick={exportar} className="m3-btn-outline self-start md:self-auto" title="Descargar en CSV lo que se ve, con los filtros actuales">
          <span className="material-symbols-outlined text-base">download</span>
          <span>Exportar</span>
        </button>
      </div>

      <section className="m3-dash-filtros" aria-label="Filtros del mapa">
        <div className="flex flex-wrap items-center gap-2">
          <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad} opciones={[['todos', 'Unidad: todas'], ...unidades]} />
          <FiltroChip etiqueta="Tipo" icono="category" valor={filtroTipo} onChange={setFiltroTipo} opciones={[['todos', 'Tipo: todos'], ['generico', 'Genéricos'], ['marca', 'Marca']]} />
          <FiltroChip etiqueta="Categoría" icono="sell" valor={filtroCategoria} onChange={setFiltroCategoria} opciones={[['todos', 'Categoría: todas'], ...categorias.map(c => [c, c])]} />
          <FiltroChip etiqueta="Posición" icono="balance" valor={filtroPosicion} onChange={setFiltroPosicion} opciones={POSICIONES} />
          <LimpiarFiltros visible={hayFiltros} onClick={() => { setFiltroUnidad('todos'); setFiltroTipo('todos'); setFiltroCategoria('todos'); setFiltroPosicion('todos'); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Select value={modoPrecio} onChange={e => setModoPrecio(e.target.value)} aria-label="Precio que se compara" className="m3-filter-chip" leadingIcon="receipt_long">
            <option value="lista">Precio de lista</option>
            <option value="descuento">Precio con oferta</option>
          </Select>
          <Select value={modoAnalisis} onChange={e => setModoAnalisis(e.target.value)} aria-label="Comparar por" className="m3-filter-chip" leadingIcon="medication">
            <option value="empaque">Por empaque</option>
            <option value="unidosis">Por unidad (tableta, cápsula…)</option>
          </Select>
          <label className="m3-switch-label whitespace-nowrap ml-1">
            <span className={moneda === 'bs' ? 'text-on-surface-variant' : 'font-medium'}>$</span>
            <input type="checkbox" role="switch" checked={moneda === 'bs'} onChange={e => setMoneda(e.target.checked ? 'bs' : 'usd')} className="m3-switch" aria-label="Ver los precios en bolívares" />
            <span className={moneda === 'bs' ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
          </label>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-label="Indicadores">
        <StatCard label="Más baratos que el promedio" value={`${porPosicion.barato.length} de ${comparables}`} icon="south" tono="primary"
          hint="Tu precio más de 5 % bajo el promedio" onClick={() => abrirGrupo('barato', 'Más baratos que el promedio', 'south')} />
        <StatCard label="Parejos" value={`${porPosicion.parejo.length} de ${comparables}`} icon="drag_handle" tono="neutral"
          hint="Tu precio a ±5 % del promedio" onClick={() => abrirGrupo('parejo', 'Parejos con el promedio', 'drag_handle')} />
        <StatCard label="Más caros que el promedio" value={`${porPosicion.caro.length} de ${comparables}`} icon="north" tono={porPosicion.caro.length ? 'negative' : 'neutral'}
          hint="Tu precio más de 5 % sobre el promedio" onClick={() => abrirGrupo('caro', 'Más caros que el promedio', 'north')} />
        <StatCard label="Sin comparar" value={porPosicion.sin_comparar.length} icon="help" tono={porPosicion.sin_comparar.length ? 'warning' : 'neutral'}
          hint="Falta tu precio o el de la competencia" onClick={() => abrirGrupo('sin_comparar', 'Sin comparar', 'help')} />
      </section>

      <section className="m3-data-table" aria-label="Mapa de calor">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <p className="m3-body-small text-on-surface-variant flex-1">
                Toca una fila para ver la ficha del producto.
              </p>
              <div className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">
                {filas.length === base.length ? `${base.length} productos` : `${filas.length} de ${base.length} productos`}
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
              <div className="m3-calor-leyenda" aria-label="Leyenda de colores">
                {GRUPOS.map(g => <span key={g.id}><i className={`m3-calor-${g.id}`} />{g.corto}</span>)}
              </div>
            </div>
          </div>
        </div>

        {filas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">search_off</span>
            <div className="m3-title-medium text-on-surface">Ningún producto coincide</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Productos">
              {filasPagina.map(x => (
                <li key={x.producto.id_interno}>
                  <button type="button" onClick={() => abrirFicha(x)} className="w-full text-left px-4 py-3 space-y-2">
                    <div>
                      <div className="m3-cell-primary">{x.producto.nombre}</div>
                      <div className="m3-cell-secondary">Tu precio {fmtModo(x.tuPrecio)} · <Diferencia valor={x.difProm} /> frente al promedio</div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {cadenasTabla.filter(c => x.porCadena.has(c.id)).map(c => {
                        const dif = x.tuPrecio != null ? (x.tuPrecio / x.porCadena.get(c.id).priceUsd - 1) * 100 : null;
                        return (
                          <span key={c.id} className={`m3-calor-chip ${dif != null ? `m3-calor-${grupoDe(dif).id}` : ''}`}>
                            <CadenaBadge cadena={c.id} tamano="xs" title="" />{dif != null ? pct(dif, 0) : fmtModo(x.porCadena.get(c.id).priceUsd)}
                          </span>
                        );
                      })}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-x-auto">
                <table className="m3-table m3-table-calor">
                  <thead className="m3-sticky-header">
                    <tr>
                      <th className="m3-dash-col-producto"><Orden campo="nombre" orden={orden} onClick={ordenarPor}>Producto</Orden></th>
                      <th className="text-right">Tu precio</th>
                      {cadenasTabla.map(c => (
                        <th key={c.id} className="text-center">
                          <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={c.id} tamano="xs" title="" />{nombreCadena(c.id)}</span>
                        </th>
                      ))}
                      <th className="text-right m3-dash-col-sep"><Orden campo="difProm" orden={orden} onClick={ordenarPor}>Tú frente al promedio</Orden></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filasPagina.map(x => (
                      <tr key={x.producto.id_interno} onClick={() => abrirFicha(x)} className="cursor-pointer" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') abrirFicha(x); }}>
                        <td className="m3-dash-col-producto">
                          <div className="m3-cell-primary m3-cell-clamp" title={x.producto.nombre}>{x.producto.nombre}</div>
                          <div className="m3-cell-secondary font-mono">{x.producto.id_interno}</div>
                        </td>
                        <td className="text-right whitespace-nowrap tabular-nums font-medium">{fmtModo(x.tuPrecio)}</td>
                        {cadenasTabla.map(c => {
                          const p = x.porCadena.get(c.id);
                          if (!p) return <td key={c.id} className="text-center text-on-surface-variant">—</td>;
                          const dif = x.tuPrecio != null ? (x.tuPrecio / p.priceUsd - 1) * 100 : null;
                          return (
                            <td key={c.id} className={`m3-calor-celda ${dif != null ? `m3-calor-${grupoDe(dif).id}` : ''}`}
                              title={`${p.marca} en ${nombreCadena(c.id)}: ${fmtModo(p.priceUsd)}${x.tuPrecio != null ? ` · tu precio ${fmtModo(x.tuPrecio)}` : ''}`}>
                              <div className="font-medium tabular-nums">{dif != null ? pct(dif, 0) : '—'}</div>
                              <div className="m3-calor-precio tabular-nums">{fmtModo(p.priceUsd)}</div>
                            </td>
                          );
                        })}
                        <td className="text-right whitespace-nowrap m3-dash-col-sep"><Diferencia valor={x.difProm} /></td>
                      </tr>
                    ))}
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
          claveFila={x => x.producto.id_interno}
          onFila={x => abrirFicha(x, detalle)}
          onVerEnTabla={() => { setFiltroPosicion(detalle.posicion); setDetalle(null); }}
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
    </div>
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
