import { useMemo, useState } from 'react';
import StatCard from '../StatCard';
import Select from '../Select';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import { useData } from '../../context/DataContext';
import { useRpc } from '../../hooks/useRpc';
import { normalizar } from '../formulario';
import { describirPresentacion } from '../../utils/presentacion';
import { Diferencia, mediana, pct } from '../dashboard/comun';
import { EstadoAnalisis } from './Estados';

// Comparador de periodos: tu precio frente al promedio del mercado en los
// ultimos N dias y en los N anteriores, producto por producto, y si el cambio
// vino de ti o del mercado. Lo calcula fn_comparar_periodos (fase 32).
const PERIODOS = [[7, '7 días vs los 7 anteriores'], [15, '15 días vs los 15 anteriores'], [30, '30 días vs los 30 anteriores']];
const UMBRAL_PP = 1; // puntos: menos que esto es "igual"

const usd = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const variacion = (a, b) => (a > 0 && b > 0 ? (b / a - 1) * 100 : null);

export default function ComparadorPeriodos() {
  const { productos = [] } = useData() || {};
  const [dias, setDias] = useState(7);
  const [mostrar, setMostrar] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const { filas, cargando, error, faltaSql } = useRpc('fn_comparar_periodos', { p_dias: dias });

  const porId = useMemo(() => new Map(productos.map(p => [String(p.id_interno), p])), [productos]);
  const datos = useMemo(() => filas
    .filter(f => f.dif_antes != null && f.dif_ahora != null && porId.has(String(f.id_interno)))
    .map(f => {
      const cambio = Number(f.dif_ahora) - Number(f.dif_antes);
      return {
        ...f,
        producto: porId.get(String(f.id_interno)),
        cambio,
        tuCambio: variacion(Number(f.tu_antes), Number(f.tu_ahora)),
        mercadoCambio: variacion(Number(f.prom_antes), Number(f.prom_ahora)),
        sentido: cambio <= -UMBRAL_PP ? 'barato' : cambio >= UMBRAL_PP ? 'caro' : 'igual',
      };
    }), [filas, porId]);

  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return datos
      .filter(x => (mostrar === 'todos' || x.sentido === mostrar)
        && (!t || normalizar(`${x.id_interno} ${x.producto.nombre} ${x.producto.principio_activo || ''}`).includes(t)))
      .sort((a, b) => Math.abs(b.cambio) - Math.abs(a.cambio));
  }, [datos, mostrar, busqueda]);

  const medAntes = mediana(datos.map(x => Number(x.dif_antes)));
  const medAhora = mediana(datos.map(x => Number(x.dif_ahora)));
  const abaratados = datos.filter(x => x.sentido === 'barato').length;
  const encarecidos = datos.filter(x => x.sentido === 'caro').length;

  return (
    <div className="space-y-4">
      <section className="m3-dash-filtros" aria-label="Periodo">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(dias)} onChange={e => setDias(Number(e.target.value))} aria-label="Periodos que se comparan" className="m3-filter-chip" leadingIcon="date_range">
            {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </Select>
          <FiltroChip etiqueta="Mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
            opciones={[['todos', 'Mostrar: todos'], ['barato', 'Más competitivos'], ['caro', 'Menos competitivos'], ['igual', 'Sin cambio']]} />
          <InfoGrafico
            titulo="Comparador de períodos"
            que="Para cada producto, tu precio frente al promedio del mercado en los últimos días y en el mismo número de días justo antes."
            formula={[
              'Cada periodo = el promedio de «tu precio ÷ promedio del mercado − 1» de sus días',
              'Cambio = ahora − antes, en puntos (pp)',
              '«Tú» y «Mercado» = cuánto cambió tu precio y el promedio del mercado entre un periodo y otro',
            ]}
            lectura="Un cambio negativo es bueno para competir: quedaste más barato frente al mercado. Mira «Tú» y «Mercado» para saber por qué: si tú no te moviste y el mercado subió, te abarataste sin hacer nada. Menos de 1 pp cuenta como sin cambio."
          />
        </div>
      </section>

      <EstadoAnalisis cargando={cargando} faltaSql={faltaSql} fase="la fase 32" error={error} hayFilas={datos.length > 0}
        vacio="Aún no hay suficientes días con tu precio y el de la competencia en los dos periodos.">
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="Resumen">
          <StatCard compacto label="Antes (mediana)" value={pct(medAntes)} icon="history" tono="neutral" hint={`Días ${dias * 2} a ${dias + 1} atrás`} />
          <StatCard compacto label="Ahora (mediana)" value={pct(medAhora)} icon="today" tono={medAhora > medAntes + UMBRAL_PP ? 'negative' : 'primary'} hint={`Últimos ${dias} días`} />
          <StatCard compacto label="Más competitivos" value={abaratados} icon="trending_down" tono="primary" hint="Quedaron más baratos frente al mercado" />
          <StatCard compacto label="Menos competitivos" value={encarecidos} icon="trending_up" tono={encarecidos ? 'negative' : 'neutral'} hint="Quedaron más caros frente al mercado" />
        </section>

        <section className="m3-data-table" aria-label="Productos">
          <div className="m3-data-table-toolbar flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, nombre o molécula" aria-label="Buscar producto" />
            </label>
            <span className="m3-label-large text-on-surface-variant md:ml-auto">{visibles.length} de {datos.length} productos</span>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right">Antes</th>
                  <th className="text-right">Ahora</th>
                  <th className="text-right" title="Ahora − antes, en puntos">Cambio</th>
                  <th className="text-right" title="Cuánto cambió tu precio">Tú</th>
                  <th className="text-right" title="Cuánto cambió el promedio del mercado">Mercado</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map(x => (
                  <tr key={x.id_interno}>
                    <td>
                      <div className="m3-cell-primary m3-cell-clamp max-w-[20rem]" title={x.producto.nombre}>{x.producto.nombre}</div>
                      <div className="m3-cell-secondary">{[x.id_interno, x.producto.concentracion, describirPresentacion(x.producto)].filter(v => v && v !== '—').join(' · ')}</div>
                    </td>
                    <td className="text-right whitespace-nowrap" data-label="Antes"><Diferencia valor={Number(x.dif_antes)} /></td>
                    <td className="text-right whitespace-nowrap" data-label="Ahora"><Diferencia valor={Number(x.dif_ahora)} /></td>
                    <td className="text-right whitespace-nowrap tabular-nums font-medium" data-label="Cambio">
                      <span className={x.sentido === 'caro' ? 'text-error' : x.sentido === 'barato' ? 'text-primary' : 'text-on-surface-variant'}>
                        {x.cambio > 0 ? '+' : x.cambio < 0 ? '−' : ''}{Math.abs(x.cambio).toFixed(1).replace('.', ',')} pp
                      </span>
                    </td>
                    <td className="text-right whitespace-nowrap tabular-nums" data-label="Tú" title={`${usd(x.tu_antes)} → ${usd(x.tu_ahora)}`}>{pct(x.tuCambio)}</td>
                    <td className="text-right whitespace-nowrap tabular-nums" data-label="Mercado" title={`${usd(x.prom_antes)} → ${usd(x.prom_ahora)}`}>{pct(x.mercadoCambio)}</td>
                  </tr>
                ))}
                {visibles.length === 0 && <tr><td colSpan={6} className="text-center text-on-surface-variant py-8">Ningún producto con estos filtros.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </EstadoAnalisis>
    </div>
  );
}
