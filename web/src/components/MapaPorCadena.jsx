import BarraFiltros from './BarraFiltros';
import Segmentado from './Segmentado';
import { useEffect, useMemo, useState } from 'react';
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
import { exportToCSV } from '../utils/exportUtils';
import { describirPresentacion } from '../utils/presentacion';
import { crearFormato, pct, mediana, usePreferencia, GRUPOS, grupoDe } from './dashboard/comun';

// Experimental: mapa de calor de TU precio en cada cadena (solo tus enlaces).
// Cada celda es tu precio en esa cadena. El color responde a una pregunta,
// a elegir:
//   - "Tus cadenas": tu precio ahi frente al promedio de tu precio en todas
//     tus cadenas (azul = es donde te venden mas barato, rojo = mas caro).
//   - "Competencia": tu precio ahi frente al mas barato de la competencia en
//     ESA misma cadena.
// Mismos colores y tramos (±5 %, ±15 %) que "¿Donde esta tu precio?".

export default function MapaPorCadena() {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [], loadingInitial: loading } = useData();
  const bcv = useBcvRate();

  const [moneda, setMoneda] = usePreferencia('trackflow_pref_currency', 'usd', ['usd', 'bs'], { sesion: true });
  const [modoAnalisis, setModoAnalisis] = usePreferencia('trackflow_pref_analisis_mode', 'empaque', ['empaque', 'unidosis'], { sesion: true });
  const [modoPrecio, setModoPrecio] = usePreferencia('dashboard.precio', 'lista', ['lista', 'descuento'], { sesion: true });
  const [frente, setFrente] = usePreferencia('mapa.frente', 'mias', ['mias', 'competencia']);
  const [filtroUnidad, setFiltroUnidad] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroCategoria, setFiltroCategoria] = useState('todos');
  const [filtroCadenas, setFiltroCadenas] = useState('todos'); // todos | varias
  const [search, setSearch] = useState('');
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });
  const [paginaActual, setPaginaActual] = useState(1);
  const [itemsPorPagina, setItemsPorPagina] = usePreferencia('mapa.filas', 25, [10, 25, 50, 100]);
  const [ficha, setFicha] = useState(null);

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

  // Por producto: tu precio en cada cadena y el mas barato de la competencia ahi.
  const base = useMemo(() => analizados
    .filter(({ producto: p }) =>
      (filtroUnidad === 'todos' || claveUnidad(p) === filtroUnidad) &&
      (filtroTipo === 'todos' || (p.market_type || 'GENERICO').toLowerCase() === filtroTipo) &&
      (filtroCategoria === 'todos' || p.categoria === filtroCategoria))
    .map(x => {
      const tuyo = new Map();
      const comp = new Map();
      for (const o of x.precios) {
        const m = o.tipo === 'propio' ? tuyo : comp;
        if (!m.has(o.cadena) || o.priceUsd < m.get(o.cadena)) m.set(o.cadena, o.priceUsd);
      }
      const valores = [...tuyo.values()];
      const promedio = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
      const min = valores.length ? Math.min(...valores) : null;
      const max = valores.length ? Math.max(...valores) : null;
      return { ...x, tuyo, comp, promedioTuyo: promedio, rango: valores.length > 1 ? (max / min - 1) * 100 : null };
    })
    .filter(x => x.tuyo.size > 0), [analizados, filtroUnidad, filtroTipo, filtroCategoria]);

  const difDe = (x, cadena) => {
    const p = x.tuyo.get(cadena);
    if (p == null) return null;
    if (frente === 'mias') return x.tuyo.size > 1 && x.promedioTuyo > 0 ? (p / x.promedioTuyo - 1) * 100 : null;
    const c = x.comp.get(cadena);
    return c > 0 ? (p / c - 1) * 100 : null;
  };

  const cadenasTabla = useMemo(() => {
    const ids = new Map();
    for (const x of base) for (const c of x.tuyo.keys()) ids.set(c, (ids.get(c) || 0) + 1);
    return [...ids.entries()].sort((a, b) => nombreCadena(a[0]).localeCompare(nombreCadena(b[0]))).map(([id, n]) => ({ id, n }));
  }, [base, nombreCadena]);

  // Indicadores: donde eres mas barato tu mismo.
  const resumen = useMemo(() => {
    const varias = base.filter(x => x.tuyo.size > 1);
    const vecesMasBarata = new Map();
    for (const x of varias) {
      const min = Math.min(...x.tuyo.values());
      for (const [c, p] of x.tuyo) if (p <= min * 1.005) vecesMasBarata.set(c, (vecesMasBarata.get(c) || 0) + 1);
    }
    const lider = [...vecesMasBarata.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    const masCara = new Map();
    for (const x of varias) {
      const max = Math.max(...x.tuyo.values());
      for (const [c, p] of x.tuyo) if (p >= max / 1.005) masCara.set(c, (masCara.get(c) || 0) + 1);
    }
    const caraLider = [...masCara.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    return { total: base.length, varias: varias.length, lider, caraLider, rangoTipico: mediana(varias.map(x => x.rango)) };
  }, [base]);

  const filas = useMemo(() => {
    const term = normalizar(search);
    const lista = base.filter(x =>
      (filtroCadenas === 'todos' || x.tuyo.size > 1) &&
      (!term || normalizar(`${x.producto.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(term)));
    const signo = orden.dir === 'asc' ? 1 : -1;
    return lista.sort((a, b) => {
      if (orden.campo === 'nombre') return (a.producto.nombre || '').localeCompare(b.producto.nombre || '', 'es', { sensitivity: 'base' }) * signo;
      const va = a.rango;
      const vb = b.rango;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * signo;
    });
  }, [base, search, filtroCadenas, orden]);

  useEffect(() => { setPaginaActual(1); }, [search, filtroCadenas, filtroUnidad, filtroTipo, filtroCategoria, orden, itemsPorPagina]);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / itemsPorPagina));
  const filasPagina = filas.slice((paginaActual - 1) * itemsPorPagina, paginaActual * itemsPorPagina);
  const ordenarPor = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));
  const abrirFicha = (x) => setFicha({ producto: x.producto, competencia: x.competencia });

  const exportar = () => {
    const suf = moneda === 'usd' ? 'USD' : 'Bs';
    const valor = (usd) => (usd == null ? '' : moneda === 'usd' ? usd.toFixed(modoAnalisis === 'unidosis' ? 4 : 2) : (usd * (bcv.rate || 0)).toFixed(2));
    const cols = [
      { key: 'id', label: 'ID' }, { key: 'producto', label: 'Producto' },
      ...cadenasTabla.map(c => ({ key: `c_${c.id}`, label: `Tu precio en ${nombreCadena(c.id)} (${suf})` })),
      { key: 'rango', label: 'De tu cadena más barata a la más cara (%)' },
    ];
    const datos = filas.map(x => ({
      id: x.producto.id_interno, producto: x.producto.nombre,
      ...Object.fromEntries(cadenasTabla.map(c => [`c_${c.id}`, valor(x.tuyo.get(c.id))])),
      rango: x.rango == null ? '' : x.rango.toFixed(1),
    }));
    if (datos.length) exportToCSV(`mapa_de_calor_tu_precio${modoAnalisis === 'unidosis' ? '_por_unidad' : ''}`, cols, datos);
  };

  if (loading && productos.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="h-96 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const explicacion = frente === 'mias'
    ? 'Cada celda es tu precio en esa cadena. Azul: ahí te venden más barato que en tus otras cadenas; rojo: más caro. Gris: parejo (±5 %) o solo estás en una cadena.'
    : 'Cada celda es tu precio en esa cadena. Azul: ahí eres más barato que el competidor más barato de esa cadena; rojo: más caro. Sin color: no hay competencia en esa cadena.';

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="m3-body-medium text-on-surface-variant">{explicacion}</p>
        <button onClick={exportar} className="m3-btn-outline self-start md:self-auto" title="Descargar en CSV tu precio en cada cadena, con los filtros actuales">
          <span className="material-symbols-outlined text-base">download</span>
          <span>Exportar</span>
        </button>
      </div>

      <BarraFiltros
        limpiar={{ visible: filtroUnidad !== 'todos' || filtroTipo !== 'todos' || filtroCategoria !== 'todos' || filtroCadenas !== 'todos', onClick: () => { setFiltroUnidad('todos'); setFiltroTipo('todos'); setFiltroCategoria('todos'); setFiltroCadenas('todos'); } }}
        etiqueta="Filtros del mapa"
        filtrar={(
          <>
            <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUnidad} onChange={setFiltroUnidad} opciones={[['todos', 'Unidad: todas'], ...unidades]} />
            <FiltroChip etiqueta="Tipo de tus productos" icono="category" valor={filtroTipo} onChange={setFiltroTipo} opciones={[['todos', 'Tus productos: todos'], ['generico', 'Tus genéricos'], ['marca', 'Tus marcas']]} />
            <FiltroChip etiqueta="Categoría" icono="sell" valor={filtroCategoria} onChange={setFiltroCategoria} opciones={[['todos', 'Categoría: todas'], ...categorias.map(c => [c, c])]} />
            <FiltroChip etiqueta="En cuántas cadenas" icono="storefront" valor={filtroCadenas} onChange={setFiltroCadenas}
              opciones={[['todos', 'Cadenas: cualquiera'], ['varias', 'En 2 o más cadenas']]} />
          </>
        )}
        comparar={(
          <>
            <Segmentado etiqueta="El color compara tu precio contra" rotulo="Color" valor={frente} onChange={setFrente}
              opciones={[['mias', 'Tus cadenas', 'Tu precio en esa cadena frente a tu precio en tus otras cadenas'], ['competencia', 'Competencia', 'Tu precio en esa cadena frente al competidor más barato de esa cadena']]} />
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={modoPrecio} onChange={setModoPrecio}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', 'Precio con oferta']]} />
            <Segmentado etiqueta="Comparar por" rotulo="Por" valor={modoAnalisis} onChange={setModoAnalisis}
              opciones={[['empaque', 'Empaque', 'Precio de la caja'], ['unidosis', 'Unidad', 'Precio por tableta, ml o g']]} />
            <Segmentado etiqueta="Moneda" rotulo="Moneda" valor={moneda} onChange={setMoneda}
              opciones={[['usd', '$', 'Dólares'], ['bs', 'Bs', 'Bolívares a la tasa BCV']]} />
          </>
        )}
      />

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Indicadores">
        <StatCard compacto label="Productos con tu precio" value={resumen.total} icon="inventory_2" tono="neutral"
          hint={`${resumen.varias} en 2 o más cadenas`} onClick={() => setFiltroCadenas('todos')} />
        <StatCard compacto label="Donde más barato te venden" value={resumen.lider ? nombreCadena(resumen.lider[0]) : '—'} icon="south" tono="primary"
          hint={resumen.lider ? `Tu precio más bajo en ${resumen.lider[1]} de ${resumen.varias} productos` : 'Hace falta tu enlace en 2 cadenas'} />
        <StatCard compacto label="Donde más caro te venden" value={resumen.caraLider ? nombreCadena(resumen.caraLider[0]) : '—'} icon="north" tono={resumen.caraLider ? 'negative' : 'neutral'}
          hint={resumen.caraLider ? `Tu precio más alto en ${resumen.caraLider[1]} de ${resumen.varias} productos` : 'Hace falta tu enlace en 2 cadenas'} />
        <StatCard compacto label="Diferencia típica entre cadenas" value={resumen.rangoTipico == null ? '—' : pct(resumen.rangoTipico)} icon="unfold_more" tono="neutral"
          hint="De tu cadena más barata a la más cara (mediana)" onClick={() => { setFiltroCadenas('varias'); setOrden({ campo: 'rango', dir: 'desc' }); }} />
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
            <div className="m3-calor-leyenda" aria-label="Leyenda de colores">
              {GRUPOS.map(g => <span key={g.id}><i className={`m3-calor-${g.id}`} />{g.corto}</span>)}
            </div>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">
                {filas.length === base.length ? `${base.length} productos` : `${filas.length} de ${base.length} productos`}
              </span>
              <InfoGrafico alinear="derecha" titulo="Mapa de calor: tu precio en cada cadena"
                que="Solo tus enlaces: cuánto cuesta tu producto en cada cadena. Toca una fila para abrir la ficha."
                formula={[
                  'Tus cadenas: tu precio en la cadena ÷ el promedio de tu precio en tus cadenas − 1',
                  'Competencia: tu precio en la cadena ÷ el competidor más barato de esa cadena − 1',
                  'Colores: −15 % o menos · −15 a −5 % · parejo ±5 % · +5 a +15 % · +15 % o más',
                ]}
                lectura="Con «Tus cadenas», una columna muy azul es la cadena que mejor precio da a tus productos; muy roja, la que más los encarece." />
            </div>
          </div>
        </div>

        {filas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">search_off</span>
            <div className="m3-title-medium text-on-surface">{base.length ? 'Ningún producto coincide' : 'Aún no hay precios de tus enlaces'}</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Productos">
              {filasPagina.map(x => (
                <li key={x.producto.id_interno}>
                  <button type="button" onClick={() => abrirFicha(x)} className="w-full text-left px-4 py-3 space-y-2">
                    <div className="m3-cell-primary">{x.producto.nombre}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {cadenasTabla.filter(c => x.tuyo.has(c.id)).map(c => {
                        const dif = difDe(x, c.id);
                        return (
                          <span key={c.id} className={`m3-calor-chip ${dif != null ? `m3-calor-${grupoDe(dif).id}` : ''}`}>
                            <CadenaBadge cadena={c.id} tamano="xs" title="" />{fmtModo(x.tuyo.get(c.id))}
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
                    {cadenasTabla.map(c => (
                      <th key={c.id} className="text-center">
                        <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={c.id} tamano="xs" title="" />{nombreCadena(c.id)}</span>
                      </th>
                    ))}
                    <th className="text-right m3-dash-col-sep" title="De tu cadena más barata a la más cara">
                      <Orden campo="rango" orden={orden} onClick={ordenarPor}>Diferencia entre cadenas</Orden>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filasPagina.map(x => (
                    <tr key={x.producto.id_interno} onClick={() => abrirFicha(x)} className="cursor-pointer" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') abrirFicha(x); }}>
                      <td className="m3-dash-col-producto">
                        <div className="m3-cell-primary m3-cell-clamp" title={x.producto.nombre}>{x.producto.nombre}</div>
                        <div className="m3-cell-secondary">{[x.producto.id_interno, x.producto.concentracion, describirPresentacion(x.producto)].filter(v => v && v !== '—').join(' · ')}</div>
                      </td>
                      {cadenasTabla.map(c => {
                        const p = x.tuyo.get(c.id);
                        if (p == null) return <td key={c.id} className="text-center text-on-surface-variant">—</td>;
                        const dif = difDe(x, c.id);
                        const comp = x.comp.get(c.id);
                        return (
                          <td key={c.id} className={`m3-calor-celda ${dif != null ? `m3-calor-${grupoDe(dif).id}` : ''}`}
                            title={`Tu precio en ${nombreCadena(c.id)}: ${fmtModo(p)}${frente === 'mias' && x.promedioTuyo ? ` · tu promedio en tus cadenas ${fmtModo(x.promedioTuyo)}` : ''}${comp ? ` · competidor más barato ahí ${fmtModo(comp)}` : ''}`}>
                            <div className="font-medium tabular-nums">{fmtModo(p)}</div>
                            <div className="m3-calor-precio tabular-nums">{dif != null ? pct(dif, 0) : frente === 'mias' ? 'única' : 'sin comp.'}</div>
                          </td>
                        );
                      })}
                      <td className="text-right whitespace-nowrap tabular-nums m3-dash-col-sep">{x.rango == null ? '—' : pct(x.rango, 0)}</td>
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

function Orden({ campo, orden, onClick, children }) {
  const activo = orden.campo === campo;
  return (
    <button type="button" onClick={() => onClick(campo)} className={`m3-sort-btn ${activo ? 'is-active' : ''}`}>
      {children}
      <span className="material-symbols-outlined" aria-hidden="true">{activo ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
    </button>
  );
}
