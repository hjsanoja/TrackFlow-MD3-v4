import { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import ModalWrapper from './ModalWrapper';
import StatCard from './StatCard';
import Select from './Select';
import { exportToCSV } from '../utils/exportUtils';
import { tokensGrafico } from '../utils/chartTokens';
import { leerColor, pct } from './dashboard/comun';

// Tasa BCV: historia, variacion y cambio manual. Mismo lenguaje que el resto
// del panel: indicadores compactos, un grafico, una tabla y un formulario.
const PERIODOS = [['7', 'Últimos 7 días'], ['30', 'Últimos 30 días'], ['90', 'Últimos 90 días'], ['todo', 'Toda la historia']];
const bs = (v, dec = 2) => (v == null || isNaN(v) ? '—' : `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`);
const fechaCorta = (d) => new Date(d).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });
const fechaLarga = (d) => new Date(d).toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const FUENTES = { manual: 'Manual', auto: 'Automática', oficial: 'BCV', BCV: 'BCV' };

export default function BcvDetailModal({ isOpen, onClose, rates = [], currentRate, bcv }) {
  const [periodo, setPeriodo] = useState('30');
  const [cambiando, setCambiando] = useState(false);
  const [valor, setValor] = useState('');
  const [guardando, setGuardando] = useState(false);

  const orden = useMemo(() => [...(rates || [])]
    .filter(r => Number(r.valor) > 0)
    .sort((a, b) => new Date(a.rawDate || 0) - new Date(b.rawDate || 0)), [rates]);

  const actual = currentRate > 0 ? currentRate : orden.at(-1)?.valor || null;
  const anterior = orden.length >= 2 ? orden.at(-2).valor : null;
  const hace30 = useMemo(() => {
    const limite = Date.now() - 30 * 864e5;
    return [...orden].reverse().find(r => new Date(r.rawDate).getTime() <= limite) || orden[0];
  }, [orden]);

  const serie = useMemo(() => (periodo === 'todo' ? orden : orden.slice(-Number(periodo))), [orden, periodo]);
  const valores = serie.map(r => Number(r.valor));
  const minimo = valores.length ? Math.min(...valores) : null;
  const maximo = valores.length ? Math.max(...valores) : null;
  const promedio = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;

  // Tabla: del mas reciente al mas viejo, con el cambio frente al dia anterior.
  const filas = useMemo(() => {
    const lista = [];
    for (let i = orden.length - 1; i >= 0; i--) {
      const r = orden[i];
      const previo = orden[i - 1];
      lista.push({ ...r, cambio: previo?.valor > 0 ? (r.valor / previo.valor - 1) * 100 : null });
    }
    return lista;
  }, [orden]);

  const exportar = () => {
    if (!filas.length) return;
    exportToCSV('tasa_bcv_historia', [
      { key: 'fecha', label: 'Fecha' }, { key: 'tasa', label: 'Tasa (Bs por dólar)' },
      { key: 'cambio', label: 'Cambio frente al día anterior (%)' }, { key: 'fuente', label: 'Fuente' },
    ], filas.map(r => ({
      fecha: new Date(r.rawDate).toISOString().slice(0, 10),
      tasa: Number(r.valor).toFixed(4),
      cambio: r.cambio == null ? '' : r.cambio.toFixed(2),
      fuente: FUENTES[r.source] || r.source || 'BCV',
    })));
  };

  const guardar = async (e) => {
    e.preventDefault();
    if (!bcv?.setManual) return;
    setGuardando(true);
    const ok = await bcv.setManual(valor);
    setGuardando(false);
    if (ok) { setCambiando(false); setValor(''); }
  };

  const tg = tokensGrafico();
  const color = leerColor('--md-sys-color-data-cat-1', '#2a78d6');

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      title="Tasa BCV"
      subtitle="Bolívares por dólar según el Banco Central de Venezuela. Se usa para pasar todos los precios a dólares."
      icon="currency_exchange"
      maxWidth="max-w-4xl"
      footer={(
        <>
          <button type="button" onClick={exportar} className="m3-btn-text" disabled={!filas.length}>
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar</span>
          </button>
          <button type="button" onClick={onClose} className="m3-btn-primary">Cerrar</button>
        </>
      )}
    >
      <div className="space-y-5">
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="Indicadores de la tasa">
          <StatCard compacto label="Tasa actual (Bs)" value={actual ? Number(actual).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} icon="payments" tono="primary"
            hint={bcv?.updatedAt ? `Del ${fechaCorta(bcv.updatedAt)} · ${FUENTES[bcv.source] || bcv.source || 'BCV'}` : 'Última registrada'} />
          <StatCard compacto label="Frente al día anterior" value={pct(anterior ? (actual / anterior - 1) * 100 : null, 2)} icon="today" tono="neutral"
            hint={anterior ? `Antes: ${bs(anterior)}` : 'Sin día anterior'} />
          <StatCard compacto label="En 30 días" value={pct(hace30?.valor ? (actual / hace30.valor - 1) * 100 : null)} icon="date_range" tono="neutral"
            hint={hace30 ? `El ${fechaCorta(hace30.rawDate)}: ${bs(hace30.valor)}` : 'Sin datos'} />
          <StatCard compacto label="Subió en el periodo (Bs)" value={minimo != null ? Number(maximo - minimo).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} icon="height" tono="neutral"
            hint={minimo != null ? `De ${bs(minimo)} a ${bs(maximo)}` : 'Sin datos'} />
        </section>

        <section className="m3-dash-card" aria-label="Historia de la tasa">
          <header className="m3-dash-card-header flex-wrap">
            <div className="min-w-0">
              <h3 className="m3-title-medium text-on-surface">Historia</h3>
              <p className="m3-body-small text-on-surface-variant">Una tasa por día. La línea punteada es el promedio del periodo ({bs(promedio)}).</p>
            </div>
            <Select value={periodo} onChange={e => setPeriodo(e.target.value)} aria-label="Periodo" className="m3-filter-chip" leadingIcon="date_range">
              {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </Select>
          </header>
          {serie.length < 2 ? (
            <div className="h-56 flex items-center justify-center text-on-surface-variant m3-body-medium">Aún no hay suficientes tasas guardadas.</div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={serie.map(r => ({ fecha: r.rawDate, valor: Number(r.valor), fuente: r.source }))} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
                  <XAxis dataKey="fecha" tickFormatter={fechaCorta} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={{ stroke: tg.rejilla }} minTickGap={28} />
                  <YAxis domain={['auto', 'auto']} tickFormatter={v => Number(v).toLocaleString('es-VE', { maximumFractionDigits: 0 })} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
                  {promedio != null && <ReferenceLine y={promedio} stroke={tg.eje} strokeDasharray="4 4" strokeOpacity={0.7} />}
                  <Tooltip content={<TooltipTasa />} cursor={{ stroke: tg.eje, strokeOpacity: 0.3 }} />
                  <Line type="monotone" dataKey="valor" stroke={color} strokeWidth={2} dot={serie.length <= 31 ? { r: 2.5 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="m3-dash-card" aria-label="Cambiar la tasa a mano">
          {cambiando ? (
            <form onSubmit={guardar} className="flex flex-col sm:flex-row sm:items-end gap-3">
              <label className="flex-1 min-w-0 space-y-1">
                <span className="m3-label-large text-on-surface">Tasa de hoy (Bs por dólar)</span>
                <input type="text" inputMode="decimal" autoFocus value={valor} onChange={e => setValor(e.target.value)}
                  className="m3-input" placeholder={actual ? String(actual) : 'Ej: 150,25'} />
                {bcv?.error && <span className="m3-body-small text-error">{bcv.error}</span>}
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setCambiando(false); setValor(''); }} className="m3-btn-text">Cancelar</button>
                <button type="submit" className="m3-btn-primary" disabled={guardando || !valor.trim()}>{guardando ? 'Guardando…' : 'Guardar tasa'}</button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <p className="m3-body-medium text-on-surface-variant flex-1">
                La tasa se lee sola cada día. Si el BCV no la publicó o está mal, puedes poner la de hoy a mano.
              </p>
              <button type="button" onClick={() => { setCambiando(true); setValor(actual ? String(actual) : ''); }} className="m3-btn-outline">
                <span className="material-symbols-outlined text-base">edit</span>
                <span>Cambiar a mano</span>
              </button>
            </div>
          )}
        </section>

        <section className="m3-data-table" aria-label="Tasas guardadas">
          <div className="overflow-auto max-h-72">
            <table className="m3-table">
              <thead className="m3-sticky-header">
                <tr>
                  <th>Fecha</th>
                  <th className="text-right">Tasa (Bs por dólar)</th>
                  <th className="text-right">Frente al día anterior</th>
                  <th>Fuente</th>
                </tr>
              </thead>
              <tbody>
                {filas.map(r => (
                  <tr key={r.dayKey || String(r.rawDate)}>
                    <td className="whitespace-nowrap first-letter:uppercase">{fechaLarga(r.rawDate)}</td>
                    <td className="text-right tabular-nums font-medium">{bs(r.valor, 4)}</td>
                    <td className="text-right tabular-nums">{r.cambio == null ? '—' : pct(r.cambio, 2)}</td>
                    <td><span className="m3-status">{FUENTES[r.source] || r.source || 'BCV'}</span></td>
                  </tr>
                ))}
                {filas.length === 0 && <tr><td colSpan={4} className="text-center text-on-surface-variant py-8">Aún no hay tasas guardadas.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </ModalWrapper>
  );
}

function TooltipTasa({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium first-letter:uppercase">{fechaLarga(d.fecha)}</div>
      <div>{bs(d.valor, 4)} por dólar</div>
      <div className="text-on-surface-variant">{FUENTES[d.fuente] || d.fuente || 'BCV'}</div>
    </div>
  );
}
