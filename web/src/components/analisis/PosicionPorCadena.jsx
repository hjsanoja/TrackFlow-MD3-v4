import { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import Segmentado from '../Segmentado';
import FiltroChip from '../FiltroChip';
import BarraFiltros from '../BarraFiltros';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { useData } from '../../context/DataContext';
import { useBcvRate } from '../../hooks/useBcvRate';
import { useRpc } from '../../hooks/useRpc';
import { useAnalisisPrecios } from '../../hooks/useAnalisisPrecios';
import { tokensGrafico } from '../../utils/chartTokens';
import { getChainColor } from '../../utils/brandColors';
import { describirPresentacion } from '../../utils/presentacion';
import { normalizar } from '../formulario';
import { UMBRAL_EMPATE, leerColor, pct } from '../dashboard/comun';
import { EstadoAnalisis } from './Estados';

// Tu posicion por cadena: dentro de CADA cadena, tu enlace frente a los
// competidores de esa misma cadena. Hoy (con el ultimo precio leido, como el
// Dashboard) y dia a dia (fn_posicion_por_cadena, fase 45), con el mismo
// empate de 0,5 %:
//   mas barato: tu precio <= el mas barato de la competencia en la cadena
//   mas caro:   tu precio >  el mas caro de la competencia en la cadena
//   en medio:   el resto
const POSICIONES = [
  { id: 'barato', texto: 'Eres el más barato', corto: 'Más barato', token: '--md-sys-color-data-div-cheap-2', respaldo: '#2a78d6' },
  { id: 'medio', texto: 'En medio', corto: 'En medio', token: '--md-sys-color-data-div-mid', respaldo: '#a9a8a3' },
  { id: 'caro', texto: 'Eres el más caro', corto: 'Más caro', token: '--md-sys-color-data-div-dear-2', respaldo: '#e34948' },
];
const PERIODOS = [['7', '7 d', 'Últimos 7 días'], ['30', '30 d', 'Últimos 30 días'], ['90', '90 d', 'Últimos 90 días']];
const EMPATE = 1 + UMBRAL_EMPATE / 100;

const usd = (v, dec = 2) => (v == null ? '—' : `$${Number(v).toFixed(dec)}`);
const diaCorto = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });
const diaLargo = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });

export function posicionEnCadena(tuyo, minimo, maximo) {
  if (tuyo <= minimo * EMPATE) return 'barato';
  if (tuyo > maximo * EMPATE) return 'caro';
  return 'medio';
}

export default function PosicionPorCadena() {
  const { productos = [], productosCompetencia = [], cadenas = [], variaciones = [] } = useData() || {};
  const bcv = useBcvRate();
  const [modoPrecio, setModoPrecio] = useState('lista');
  const [modoAnalisis, setModoAnalisis] = useState('empaque');
  const [dias, setDias] = useState('30');
  const [verSerie, setVerSerie] = useState('caro');           // caro | barato
  const [enPorcentaje, setEnPorcentaje] = useState('cantidad'); // cantidad | pct
  const [cadenaFoco, setCadenaFoco] = useState('todos');
  const [seleccion, setSeleccion] = useState(null);           // { cadena, posicion }
  const [busqueda, setBusqueda] = useState('');

  const { analizados, nombreCadena } = useAnalisisPrecios({
    productos, productosCompetencia, cadenas, variaciones, tasa: bcv.rate, modoPrecio, modoAnalisis,
  });

  // Hoy: por cadena, cada producto con tu enlace y al menos un competidor ahi.
  const hoy = useMemo(() => {
    const m = new Map();
    for (const x of analizados) {
      const porCadena = new Map();
      for (const o of x.precios) {
        if (!porCadena.has(o.cadena)) porCadena.set(o.cadena, { tuyos: [], comp: [] });
        porCadena.get(o.cadena)[o.tipo === 'propio' ? 'tuyos' : 'comp'].push(o);
      }
      for (const [cadena, { tuyos, comp }] of porCadena) {
        if (!tuyos.length || !comp.length) continue;
        const tuyo = Math.min(...tuyos.map(o => o.priceUsd));
        const valores = comp.map(o => o.priceUsd);
        const minimo = Math.min(...valores);
        const maximo = Math.max(...valores);
        const fila = { x, cadena, tuyo, minimo, maximo, competidores: comp.length, posicion: posicionEnCadena(tuyo, minimo, maximo) };
        if (!m.has(cadena)) m.set(cadena, { cadena, filas: [] });
        m.get(cadena).filas.push(fila);
      }
    }
    return [...m.values()].map(c => ({
      ...c,
      nombre: nombreCadena(c.cadena),
      barato: c.filas.filter(f => f.posicion === 'barato').length,
      medio: c.filas.filter(f => f.posicion === 'medio').length,
      caro: c.filas.filter(f => f.posicion === 'caro').length,
    })).sort((a, b) => b.caro / b.filas.length - a.caro / a.filas.length || a.nombre.localeCompare(b.nombre));
  }, [analizados, nombreCadena]);

  // Dia a dia (fase 45).
  const { filas: serie, cargando, error, faltaSql } = useRpc('fn_posicion_por_cadena', {
    p_dias: Number(dias), p_con_descuento: modoPrecio === 'descuento', p_por_unidad: modoAnalisis === 'unidosis',
  });
  const cadenasSerie = useMemo(() => {
    const ids = [...new Set(serie.map(f => f.cadena_id))];
    return ids.filter(id => cadenaFoco === 'todos' || id === cadenaFoco)
      .sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));
  }, [serie, cadenaFoco, nombreCadena]);
  const datosSerie = useMemo(() => {
    const porFecha = new Map();
    for (const f of serie) {
      if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, { fecha: f.fecha });
      const valor = verSerie === 'caro' ? f.mas_caro : f.mas_barato;
      porFecha.get(f.fecha)[f.cadena_id] = enPorcentaje === 'pct'
        ? (f.productos ? Math.round((valor / f.productos) * 1000) / 10 : null)
        : valor;
      porFecha.get(f.fecha)[`${f.cadena_id}__de`] = f.productos;
    }
    return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
  }, [serie, verSerie, enPorcentaje]);

  const colores = Object.fromEntries(POSICIONES.map(p => [p.id, leerColor(p.token, p.respaldo)]));
  const tg = tokensGrafico();
  const cadenaSel = seleccion ? hoy.find(c => c.cadena === seleccion.cadena) : null;
  const filasSel = useMemo(() => {
    if (!cadenaSel) return [];
    const t = normalizar(busqueda);
    return cadenaSel.filas
      .filter(f => (seleccion.posicion === 'todos' || f.posicion === seleccion.posicion)
        && (!t || normalizar(`${f.x.producto.id_interno} ${f.x.producto.nombre} ${f.x.producto.principio_activo || ''}`).includes(t)))
      .sort((a, b) => b.tuyo / b.minimo - a.tuyo / a.minimo);
  }, [cadenaSel, seleccion, busqueda]);

  const unidad = modoAnalisis === 'unidosis';

  return (
    <div className="space-y-4">
      <BarraFiltros
        etiqueta="Filtros de tu posición por cadena"
        limpiar={{ visible: cadenaFoco !== 'todos', onClick: () => setCadenaFoco('todos') }}
        filtrar={(
          <FiltroChip etiqueta="Cadena del gráfico" icono="storefront" valor={cadenaFoco} onChange={setCadenaFoco}
            opciones={[['todos', 'Gráfico: todas las cadenas'], ...hoy.map(c => [c.cadena, `Solo ${c.nombre}`])]} />
        )}
        comparar={(
          <>
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={modoPrecio} onChange={setModoPrecio}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', 'Precio con oferta']]} />
            <Segmentado etiqueta="Comparar por" rotulo="Por" valor={modoAnalisis} onChange={setModoAnalisis}
              opciones={[['empaque', 'Empaque', 'Precio de la caja'], ['unidosis', 'Unidad', 'Precio por tableta, ml o g']]} />
          </>
        )}
      />

      {/* Hoy, cadena por cadena */}
      <section className="m3-dash-card" aria-label="Hoy, cadena por cadena">
        <header className="m3-dash-card-header items-center">
          <div className="min-w-0 flex items-center gap-1">
            <h2 className="m3-title-medium text-on-surface">Hoy, dentro de cada cadena</h2>
            <InfoGrafico
              titulo="Tu posición por cadena"
              que="En cada cadena, tu enlace frente a los competidores de esa MISMA cadena. Cuenta solo los productos que tienen tu enlace y al menos un competidor en la cadena."
              formula={[
                'Más barato: tu precio es igual o menor que el más barato de la competencia en la cadena',
                'Más caro: tu precio es mayor que el más caro de la competencia en la cadena',
                'En medio: el resto · empate: hasta 0,5 %',
              ]}
              lectura="Primero las cadenas donde eres el más caro en más productos. Toca un número para ver los productos."
            />
          </div>
          <div className="m3-dash-leyenda ml-auto" aria-hidden="true">
            {POSICIONES.map(p => <span key={p.id}><i style={{ background: colores[p.id] }} />{p.corto}</span>)}
          </div>
        </header>
        {hoy.length === 0 ? (
          <p className="m3-body-medium text-on-surface-variant py-8 text-center">Aún no hay cadenas con tu enlace y el de la competencia leídos.</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {hoy.map(c => (
              <li key={c.cadena} className={`m3-posicion-cadena ${seleccion?.cadena === c.cadena ? 'is-activa' : ''}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <CadenaBadge cadena={c.cadena} tamano="sm" title="" />
                  <button type="button" className="m3-title-small text-on-surface truncate hover:underline text-left"
                    onClick={() => setSeleccion({ cadena: c.cadena, posicion: 'todos' })} title={`Ver tus ${c.filas.length} productos en ${c.nombre}`}>
                    {c.nombre}
                  </button>
                  <span className="m3-body-small text-on-surface-variant ml-auto whitespace-nowrap">{c.filas.length} productos</span>
                </div>
                <div className="m3-posicion-barra" role="img"
                  aria-label={`${c.nombre}: más barato en ${c.barato}, en medio en ${c.medio}, más caro en ${c.caro} de ${c.filas.length}`}>
                  {POSICIONES.map(p => c[p.id] > 0 && (
                    <span key={p.id} style={{ flexGrow: c[p.id], background: colores[p.id] }} title={`${p.texto}: ${c[p.id]}`} />
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {POSICIONES.map(p => (
                    <button key={p.id} type="button" disabled={!c[p.id]}
                      onClick={() => setSeleccion({ cadena: c.cadena, posicion: p.id })}
                      className={`m3-posicion-dato ${seleccion?.cadena === c.cadena && seleccion.posicion === p.id ? 'is-activo' : ''}`}
                      title={c[p.id] ? `Ver los productos: ${p.texto.toLowerCase()} en ${c.nombre}` : undefined}>
                      <span className="m3-title-medium tabular-nums text-on-surface">{c[p.id]}</span>
                      <span className="m3-label-small text-on-surface-variant">{p.corto}</span>
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Productos de la cadena elegida */}
      {cadenaSel && (
        <section className="m3-data-table" aria-label={`Productos en ${cadenaSel.nombre}`}>
          <div className="m3-data-table-titulo flex items-center gap-3">
            <CadenaBadge cadena={cadenaSel.cadena} tamano="sm" title="" />
            <div className="min-w-0">
              <h2 className="m3-title-medium text-on-surface">Tus productos en {cadenaSel.nombre}</h2>
              <p className="m3-body-small text-on-surface-variant">Tu precio en esta cadena frente a los competidores de esta cadena{unidad ? ', por unidad' : ''}. Primero los más caros frente al más barato.</p>
            </div>
            <button type="button" onClick={() => setSeleccion(null)} className="m3-icon-btn ml-auto" aria-label="Cerrar la lista">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          <div className="m3-data-table-toolbar flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, nombre o molécula" aria-label="Buscar producto" />
            </label>
            <FiltroChip etiqueta="Posición" icono="balance" valor={seleccion.posicion} onChange={v => setSeleccion({ ...seleccion, posicion: v })}
              opciones={[['todos', `Todas (${cadenaSel.filas.length})`], ...POSICIONES.map(p => [p.id, `${p.texto} (${cadenaSel[p.id]})`])]} />
            <span className="m3-label-large text-on-surface-variant md:ml-auto">{filasSel.length} productos</span>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Posición</th>
                  <th className="text-right">Tu precio</th>
                  <th className="text-right">Más barato</th>
                  <th className="text-right">Más caro</th>
                  <th className="text-right" title="Tu precio frente al más barato de la competencia en la cadena">Tú vs el más barato</th>
                </tr>
              </thead>
              <tbody>
                {filasSel.map(f => {
                  const p = POSICIONES.find(q => q.id === f.posicion);
                  return (
                    <tr key={f.x.producto.id_interno}>
                      <td>
                        <div className="m3-cell-primary m3-cell-clamp max-w-[20rem]" title={f.x.producto.nombre}>{f.x.producto.nombre}</div>
                        <div className="m3-cell-secondary">{[f.x.producto.id_interno, f.x.producto.concentracion, describirPresentacion(f.x.producto)].filter(v => v && v !== '—').join(' · ')}</div>
                      </td>
                      <td data-label="Posición">
                        <span className="inline-flex items-center gap-1.5 m3-body-medium whitespace-nowrap">
                          <i className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colores[f.posicion] }} aria-hidden="true" />
                          {p.texto}
                        </span>
                        <div className="m3-cell-secondary">{f.competidores} {f.competidores === 1 ? 'competidor' : 'competidores'}</div>
                      </td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Tu precio">{usd(f.tuyo, unidad ? 3 : 2)}</td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Más barato">{usd(f.minimo, unidad ? 3 : 2)}</td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Más caro">{usd(f.maximo, unidad ? 3 : 2)}</td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Tú vs el más barato">{pct((f.tuyo / f.minimo - 1) * 100)}</td>
                    </tr>
                  );
                })}
                {filasSel.length === 0 && <tr><td colSpan={6} className="text-center text-on-surface-variant py-8">Ningún producto con estos filtros.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Dia a dia */}
      <section className="m3-dash-card" aria-label="Día a día">
        <header className="m3-dash-card-header items-center flex-wrap gap-2">
          <div className="min-w-0 flex items-center gap-1">
            <h2 className="m3-title-medium text-on-surface">
              ¿{verSerie === 'caro' ? 'Sube o baja' : 'Crece o baja'} {enPorcentaje === 'pct' ? 'el % de' : 'la cantidad de'} productos {verSerie === 'caro' ? 'donde eres el más caro' : 'donde eres el más barato'}?
            </h2>
            <InfoGrafico
              titulo="Día a día, por cadena"
              que="Cada línea es una cadena. Cada día, en cuántos de tus productos eras el más caro (o el más barato) dentro de esa cadena."
              formula={[
                'El último precio de cada enlace ese día (hasta 7 días atrás), en dólares a la tasa del día',
                'Las lecturas marcadas como dudosas no cuentan',
                '% = sobre los productos con tu enlace y competidores en esa cadena ese día',
              ]}
              lectura="Si la línea de «más caro» sube, te estás quedando caro en esa cadena. Usa % si en una cadena se agregaron o quitaron enlaces: la cantidad cambia aunque tus precios no."
              alinear="derecha"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <Segmentado etiqueta="Qué contar" valor={verSerie} onChange={setVerSerie}
              opciones={[['caro', 'Más caro', 'Productos donde eres el más caro'], ['barato', 'Más barato', 'Productos donde eres el más barato']]} />
            <Segmentado etiqueta="Cómo contar" valor={enPorcentaje} onChange={setEnPorcentaje}
              opciones={[['cantidad', 'Cantidad', 'Número de productos'], ['pct', '%', 'Porcentaje de tus productos en la cadena']]} />
            <Segmentado etiqueta="Periodo" valor={dias} onChange={setDias} opciones={PERIODOS} />
          </div>
        </header>
        <EstadoAnalisis cargando={cargando} faltaSql={faltaSql} fase="la fase 45" error={error} hayFilas={datosSerie.length > 0}
          vacio="Aún no hay días con tu enlace y el de la competencia en una misma cadena.">
          <div className="h-72" role="img" aria-label="Productos por cadena, día a día">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={datosSerie} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                <XAxis dataKey="fecha" tickFormatter={diaCorto} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false}
                  axisLine={{ stroke: tg.rejilla }} minTickGap={24} />
                <YAxis allowDecimals={enPorcentaje === 'pct'} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={false} width={44}
                  tickFormatter={v => (enPorcentaje === 'pct' ? `${v} %` : v)} />
                <Tooltip content={<TooltipSerie nombreCadena={nombreCadena} enPorcentaje={enPorcentaje} verSerie={verSerie} />} cursor={{ stroke: tg.eje, strokeOpacity: 0.3 }} />
                {cadenasSerie.map(id => (
                  <Line key={id} type="monotone" dataKey={id} name={nombreCadena(id)} stroke={getChainColor(id)} strokeWidth={2}
                    dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: tg.superficie }} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {cadenasSerie.length > 1 && (
            <div className="m3-dash-leyenda flex-wrap" aria-label="Cadenas del gráfico">
              {cadenasSerie.map(id => (
                <button key={id} type="button" onClick={() => setCadenaFoco(id)} title={`Ver solo ${nombreCadena(id)}`}>
                  <i style={{ background: getChainColor(id) }} />{nombreCadena(id)}
                </button>
              ))}
            </div>
          )}
        </EstadoAnalisis>
      </section>
    </div>
  );
}

function TooltipSerie({ active, payload, label, nombreCadena, enPorcentaje, verSerie }) {
  if (!active || !payload?.length) return null;
  const f = payload[0].payload;
  const filas = [...payload].filter(p => p.value != null).sort((a, b) => b.value - a.value);
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium first-letter:uppercase">{diaLargo(label)}</div>
      <div className="text-on-surface-variant">{verSerie === 'caro' ? 'Productos donde eres el más caro' : 'Productos donde eres el más barato'}</div>
      {filas.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <i className="w-2.5 h-2.5 rounded-full" style={{ background: p.stroke }} aria-hidden="true" />
          <span>{nombreCadena(p.dataKey)}:</span>
          <strong className="font-medium tabular-nums">{enPorcentaje === 'pct' ? `${String(p.value).replace('.', ',')} %` : p.value}</strong>
          <span className="text-on-surface-variant">de {f[`${p.dataKey}__de`]}</span>
        </div>
      ))}
    </div>
  );
}
