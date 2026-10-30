import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import { useData } from '../../context/DataContext';
import BarraFiltros from '../BarraFiltros';
import FiltroChip from '../FiltroChip';
import Segmentado from '../Segmentado';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';

// Calendario de ofertas (fase 56): que dias y en que cadenas hubo precios con
// descuento o promocion (2x1, 3x2...). El color de cada dia es la parte de
// los enlaces leidos que estaba en oferta. Abajo, el patron por dia de la
// semana de cada cadena («Locatel descuenta los fines de semana»).
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Una sola gama (de claro a oscuro) para la intensidad.
const TRAMOS = [
  { hasta: 0, clase: 'n0', texto: 'Sin ofertas' },
  { hasta: 10, clase: 'n1', texto: 'Hasta 10 %' },
  { hasta: 25, clase: 'n2', texto: '10 a 25 %' },
  { hasta: 50, clase: 'n3', texto: '25 a 50 %' },
  { hasta: Infinity, clase: 'n4', texto: 'Más de 50 %' },
];
const tramo = (pct) => TRAMOS.find(t => pct <= t.hasta) || TRAMOS[4];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diaSemana = (fecha) => (new Date(`${fecha}T12:00:00`).getDay() + 6) % 7; // 0 = lunes
const faltaSql = (e) => /PGRST202|function|does not exist/i.test(`${e?.code} ${e?.message}`);
const bs = (v) => (v == null ? '—' : `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export default function CalendarioOfertas() {
  const { cadenas = [] } = useData() || {};
  const nombreCadena = (id) => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id;
  const hoy = new Date();
  const [mes, setMes] = useState(() => new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  const [cadena, setCadena] = useState('todos');
  const [quien, setQuien] = useState('competencia');
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sinFase, setSinFase] = useState(false);
  const [dia, setDia] = useState(null);
  const [detalle, setDetalle] = useState(null);

  const desde = iso(mes);
  const hasta = iso(new Date(mes.getFullYear(), mes.getMonth() + 1, 0));

  useEffect(() => {
    if (!isSupabaseActive()) { setCargando(false); return undefined; }
    let vivo = true;
    setCargando(true);
    supabase.rpc('fn_calendario_ofertas', { p_desde: desde, p_hasta: hasta, p_quien: quien }).then(({ data, error }) => {
      if (!vivo) return;
      if (error && faltaSql(error)) setSinFase(true);
      setFilas(error ? [] : data || []);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [desde, hasta, quien]);

  useEffect(() => {
    if (!dia) { setDetalle(null); return undefined; }
    let vivo = true;
    setDetalle('cargando');
    supabase.rpc('fn_ofertas_del_dia', { p_fecha: dia, p_cadena: cadena === 'todos' ? null : cadena, p_quien: quien }).then(({ data, error }) => {
      if (vivo) setDetalle(error ? [] : (data || []).sort((a, b) => (b.descuento || 0) - (a.descuento || 0)));
    });
    return () => { vivo = false; };
  }, [dia, cadena, quien]);

  const cadenasMes = useMemo(() => [...new Set(filas.map(f => f.cadena_id))].sort((a, b) => String(nombreCadena(a)).localeCompare(String(nombreCadena(b)))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [filas, cadenas]);
  const delFiltro = useMemo(() => filas.filter(f => cadena === 'todos' || String(f.cadena_id).toLowerCase() === String(cadena).toLowerCase()), [filas, cadena]);

  const porDia = useMemo(() => {
    const m = new Map();
    for (const f of delFiltro) {
      const d = m.get(f.fecha) || { enlaces: 0, oferta: 0, promo: 0 };
      d.enlaces += f.enlaces; d.oferta += f.en_oferta; d.promo += f.con_promocion;
      m.set(f.fecha, d);
    }
    return m;
  }, [delFiltro]);

  // Patron por dia de la semana: % promedio en oferta de cada cadena.
  const patron = useMemo(() => cadenasMes.map(c => {
    const suma = Array.from({ length: 7 }, () => ({ oferta: 0, enlaces: 0 }));
    filas.filter(f => f.cadena_id === c).forEach(f => { const s = suma[diaSemana(f.fecha)]; s.oferta += f.en_oferta; s.enlaces += f.enlaces; });
    return { cadena: c, dias: suma.map(s => (s.enlaces ? (s.oferta / s.enlaces) * 100 : null)) };
  }), [filas, cadenasMes]);

  const celdas = useMemo(() => {
    const primero = (mes.getDay() + 6) % 7;
    const total = new Date(mes.getFullYear(), mes.getMonth() + 1, 0).getDate();
    return [...Array(primero).fill(null), ...Array.from({ length: total }, (_, i) => iso(new Date(mes.getFullYear(), mes.getMonth(), i + 1)))];
  }, [mes]);

  const totalMes = [...porDia.values()].reduce((a, d) => ({ enlaces: a.enlaces + d.enlaces, oferta: a.oferta + d.oferta }), { enlaces: 0, oferta: 0 });
  const mover = (n) => { setMes(m => new Date(m.getFullYear(), m.getMonth() + n, 1)); setDia(null); };

  if (sinFase) {
    return (
      <div className="m3-banner m3-banner-info" role="status">
        <span className="material-symbols-outlined" aria-hidden="true">info</span>
        <span className="m3-body-medium">Falta correr <code>sql/fase56_calendario_ofertas.sql</code> en Supabase.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BarraFiltros
        etiqueta="Filtros del calendario"
        filtrar={(
          <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={v => { setCadena(v); setDia(null); }}
            opciones={[['todos', 'Cadena: todas'], ...cadenasMes.map(c => [c, nombreCadena(c)])]} />
        )}
        comparar={(
          <Segmentado etiqueta="Ofertas de quién" rotulo="De" valor={quien} onChange={v => { setQuien(v); setDia(null); }}
            opciones={[['competencia', 'Competencia', 'Ofertas de los laboratorios competidores'], ['propio', 'Tus productos', 'Ofertas que las cadenas hacen con tus productos'], ['todos', 'Todos', 'Todas las ofertas']]} />
        )}
      />

      <section className="m3-dash-card" aria-label="Calendario">
        <header className="m3-dash-card-header items-center">
          <div className="flex items-center gap-1">
            <button type="button" className="m3-icon-btn" onClick={() => mover(-1)} aria-label="Mes anterior"><span className="material-symbols-outlined">chevron_left</span></button>
            <h2 className="m3-title-medium text-on-surface capitalize min-w-[9rem] text-center">{MESES[mes.getMonth()]} {mes.getFullYear()}</h2>
            <button type="button" className="m3-icon-btn" onClick={() => mover(1)} aria-label="Mes siguiente"><span className="material-symbols-outlined">chevron_right</span></button>
            <InfoGrafico titulo="Calendario de ofertas"
              que="Cada día dice qué parte de los enlaces leídos estaba en oferta: precio con descuento o promoción (2x1, 3x2, 2.ª unidad)."
              formula="% del día = enlaces en oferta ÷ enlaces leídos ese día"
              lectura="Los días más oscuros son los de más ofertas. Toca un día para ver qué estuvo en oferta. Abajo, el patrón por día de la semana de cada cadena."
              ejemplo="Si Locatel sale oscuro todos los viernes, suele lanzar sus ofertas ese día." />
          </div>
          <span className="m3-body-small text-on-surface-variant">
            {totalMes.enlaces ? `${Math.round((totalMes.oferta / totalMes.enlaces) * 100)} % de las lecturas del mes en oferta` : ''}
          </span>
        </header>

        {cargando ? <div className="h-72 m3-skeleton rounded-2xl" aria-busy="true" /> : (
          <>
            <div className="m3-calendario" role="grid" aria-label={`Ofertas de ${MESES[mes.getMonth()]}`}>
              {DIAS.map(d => <div key={d} className="m3-calendario-cab" role="columnheader">{d}</div>)}
              {celdas.map((f, i) => {
                if (!f) return <div key={`v${i}`} aria-hidden="true" />;
                const d = porDia.get(f);
                const pct = d && d.enlaces ? (d.oferta / d.enlaces) * 100 : null;
                const t = pct == null ? null : tramo(pct);
                return (
                  <button key={f} type="button" role="gridcell" disabled={!d} onClick={() => setDia(dia === f ? null : f)}
                    className={`m3-calendario-dia ${t ? `m3-oferta-${t.clase}` : 'is-vacio'} ${dia === f ? 'is-elegido' : ''}`}
                    title={d ? `${d.oferta} de ${d.enlaces} enlaces en oferta${d.promo ? ` · ${d.promo} con promoción` : ''}` : 'Sin lecturas'}>
                    <span className="m3-calendario-num">{Number(f.slice(8))}</span>
                    {d && <span className="m3-calendario-pct">{Math.round(pct)} %</span>}
                    {d && d.oferta > 0 && <span className="m3-calendario-n">{d.oferta}</span>}
                  </button>
                );
              })}
            </div>
            <div className="m3-calor-leyenda mt-3" aria-label="Leyenda">
              {TRAMOS.map(t => <span key={t.clase}><i className={`m3-oferta-${t.clase}`} />{t.texto}</span>)}
            </div>
          </>
        )}
      </section>

      {dia && (
        <section className="m3-data-table" aria-label="Ofertas del día">
          <div className="m3-data-table-toolbar flex items-center justify-between">
            <h3 className="m3-title-small text-on-surface">
              Ofertas del {new Date(`${dia}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })}
              {cadena !== 'todos' ? ` · ${nombreCadena(cadena)}` : ''}
            </h3>
            <button type="button" className="m3-icon-btn m3-icon-btn-sm" onClick={() => setDia(null)} aria-label="Cerrar"><span className="material-symbols-outlined">close</span></button>
          </div>
          {detalle === 'cargando' ? <div className="h-32 m3-skeleton" /> : !detalle?.length ? (
            <p className="p-6 m3-body-medium text-on-surface-variant">Sin ofertas ese día.</p>
          ) : (
            <div className="overflow-x-auto max-h-[28rem]">
              <table className="m3-table m3-table-apilada">
                <thead className="m3-sticky-header"><tr><th>Producto</th><th>Cadena</th><th className="text-right">Precio</th><th className="text-right">Con oferta</th><th className="text-right">Descuento</th><th>Promoción</th></tr></thead>
                <tbody>
                  {detalle.map((o, i) => (
                    <tr key={i}>
                      <td data-label="Producto"><div className="m3-cell-primary m3-cell-clamp" title={o.producto_nombre}>{o.producto_nombre}</div><div className="m3-cell-secondary">{o.laboratorio}</div></td>
                      <td data-label="Cadena"><span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={o.cadena_id} tamano="xs" title="" />{nombreCadena(o.cadena_id)}</span></td>
                      <td data-label="Precio" className="text-right tabular-nums">{bs(o.precio_full_bs)}</td>
                      <td data-label="Con oferta" className="text-right tabular-nums">{bs(o.precio_desc_bs)}</td>
                      <td data-label="Descuento" className="text-right tabular-nums">{o.descuento == null ? '—' : `${Number(o.descuento).toLocaleString('es-VE')} %`}</td>
                      <td data-label="Promoción">{o.promocion || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {patron.length > 0 && (
        <section className="m3-dash-card" aria-label="Patrón por día de la semana">
          <header className="m3-dash-card-header items-center">
            <h2 className="m3-title-medium text-on-surface">¿Qué día de la semana descuenta cada cadena?</h2>
          </header>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-calor">
              <thead><tr><th>Cadena</th>{DIAS.map(d => <th key={d} className="text-center">{d}</th>)}</tr></thead>
              <tbody>
                {patron.map(p => (
                  <tr key={p.cadena}>
                    <td><span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={p.cadena} tamano="xs" title="" />{nombreCadena(p.cadena)}</span></td>
                    {p.dias.map((v, i) => (
                      <td key={i} className={`text-center tabular-nums ${v == null ? 'text-on-surface-variant' : `m3-oferta-${tramo(v).clase}`}`}>{v == null ? '—' : `${Math.round(v)} %`}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
