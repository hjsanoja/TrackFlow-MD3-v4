import { useState, useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine
} from 'recharts';
import ModalWrapper from './ModalWrapper';

export default function BcvDetailModal({ isOpen, onClose, rates = [], currentRate, bcv }) {
  const [timeRange, setTimeRange] = useState('30d'); // '7d', '30d', '90d', 'all'
  const [searchTerm, setSearchTerm] = useState('');
  const [editingManual, setEditingManual] = useState(false);
  const [manualVal, setManualVal] = useState('');

  // Ensure rates are sorted chronologically ascending
  const sortedRatesAsc = useMemo(() => {
    if (!rates || rates.length === 0) return [];
    const clone = [...rates];
    clone.sort((a, b) => {
      const dA = a.rawDate ? new Date(a.rawDate) : new Date(0);
      const dB = b.rawDate ? new Date(b.rawDate) : new Date(0);
      return dA - dB;
    });
    return clone;
  }, [rates]);

  // Latest rate
  const latestRate = useMemo(() => {
    if (currentRate && currentRate > 0) return currentRate;
    if (sortedRatesAsc.length > 0) return sortedRatesAsc[sortedRatesAsc.length - 1].valor;
    return 0;
  }, [currentRate, sortedRatesAsc]);

  // Previous rate (for daily variation)
  const prevRateObj = useMemo(() => {
    if (sortedRatesAsc.length < 2) return null;
    return sortedRatesAsc[sortedRatesAsc.length - 2];
  }, [sortedRatesAsc]);

  // Daily variation %
  const dailyVar = useMemo(() => {
    if (!prevRateObj || !prevRateObj.valor) return { pct: 0, diff: 0, prevVal: latestRate };
    const prevVal = prevRateObj.valor;
    const diff = latestRate - prevVal;
    const pct = (diff / prevVal) * 100;
    return { pct, diff, prevVal };
  }, [latestRate, prevRateObj]);

  // Monthly rate (approx 30 days ago or earliest rate in last 30 days)
  const monthRateObj = useMemo(() => {
    if (sortedRatesAsc.length === 0) return null;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Find rate closest to 30 days ago
    const candidates = sortedRatesAsc.filter(r => {
      const d = r.rawDate ? new Date(r.rawDate) : null;
      return d && d <= thirtyDaysAgo;
    });

    if (candidates.length > 0) {
      return candidates[candidates.length - 1];
    }
    // Fallback: earliest available rate in array
    return sortedRatesAsc[0];
  }, [sortedRatesAsc]);

  // Monthly variation %
  const monthlyVar = useMemo(() => {
    if (!monthRateObj || !monthRateObj.valor) return { pct: 0, diff: 0, monthVal: latestRate };
    const monthVal = monthRateObj.valor;
    const diff = latestRate - monthVal;
    const pct = (diff / monthVal) * 100;
    return { pct, diff, monthVal };
  }, [latestRate, monthRateObj]);

  // Filtered rates for chart based on selected time range
  const chartData = useMemo(() => {
    if (sortedRatesAsc.length === 0) return [];
    if (timeRange === '7d') return sortedRatesAsc.slice(-7);
    if (timeRange === '30d') return sortedRatesAsc.slice(-30);
    if (timeRange === '90d') return sortedRatesAsc.slice(-90);
    return sortedRatesAsc;
  }, [sortedRatesAsc, timeRange]);

  // Metrics for filtered range
  const rangeStats = useMemo(() => {
    if (chartData.length === 0) return { min: 0, max: 0, avg: 0 };
    const vals = chartData.map(d => Number(d.valor)).filter(v => !isNaN(v) && v > 0);
    if (vals.length === 0) return { min: 0, max: 0, avg: 0 };
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = sum / vals.length;
    return { min, max, avg };
  }, [chartData]);

  // Data table (sorted descending by date) with item-by-item variation
  const tableRows = useMemo(() => {
    if (sortedRatesAsc.length === 0) return [];
    const rows = [];
    for (let i = sortedRatesAsc.length - 1; i >= 0; i--) {
      const curr = sortedRatesAsc[i];
      const prev = i > 0 ? sortedRatesAsc[i - 1] : null;
      const diff = prev ? curr.valor - prev.valor : 0;
      const pct = prev && prev.valor > 0 ? (diff / prev.valor) * 100 : 0;
      rows.push({
        ...curr,
        diff,
        pct,
        prevVal: prev?.valor || null
      });
    }

    if (!searchTerm.trim()) return rows;
    const term = searchTerm.toLowerCase();
    return rows.filter(r => 
      (r.fecha && r.fecha.toLowerCase().includes(term)) ||
      (r.dayKey && r.dayKey.toLowerCase().includes(term)) ||
      (r.valor && String(r.valor).includes(term)) ||
      (r.source && r.source.toLowerCase().includes(term))
    );
  }, [sortedRatesAsc, searchTerm]);

  // CSV Export handler
  const handleExportCSV = () => {
    if (sortedRatesAsc.length === 0) return;
    let csv = 'Fecha,Key,Tasa_Bs_USD,Variacion_Dia_Percent,Fuente\n';
    tableRows.forEach(r => {
      csv += `"${r.fecha}","${r.dayKey}",${r.valor},${r.pct.toFixed(4)},"${r.source || 'oficial'}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `historial_bcv_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSaveManual = async (e) => {
    e.preventDefault();
    if (bcv && bcv.setManual) {
      const ok = await bcv.setManual(manualVal);
      if (ok) {
        setEditingManual(false);
        setManualVal('');
      }
    }
  };

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      title="Historial Completo & Análisis Tasa Oficial BCV"
      subtitle="Evolución de la cotización oficial del Banco Central de Venezuela"
      icon="show_chart"
      maxWidth="max-w-5xl"
      footer={
        <button
          onClick={onClose}
          className="m3-btn-primary h-9 px-6 text-xs"
        >
          Entendido / Cerrar
        </button>
      }
    >
      <div className="space-y-6">
        {/* Top Key Indicator Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Tasa Actual */}
          <div className="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/60 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase font-mono tracking-wider block">Tasa Actual</span>
              <div className="text-2xl font-extrabold font-mono text-primary">
                Bs {latestRate ? latestRate.toFixed(4) : '—'}
              </div>
              <p className="text-[11px] text-on-surface-variant font-sans">
                Tasa oficial BCV
              </p>
            </div>
            <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0 ml-3">
              <span className="material-symbols-outlined text-xl select-none">attach_money</span>
            </div>
          </div>

          {/* Variación Día (%) */}
          <div className="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/60 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase font-mono tracking-wider block">Var. Día</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-xl font-extrabold font-mono ${dailyVar.pct > 0 ? 'text-amber-700' : dailyVar.pct < 0 ? 'text-secondary' : 'text-on-surface'}`}>
                  {dailyVar.pct >= 0 ? `+${dailyVar.pct.toFixed(2)}%` : `${dailyVar.pct.toFixed(2)}%`}
                </span>
                <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded-full ${dailyVar.pct > 0 ? 'bg-amber-100 text-amber-900' : dailyVar.pct < 0 ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
                  {dailyVar.diff >= 0 ? `+Bs ${dailyVar.diff.toFixed(2)}` : `Bs ${dailyVar.diff.toFixed(2)}`}
                </span>
              </div>
              <p className="text-[11px] text-on-surface-variant font-sans">
                vs. anterior: Bs {dailyVar.prevVal ? dailyVar.prevVal.toFixed(2) : '—'}
              </p>
            </div>
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ml-3 ${dailyVar.pct > 0 ? 'bg-amber-50 border border-amber-200 text-amber-700' : dailyVar.pct < 0 ? 'bg-secondary-container/50 border border-secondary/20 text-secondary' : 'bg-surface-low border border-outline-variant/60 text-outline'}`}>
              <span className="material-symbols-outlined text-xl select-none">
                {dailyVar.pct > 0 ? 'trending_up' : dailyVar.pct < 0 ? 'trending_down' : 'trending_flat'}
              </span>
            </div>
          </div>

          {/* Variación Mes (%) */}
          <div className="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/60 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase font-mono tracking-wider block">Var. Mes</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-xl font-extrabold font-mono ${monthlyVar.pct > 0 ? 'text-primary' : monthlyVar.pct < 0 ? 'text-secondary' : 'text-on-surface'}`}>
                  {monthlyVar.pct >= 0 ? `+${monthlyVar.pct.toFixed(2)}%` : `${monthlyVar.pct.toFixed(2)}%`}
                </span>
                <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded-full ${monthlyVar.pct > 0 ? 'bg-primary-container text-on-primary-container' : monthlyVar.pct < 0 ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
                  {monthlyVar.diff >= 0 ? `+Bs ${monthlyVar.diff.toFixed(2)}` : `Bs ${monthlyVar.diff.toFixed(2)}`}
                </span>
              </div>
              <p className="text-[11px] text-on-surface-variant font-sans">
                vs. 30 días: Bs {monthlyVar.monthVal ? monthlyVar.monthVal.toFixed(2) : '—'}
              </p>
            </div>
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ml-3 ${monthlyVar.pct > 0 ? 'bg-primary/10 border border-primary/20 text-primary' : monthlyVar.pct < 0 ? 'bg-secondary-container/50 border border-secondary/20 text-secondary' : 'bg-surface-low border border-outline-variant/60 text-outline'}`}>
              <span className="material-symbols-outlined text-xl select-none">
                {monthlyVar.pct > 0 ? 'stacked_line_chart' : monthlyVar.pct < 0 ? 'trending_down' : 'trending_flat'}
              </span>
            </div>
          </div>

          {/* Rango (Mín / Max) */}
          <div className="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/60 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase font-mono tracking-wider block">Rango en Período</span>
              <div className="text-sm font-extrabold font-mono text-on-surface flex items-center gap-1.5">
                <span>Bs {rangeStats.min ? rangeStats.min.toFixed(2) : '—'}</span>
                <span className="text-xs text-on-surface-variant font-normal">→</span>
                <span>Bs {rangeStats.max ? rangeStats.max.toFixed(2) : '—'}</span>
              </div>
              <p className="text-[11px] text-on-surface-variant font-sans">
                Promedio: Bs {rangeStats.avg ? rangeStats.avg.toFixed(2) : '—'}
              </p>
            </div>
            <div className="w-11 h-11 rounded-2xl bg-secondary-container/50 border border-secondary/20 flex items-center justify-center text-secondary shrink-0 ml-3">
              <span className="material-symbols-outlined text-xl select-none">swap_vert</span>
            </div>
          </div>
        </div>

        {/* Interactive Chart Section */}
        <div className="p-5 rounded-2xl border border-outline-variant/60 bg-surface-container-lowest space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-bold text-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">area_chart</span>
                Gráfico Interactivo de Evolución
              </h3>
              <p className="text-xs text-on-surface-variant">
                Monitoreo de tendencia por período de tiempo
              </p>
            </div>

            {/* Time Range Selector Buttons */}
            <div className="flex items-center gap-1 bg-surface-container-low p-1 rounded-xl border border-outline-variant/60">
              {[
                { id: '7d', label: '7 Días' },
                { id: '30d', label: '30 Días' },
                { id: '90d', label: '90 Días' },
                { id: 'all', label: 'Todo' }
              ].map(b => (
                <button
                  key={b.id}
                  onClick={() => setTimeRange(b.id)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all ${
                    timeRange === b.id
                      ? 'bg-primary text-on-primary shadow-xs'
                      : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* Chart Container */}
          <div className="h-72 w-full pt-2">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-on-surface-variant italic">
                No hay suficientes datos para graficar este período.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart 
                  key={`modal-bcv-${timeRange}-${chartData.length}`}
                  data={chartData} 
                  margin={{ top: 10, right: 15, left: -15, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="modalBcvGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#040d53" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#040d53" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e1e2ec" />
                  <XAxis dataKey="fecha" tick={{ fontSize: 11, fill: '#464650' }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#464650' }} />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        const startVal = chartData[0]?.valor || data.valor;
                        const varStartPct = startVal > 0 ? ((data.valor - startVal) / startVal) * 100 : 0;
                        return (
                          <div className="bg-surface-container-lowest p-3 rounded-xl shadow-elevation-3 border border-outline-variant text-xs space-y-1 font-sans">
                            <p className="font-bold text-primary">{data.fecha} ({data.dayKey})</p>
                            <p className="font-mono text-sm font-extrabold text-on-surface">
                              Bs {Number(data.valor).toFixed(4)} / USD
                            </p>
                            <p className={`font-mono text-[11px] font-bold ${varStartPct >= 0 ? 'text-amber-700' : 'text-secondary'}`}>
                              Var. en período: {varStartPct >= 0 ? `+${varStartPct.toFixed(2)}%` : `${varStartPct.toFixed(2)}%`}
                            </p>
                            <p className="text-[10px] text-on-surface-variant capitalize">
                              Fuente: {data.source || 'oficial'}
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={rangeStats.avg} stroke="#c00100" strokeDasharray="3 3" label={{ value: `Prom: ${rangeStats.avg.toFixed(2)}`, fill: '#c00100', fontSize: 10 }} />
                  <Area 
                    type="monotone" 
                    dataKey="valor" 
                    stroke="#040d53" 
                    strokeWidth={2.5} 
                    fillOpacity={1} 
                    fill="url(#modalBcvGradient)" 
                    isAnimationActive={true}
                    animationDuration={750}
                    animationBegin={0}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Historical Data Table Section */}
        <div className="p-5 rounded-2xl border border-outline-variant/60 bg-surface-container-lowest space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-bold text-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">table_chart</span>
                Detalle Histórico de Registros ({tableRows.length})
              </h3>
              <p className="text-xs text-on-surface-variant">
                Lista cronológica detallada de tasas oficiales registradas
              </p>
            </div>

            <div className="flex items-center gap-2">
              {/* Search Box */}
              <div className="relative">
                <span className="material-symbols-outlined text-[16px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none select-none">search</span>
                <input
                  type="text"
                  placeholder="Buscar fecha o tasa..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="pl-9 pr-7 py-1.5 text-xs rounded-xl border border-outline-variant/60 bg-surface-container-low focus:bg-surface-container-lowest focus:outline-none focus:ring-2 focus:ring-primary w-44 sm:w-60 font-sans text-on-surface"
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-xs font-bold w-4 h-4 flex items-center justify-center rounded-full">×</button>
                )}
              </div>

              {/* Export CSV Button */}
              <button
                onClick={handleExportCSV}
                className="m3-btn-outline h-8 px-3 text-xs"
                title="Exportar historia a archivo CSV"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                <span className="hidden sm:inline">Exportar CSV</span>
              </button>
            </div>
          </div>

          {/* Table Container */}
          <div className="max-h-64 overflow-y-auto rounded-xl border border-outline-variant/60">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-surface-container-low sticky top-0 z-10 border-b border-outline-variant/60 text-on-surface-variant font-mono font-bold">
                <tr>
                  <th className="p-3">Fecha</th>
                  <th className="p-3">Tasa Oficial (Bs/USD)</th>
                  <th className="p-3">Variación vs Anterior (%)</th>
                  <th className="p-3 text-right">Diferencia (Bs)</th>
                  <th className="p-3 text-center">Fuente</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/40 font-sans">
                {tableRows.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="p-6 text-center text-on-surface-variant italic">
                      No se encontraron registros que coincidan con la búsqueda.
                    </td>
                  </tr>
                ) : (
                  tableRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-surface-container-low/60 transition-colors">
                      <td className="p-3 font-semibold text-on-surface">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-primary font-bold">{row.fecha}</span>
                          <span className="text-[10px] text-on-surface-variant">({row.dayKey})</span>
                        </div>
                      </td>
                      <td className="p-3 font-mono font-extrabold text-primary text-sm">
                        Bs {Number(row.valor).toFixed(4)}
                      </td>
                      <td className="p-3">
                        {row.prevVal ? (
                          <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono ${
                            row.pct > 0 
                              ? 'bg-amber-50 text-amber-900 border border-amber-200' 
                              : row.pct < 0 
                              ? 'bg-secondary-container text-on-secondary-container border border-secondary/20' 
                              : 'bg-surface-container-high text-on-surface-variant'
                          }`}>
                            <span className="material-symbols-outlined text-xs">
                              {row.pct > 0 ? 'arrow_drop_up' : row.pct < 0 ? 'arrow_drop_down' : 'remove'}
                            </span>
                            {row.pct >= 0 ? `+${row.pct.toFixed(2)}%` : `${row.pct.toFixed(2)}%`}
                          </span>
                        ) : (
                          <span className="text-on-surface-variant font-mono text-[11px]">—</span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono font-semibold">
                        {row.prevVal ? (
                          <span className={row.diff > 0 ? 'text-amber-800' : row.diff < 0 ? 'text-secondary' : 'text-on-surface-variant'}>
                            {row.diff >= 0 ? `+${row.diff.toFixed(2)}` : `${row.diff.toFixed(2)}`}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono capitalize ${
                          row.source === 'auto' ? 'bg-primary-container text-on-primary-container' : row.source === 'manual' ? 'bg-amber-100 text-amber-900' : 'bg-surface-container-high text-on-surface'
                        }`}>
                          {row.source || 'oficial'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Manual Rate Edit Banner / Action */}
        {editingManual ? (
          <form onSubmit={handleSaveManual} className="p-4 rounded-2xl bg-surface-container-low border border-primary/30 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">edit_note</span>
              <div>
                <div className="text-xs font-bold text-primary">Registrar Tasa Manualmente</div>
                <div className="text-[11px] text-on-surface-variant">Ingresa la nueva tasa del día en Bolívares</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Ej: 745.50"
                value={manualVal}
                onChange={e => setManualVal(e.target.value)}
                className="px-3 py-1.5 text-xs font-mono font-bold rounded-xl border border-outline-variant/60 w-32 focus:outline-none focus:ring-2 focus:ring-primary bg-surface-container-lowest text-on-surface"
                autoFocus
              />
              <button type="submit" className="m3-btn-primary h-8 px-3 text-xs">
                Guardar
              </button>
              <button type="button" onClick={() => setEditingManual(false)} className="m3-btn-outline h-8 px-3 text-xs">
                Cancelar
              </button>
            </div>
          </form>
        ) : (
          <div className="flex justify-between items-center text-xs text-on-surface-variant">
            <span>* Los datos provienen del Banco Central de Venezuela y sincronizaciones automatizadas.</span>
            <button
              onClick={() => { setEditingManual(true); setManualVal(latestRate ? String(latestRate) : ''); }}
              className="text-primary hover:underline font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">edit</span>
              Ingresar Tasa Manual
            </button>
          </div>
        )}
      </div>
    </ModalWrapper>
  );
}
