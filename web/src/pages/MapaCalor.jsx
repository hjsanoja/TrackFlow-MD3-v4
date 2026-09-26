import LimpiarFiltros from '../components/LimpiarFiltros';
import { useEffect, useMemo, useState } from 'react';
import StatCard from '../components/StatCard';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import InfoGrafico from '../components/InfoGrafico';
import CadenaBadge from '../components/CadenaBadge';
import DetalleLista from '../components/DetalleLista';
import ProductDetailModal from '../components/ProductDetailModal';
import { normalizar } from '../components/formulario';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { useAnalisisPrecios } from '../hooks/useAnalisisPrecios';
import { exportToCSV } from '../utils/exportUtils';
import { describirPresentacion } from '../utils/presentacion';
import { crearFormato, Diferencia, pct, usePreferencia, grupoDe } from '../components/dashboard/comun';

// Mapa de calor: por cada producto, el espectro de precios de la competencia
// (del mas barato al mas caro) y donde cae tu precio. La franja se colorea
// como un termometro: azul la zona barata, gris la zona pareja (±5 % del
// promedio) y rojo la zona cara. El punto es tu precio.
// La comparacion por cadena (productos × cadenas) esta en Experimental.

const POSICIONES = [
  ['todos', 'Posición: todas'],
  ['barato', 'Más baratos que el promedio'],
  ['parejo', 'Parejos (±5 %)'],
  ['caro', 'Más caros que el promedio'],
  ['sin_comparar', 'Sin comparar'],
];
const posicionDe = (x) => (!x.comparable || x.difProm == null ? 'sin_comparar' : x.difProm < -5 ? 'barato' : x.difProm > 5 ? 'caro' : 'parejo');
const ETIQUETA_POSICION = { barato: 'Más barato', parejo: 'Parejo', caro: 'Más caro', sin_comparar: 'Sin comparar' };

export default function MapaCalor() {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [], loadingInitial: loading } = useData();
  const bcv = useBcvRate();

  const [moneda, setMoneda] = usePreferencia('trackflow_pref_currency', 'usd', ['usd', 'bs']);
  const [modoAnalisis, setModoAnalisis] = usePreferencia('trackflow_pref_analisis_mode', 'empaque', ['empaque', 'unidosis']);
  const [modoPrecio, setModoPrecio] = usePreferencia('dashboard.precio', 'lista', ['lista', 'descuento']);
  const [filtroCadena, setFiltroCadena] = useState('todos');
  const [tipoComp, setTipoComp] = useState('todos'); // todos | GENERICO | MARCA
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

  const { analizados, nombreCadena, idCadena } = useAnalisisPrecios({
    productos, productosCompetencia, cadenas, variaciones, tasa: bcv.rate, modoPrecio, modoAnalisis, cadenaComp: filtroCadena, tipoComp,
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
  const cadenasCompetencia = useMemo(() => {
    const ids = new Set();
    for (const e of productosCompetencia) {
      if (e.activo && String(e.tipo).toLowerCase() !== 'propio' && e.ultimo_precio_full_bs) ids.add(idCadena(e.cadena));
    }
    return [...ids].sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));
  }, [productosCompetencia, idCadena, nombreCadena]);

  // Productos con algun precio, segun los filtros; con el maximo de la competencia.
  const base = useMemo(() => analizados
    .filter(({ producto: p, sinPrecio }) =>
      !sinPrecio &&
      (filtroUnidad === 'todos' || claveUnidad(p) === filtroUnidad) &&
      (filtroTipo === 'todos' || (p.market_type || 'GENERICO').toLowerCase() === filtroTipo) &&
      (filtroCategoria === 'todos' || p.categoria === filtroCategoria))
    .map(x => {
      const comp = x.precios.filter(o => o.tipo !== 'propio');
      const maximo = comp.length ? Math.max(...comp.map(o => o.priceUsd)) : null;
      const ofertaMax = comp.find(o => o.priceUsd === maximo);
      return { ...x, maximo, cadenaMax: ofertaMax?.cadena, competidores: comp.length, ranking: x.posicion, posicion: posicionDe(x) };
    }), [analizados, filtroUnidad, filtroTipo, filtroCategoria]);
  const hayFiltros = [filtroCadena, tipoComp, filtroUnidad, filtroTipo, filtroCategoria, filtroPosicion].some(v => v !== 'todos');

  const porPosicion = useMemo(() => {
    const g = { barato: [], parejo: [], caro: [], sin_comparar: [] };
    for (const x of base) g[x.posicion].push(x);
    return g;
  }, [base]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = base.filter(x =>
      (filtroPosicion === 'todos' || x.posicion === filtroPosicion) &&
      (!term || normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)));
    const signo = orden.dir === 'asc' ? 1 : -1;
    return lista.sort((a, b) => {
      if (orden.campo === 'nombre') return (a.producto.nombre || '').localeCompare(b.producto.nombre || '', 'es', { sensitivity: 'base' }) * signo;
      const valor = (x) => (orden.campo === 'ranking' ? (x.ranking ? x.ranking.lugar / x.ranking.de : null) : x.difProm);
      const va = valor(a);
      const vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * signo;
    });
  }, [base, search, filtroPosicion, orden]);

  useEffect(() => { setPaginaActual(1); }, [search, filtroPosicion, filtroCadena, filtroUnidad, filtroTipo, filtroCategoria, orden, itemsPorPagina]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);
  // Escala comun a todas las filas, centrada en el promedio: ±limite %.
  const limite = useMemo(() => {
    let m = 10;
    for (const x of filas) {
      if (!(x.promedio > 0)) continue;
      for (const v of [x.minimo, x.maximo, x.tuPrecio]) if (v != null) m = Math.max(m, Math.abs((v / x.promedio - 1) * 100));
    }
    return Math.min(50, Math.ceil(m / 5) * 5);
  }, [filas]);
  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));

  const abrirFicha = (x, desde = null) => { setVolverA(desde); setDetalle(null); setFicha({ producto: x.producto, competencia: x.competencia }); };
  const cerrarFicha = () => { setFicha(null); if (volverA) { setDetalle(volverA); setVolverA(null); } };
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
  const colProducto = {
    titulo: 'Producto',
    celda: x => (
      <div className="min-w-0">
        <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={x.producto.nombre}>{x.producto.nombre}</div>
        <div className="m3-cell-secondary">{subtituloProducto(x.producto)}</div>
      </div>
    ),
  };

  const exportar = () => {
    const suf = moneda === 'usd' ? 'USD' : 'Bs';
    const valor = (usd) => (usd == null ? '' : moneda === 'usd' ? usd.toFixed(modoAnalisis === 'unidosis' ? 4 : 2) : (usd * (bcv.rate || 0)).toFixed(2));
    const datos = filas.map(x => ({
      id: x.producto.id_interno, producto: x.producto.nombre, presentacion: subtituloProducto(x.producto, false),
      tu: valor(x.tuPrecio), min: valor(x.minimo), prom: valor(x.promedio), max: valor(x.maximo),
      dif: x.difProm == null ? '' : x.difProm.toFixed(1), posicion: ETIQUETA_POSICION[x.posicion],
    }));
    if (!datos.length) return;
    exportToCSV(`mapa_de_calor${filtroCadena !== 'todos' ? `_${filtroCadena}` : ''}${modoAnalisis === 'unidosis' ? '_por_unidad' : ''}`, [
      { key: 'id', label: 'ID' }, { key: 'producto', label: 'Producto' }, { key: 'presentacion', label: 'Presentación' },
      { key: 'tu', label: `Tu precio (${suf})` }, { key: 'min', label: `Mínimo competencia (${suf})` },
      { key: 'prom', label: `Promedio competencia (${suf})` }, { key: 'max', label: `Máximo competencia (${suf})` },
      { key: 'dif', label: 'Tú frente al promedio (%)' }, { key: 'posicion', label: 'Posición' },
    ], datos);
  };

  if (loading && productos.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="h-96 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const comparables = base.length - porPosicion.sin_comparar.length;

  return (
    <div className="space-y-5 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">thermostat</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Mapa de calor</h1>
          </div>
          <p className="text-xs text-on-surface-variant">
            Para cada producto, los precios de la competencia del más barato al más caro y dónde cae el tuyo.
          </p>
        </div>
        <button onClick={exportar} className="m3-btn-outline self-start lg:self-auto" title="Descargar en CSV lo que se ve, con los filtros actuales">
          <span className="material-symbols-outlined text-base">download</span>
          <span>Exportar</span>
        </button>
      </div>

      <section className="m3-dash-filtros" aria-label="Filtros del mapa">
        <div className="flex flex-wrap items-center gap-2">
          <FiltroChip etiqueta="Comparar contra" icono="storefront" valor={filtroCadena} onChange={setFiltroCadena}
            opciones={[['todos', 'Competencia: todas las cadenas'], ...cadenasCompetencia.map(c => [c, `Solo ${nombreCadena(c)}`])]} />
          <FiltroChip etiqueta="Competidores: marca o genérico" icono="verified" valor={tipoComp} onChange={setTipoComp}
            opciones={[['todos', 'Competidores: marcas y genéricos'], ['GENERICO', 'Solo genéricos'], ['MARCA', 'Solo marcas']]} />
          <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad} opciones={[['todos', 'Unidad: todas'], ...unidades]} />
          <FiltroChip etiqueta="Tipo" icono="category" valor={filtroTipo} onChange={setFiltroTipo} opciones={[['todos', 'Tipo: todos'], ['generico', 'Genéricos'], ['marca', 'Marca']]} />
          <FiltroChip etiqueta="Categoría" icono="sell" valor={filtroCategoria} onChange={setFiltroCategoria} opciones={[['todos', 'Categoría: todas'], ...categorias.map(c => [c, c])]} />
          <FiltroChip etiqueta="Posición" icono="balance" valor={filtroPosicion} onChange={setFiltroPosicion} opciones={POSICIONES} />
          <LimpiarFiltros visible={hayFiltros} onClick={() => { setFiltroCadena('todos'); setTipoComp('todos'); setFiltroUnidad('todos'); setFiltroTipo('todos'); setFiltroCategoria('todos'); setFiltroPosicion('todos'); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Select value={modoPrecio} onChange={e => setModoPrecio(e.target.value)} aria-label="Precio que se compara" className="m3-filter-chip" leadingIcon="receipt_long">
            <option value="lista">Precio de lista</option>
            <option value="descuento">Precio con oferta</option>
          </Select>
          <Select value={modoAnalisis} onChange={e => setModoAnalisis(e.target.value)} aria-label="Comparar por" className="m3-filter-chip" leadingIcon="medication">
            <option value="empaque">Por empaque</option>
            <option value="unidosis">Por unidad</option>
          </Select>
          <label className="m3-switch-label whitespace-nowrap ml-1">
            <span className={moneda === 'bs' ? 'text-on-surface-variant' : 'font-medium'}>$</span>
            <input type="checkbox" role="switch" checked={moneda === 'bs'} onChange={e => setMoneda(e.target.checked ? 'bs' : 'usd')} className="m3-switch" aria-label="Ver los precios en bolívares" />
            <span className={moneda === 'bs' ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
          </label>
        </div>
      </section>

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Indicadores">
        <StatCard compacto label="Más baratos que el promedio" value={`${porPosicion.barato.length} de ${comparables}`} icon="south" tono="primary"
          hint="Tu precio más de 5 % bajo el promedio" onClick={() => abrirGrupo('barato', 'Más baratos que el promedio', 'south')} />
        <StatCard compacto label="Parejos" value={`${porPosicion.parejo.length} de ${comparables}`} icon="drag_handle" tono="neutral"
          hint="Tu precio a ±5 % del promedio" onClick={() => abrirGrupo('parejo', 'Parejos con el promedio', 'drag_handle')} />
        <StatCard compacto label="Más caros que el promedio" value={`${porPosicion.caro.length} de ${comparables}`} icon="north" tono={porPosicion.caro.length ? 'negative' : 'neutral'}
          hint="Tu precio más de 5 % sobre el promedio" onClick={() => abrirGrupo('caro', 'Más caros que el promedio', 'north')} />
        <StatCard compacto label="Sin comparar" value={porPosicion.sin_comparar.length} icon="help" tono={porPosicion.sin_comparar.length ? 'warning' : 'neutral'}
          hint="Falta tu precio o el de la competencia" onClick={() => abrirGrupo('sin_comparar', 'Sin comparar', 'help')} />
      </section>

      <section className="m3-data-table" aria-label="Mapa de calor">
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
            <div className="m3-espectro-leyenda" aria-label="Cómo se lee">
              <span><i className="m3-espectro-zona-barata" />Más de 5 % bajo el promedio</span>
              <span><i className="m3-espectro-zona-pareja" />±5 %</span>
              <span><i className="m3-espectro-zona-cara" />Más de 5 % sobre el promedio</span>
              <span><i className="m3-espectro-rango-leyenda" />Mín. a máx. de la competencia</span>
            </div>
            <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
              {filas.length === base.length ? `${base.length} productos` : `${filas.length} de ${base.length} productos`}
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
            <div className="m3-espectro-cabecera" role="row">
              <button type="button" onClick={() => ordenarPor('nombre')} className={`m3-sort-btn ${orden.campo === 'nombre' ? 'is-active' : ''}`}>
                Producto
                <span className="material-symbols-outlined" aria-hidden="true">{orden.campo === 'nombre' ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
              </button>
              <span className="hidden md:flex items-center gap-1">
                Precios de la competencia y el tuyo
                <InfoGrafico
                  titulo="Cómo se lee cada franja"
                  que={`Todas las franjas usan la misma escala, con el promedio de la competencia siempre al centro: a la izquierda hasta ${limite} % más barato y a la derecha hasta ${limite} % más caro. Así se comparan las filas entre sí.`}
                  formula={[
                    'Raya del centro = promedio de la competencia (tu precio no entra)',
                    'Tramo oscuro = desde el precio más bajo hasta el más alto de la competencia',
                    'Globo = tu precio y tu precio ÷ promedio − 1',
                    'Tu posición = lugar de tu precio entre todas las ofertas (1 = el más barato)',
                  ]}
                  lectura="Zona azul: más de 5 % por debajo del promedio. Zona gris: a ±5 %. Zona roja: más de 5 % por encima. Si tu globo queda a la izquierda del tramo oscuro, eres el más barato; a la derecha, el más caro. Lo que pase del borde se dibuja en el borde, pero el globo dice el valor real. Solo cuentan las cadenas y el tipo (marca / genérico) de los filtros."
                />
              </span>
              <button type="button" onClick={() => ordenarPor('ranking')} className={`m3-sort-btn justify-self-end ${orden.campo === 'ranking' ? 'is-active' : ''}`}
                title="Lugar de tu precio entre todas las ofertas: 1 = el más barato">
                Tu posición
                <span className="material-symbols-outlined" aria-hidden="true">{orden.campo === 'ranking' ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
              </button>
            </div>
            <ul className="divide-y divide-outline-variant" aria-label="Productos">
              {filasPagina.map(x => (
                <li key={x.producto.id_interno}>
                  <button type="button" onClick={() => abrirFicha(x)} className="m3-espectro-fila">
                    <div className="min-w-0">
                      <div className="m3-cell-primary m3-cell-clamp" title={x.producto.nombre}>{x.producto.nombre}</div>
                      <div className="m3-cell-secondary m3-cell-clamp">{subtituloProducto(x.producto)}</div>
                      <div className="mt-1 m3-body-small text-on-surface-variant">
                        {x.competidores} {x.competidores === 1 ? 'competidor' : 'competidores'}{x.tuPrecio == null ? ' · sin tu precio' : ''}
                      </div>
                    </div>
                    <Espectro x={x} fmt={fmtModo} nombreCadena={nombreCadena} limite={limite} />
                    <div className="flex flex-col items-end gap-1">
                      {x.ranking ? (
                        <span className="m3-espectro-ranking" title="Lugar de tu precio entre todas las ofertas: 1 = el más barato">
                          <strong>{x.ranking.lugar}.º</strong> de {x.ranking.de}
                        </span>
                      ) : <span className="text-on-surface-variant">—</span>}
                      <span className={`m3-espectro-estado is-${x.posicion}`}>{ETIQUETA_POSICION[x.posicion]}</span>
                      {x.cruce && (
                        <span className="m3-chip-marca" title={`${x.cruce.ref.marca}: ${fmtModo(x.cruce.ref.priceUsd)}`}>
                          {x.cruce.tipo === 'generico_caro' ? 'Más caro que una marca' : 'Más barato que un genérico'}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

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

// "140216 · Genérico · 500 mg · 20 tabletas": lo que distingue a dos
// productos con el mismo nombre.
function subtituloProducto(p, conId = true) {
  const tipo = (p.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico';
  return [conId ? p.id_interno : null, tipo, p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ');
}

// Espectro: escala comun centrada en el promedio de la competencia
// (−limite % a +limite %), con tres zonas de color: barata (< −5 %), pareja
// (±5 %) y cara (> +5 %). Tramo oscuro = minimo a maximo de la competencia;
// tu precio es el punto con globo.
function Espectro({ x, fmt, nombreCadena, limite }) {
  const { minimo: min, maximo: max, promedio: prom, tuPrecio: tuyo, difProm } = x;
  if (min == null || max == null || !(prom > 0)) {
    return <div className="m3-body-small text-on-surface-variant">Sin precios de la competencia para comparar.</div>;
  }
  const pos = (v) => Math.max(0, Math.min(100, 50 + ((v / prom - 1) * 100 / limite) * 50));
  const pBajo = 50 - (5 / limite) * 50;
  const pAlto = 50 + (5 / limite) * 50;
  const pMin = pos(min);
  const pMax = pos(max);
  const grupo = grupoDe(difProm ?? 0).id;
  const tono = /barato/.test(grupo) ? 'is-barato' : /caro/.test(grupo) ? 'is-caro' : 'is-parejo';
  const pTuyo = tuyo != null ? pos(tuyo) : null;
  // Rotulos: el minimo crece hacia la izquierda desde su punto y el maximo
  // hacia la derecha; si estan muy pegados al promedio se juntan con el.
  const juntoMin = pMin > 50 - 13;
  const juntoMax = pMax < 50 + 13;
  const prefijo = [juntoMin && `Mín. ${fmt(min)}`].filter(Boolean);
  const sufijo = [juntoMax && `Máx. ${fmt(max)}`].filter(Boolean);
  return (
    <div className="m3-espectro" role="img"
      aria-label={`Competencia de ${fmt(min)} a ${fmt(max)}, promedio ${fmt(prom)}${tuyo != null ? `; tu precio ${fmt(tuyo)} (${pct(difProm)})` : ''}`}>
      <div className="m3-espectro-pista">
        <div className="m3-espectro-zona-barata" style={{ left: 0, width: `${pBajo}%` }} />
        <div className="m3-espectro-zona-pareja" style={{ left: `${pBajo}%`, width: `${pAlto - pBajo}%` }} />
        <div className="m3-espectro-zona-cara" style={{ left: `${pAlto}%`, width: `${100 - pAlto}%` }} />
        <div className="m3-espectro-rango" style={{ left: `${pMin}%`, width: `${Math.max(0.6, pMax - pMin)}%` }} />
        <div className="m3-espectro-promedio" style={{ left: '50%' }} />
        {pTuyo != null && (
          <>
            <div className={`m3-espectro-punto m3-calor-punto-${grupo}`} style={{ left: `${pTuyo}%` }} />
            <div className={`m3-espectro-globo ${tono}`} style={{ left: `${pTuyo}%`, '--corrimiento': `-${pTuyo}%` }}>
              <strong>{fmt(tuyo)}</strong> {pct(difProm)}
              <i className="m3-espectro-globo-pico" style={{ left: `${pTuyo}%` }} aria-hidden="true" />
            </div>
          </>
        )}
      </div>
      <div className="m3-espectro-rotulos">
        {!juntoMin && (
          <span style={pMin < 15 ? { left: 0 } : { right: `${100 - pMin}%` }} title={x.cadenasMin[0] ? `En ${nombreCadena(x.cadenasMin[0])}` : ''}>
            {x.cadenasMin[0] && <CadenaBadge cadena={x.cadenasMin[0]} tamano="xs" title="" />}Mín. {fmt(min)}
          </span>
        )}
        <span className="is-prom" style={{ left: '50%' }}>{[...prefijo, `Prom. ${fmt(prom)}`, ...sufijo].join(' · ')}</span>
        {!juntoMax && (
          <span style={pMax > 85 ? { right: 0 } : { left: `${pMax}%` }} title={x.cadenaMax ? `En ${nombreCadena(x.cadenaMax)}` : ''}>
            Máx. {fmt(max)}{x.cadenaMax && <CadenaBadge cadena={x.cadenaMax} tamano="xs" title="" />}
          </span>
        )}
      </div>
    </div>
  );
}
