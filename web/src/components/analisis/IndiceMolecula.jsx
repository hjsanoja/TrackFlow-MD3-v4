import { useMemo, useState } from 'react';
import StatCard from '../StatCard';
import Select from '../Select';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import { useRpc } from '../../hooks/useRpc';
import { normalizar } from '../formulario';
import { Diferencia, mediana, pct } from '../dashboard/comun';
import { EstadoAnalisis } from './Estados';

// Indice de precios por molecula: cuanto subio o bajo en dolares el precio
// del mercado de cada molecula (por unidad, base 100 al inicio del periodo).
// Lo calcula fn_indice_molecula (fase 32).
const PERIODOS = [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [180, 'Últimos 180 días']];
const UMBRAL = 1; // % : menos que esto es "estable"

export default function IndiceMolecula() {
  const [dias, setDias] = useState(90);
  const [mostrar, setMostrar] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const { filas, cargando, error, faltaSql } = useRpc('fn_indice_molecula', { p_dias: dias });

  const datos = useMemo(() => filas.map(f => ({
    ...f,
    variacion: Number(f.variacion),
    serie: (f.serie || []).map(Number),
    sentido: Number(f.variacion) >= UMBRAL ? 'sube' : Number(f.variacion) <= -UMBRAL ? 'baja' : 'estable',
  })), [filas]);

  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return datos
      .filter(x => (mostrar === 'todos' || x.sentido === mostrar) && (!t || normalizar(x.molecula).includes(t)))
      .sort((a, b) => b.variacion - a.variacion);
  }, [datos, mostrar, busqueda]);

  const med = mediana(datos.map(x => x.variacion));
  const suben = datos.filter(x => x.sentido === 'sube').length;
  const bajan = datos.filter(x => x.sentido === 'baja').length;

  return (
    <div className="space-y-4">
      <section className="m3-dash-filtros" aria-label="Periodo">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(dias)} onChange={e => setDias(Number(e.target.value))} aria-label="Periodo" className="m3-filter-chip" leadingIcon="date_range">
            {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </Select>
          <FiltroChip etiqueta="Mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
            opciones={[['todos', 'Mostrar: todas'], ['sube', 'Subieron'], ['baja', 'Bajaron'], ['estable', 'Estables (±1 %)']]} />
          <InfoGrafico
            titulo="Índice por molécula"
            que="Cuánto subió o bajó el precio del mercado de cada molécula (la competencia y tú), en dólares a la tasa de cada día y por unidad (tableta, ml…)."
            formula={[
              'Por producto: precio promedio del mercado por unidad de cada día ÷ el del primer día × 100',
              'Molécula = promedio de los índices de sus productos (así un empaque grande no pesa más)',
              'Variación = índice del último día − 100',
            ]}
            lectura="Una variación de +8 % quiere decir que esa molécula está 8 % más cara en dólares que al inicio del periodo: es inflación real, no la subida del dólar. Si tu precio no se movió y la molécula subió, te abarataste frente al mercado (y quizás tienes margen para subir)."
          />
        </div>
      </section>

      <EstadoAnalisis cargando={cargando} faltaSql={faltaSql} fase="la fase 32" error={error} hayFilas={datos.length > 0}
        vacio="Aún no hay suficientes días con precios para armar el índice.">
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="Resumen">
          <StatCard compacto label="Variación típica" value={pct(med)} icon="query_stats" tono={med > UMBRAL ? 'negative' : 'neutral'} hint={`Mediana de ${datos.length} moléculas`} />
          <StatCard compacto label="Subieron" value={suben} icon="trending_up" tono={suben ? 'negative' : 'neutral'} hint="Más de 1 % en dólares" />
          <StatCard compacto label="Bajaron" value={bajan} icon="trending_down" tono="primary" hint="Más de 1 % en dólares" />
          <StatCard compacto label="Estables" value={datos.length - suben - bajan} icon="horizontal_rule" tono="neutral" hint="Entre −1 % y +1 %" />
        </section>

        <section className="m3-data-table" aria-label="Moléculas">
          <div className="m3-data-table-toolbar flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar molécula" aria-label="Buscar molécula" />
            </label>
            <span className="m3-label-large text-on-surface-variant md:ml-auto">{visibles.length} de {datos.length} moléculas</span>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead>
                <tr>
                  <th>Molécula</th>
                  <th>Evolución</th>
                  <th className="text-right" title="Precio promedio del mercado por unidad">Por unidad, antes</th>
                  <th className="text-right">Por unidad, hoy</th>
                  <th className="text-right">Variación</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map(x => (
                  <tr key={x.molecula}>
                    <td>
                      <div className="m3-cell-primary first-letter:uppercase">{x.molecula}</div>
                      <div className="m3-cell-secondary">{x.productos} {x.productos === 1 ? 'producto' : 'productos'}</div>
                    </td>
                    <td data-label="Evolución"><Minilinea serie={x.serie} sentido={x.sentido} /></td>
                    <td className="text-right tabular-nums" data-label="Por unidad, antes">${Number(x.precio_unidad_inicio).toFixed(3)}</td>
                    <td className="text-right tabular-nums" data-label="Por unidad, hoy">${Number(x.precio_unidad_fin).toFixed(3)}</td>
                    <td className="text-right whitespace-nowrap" data-label="Variación"><Diferencia valor={x.variacion} /></td>
                  </tr>
                ))}
                {visibles.length === 0 && <tr><td colSpan={5} className="text-center text-on-surface-variant py-8">Ninguna molécula con estos filtros.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </EstadoAnalisis>
    </div>
  );
}

// Linea pequena del indice (base 100 punteada). Rojo si sube, azul si baja.
function Minilinea({ serie, sentido }) {
  if (serie.length < 2) return <span className="text-on-surface-variant">—</span>;
  const ancho = 120;
  const alto = 32;
  // Escala de al menos 6 puntos: un indice estable se ve plano, no ondulado.
  let min = Math.min(100, ...serie);
  let max = Math.max(100, ...serie);
  if (max - min < 6) { const centro = (max + min) / 2; min = centro - 3; max = centro + 3; }
  const rango = max - min;
  const x = (i) => (i / (serie.length - 1)) * ancho;
  const y = (v) => alto - 3 - ((v - min) / rango) * (alto - 6);
  const puntos = serie.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const color = sentido === 'sube' ? 'var(--md-sys-color-data-div-dear-2)' : sentido === 'baja' ? 'var(--md-sys-color-data-div-cheap-2)' : 'var(--md-sys-color-on-surface-variant)';
  return (
    <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label={`Índice de ${serie[0]} a ${serie.at(-1)}`}>
      <line x1="0" x2={ancho} y1={y(100)} y2={y(100)} stroke="var(--md-sys-color-outline-variant)" strokeDasharray="3 3" />
      <polyline points={puntos} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
