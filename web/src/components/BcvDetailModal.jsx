import { useState, useMemo, useEffect } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine
} from 'recharts';

export default function BcvDetailModal({ isOpen, onClose, rates = [], currentRate, bcv }) {
  const [timeRange, setTimeRange] = useState('30d'); // '7d', '30d', '90d', 'all'
  const [searchTerm, setSearchTerm] = useState('');
  const [editingManual, setEditingManual] = useState(false);
  const [manualVal, setManualVal] = useState('');

  // Lock scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

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

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-2 sm:p-4 animate-fade-in text-on-surface"
      onClick={onClose}
    >
      <div 
        className="bg-white rounded-[28px] shadow-2xl max-w-5xl w-full flex flex-col border border-outline-variant max-h-[92vh] overflow-hidden transform transition-all animate-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header Block */}
        <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between bg-surface-low/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
              <span className="material-symbols-outlined text-2xl">show_chart</span>
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-display font-extrabold text-primary flex items-center gap-2">
                Historial Completo & Análisis Tasa Oficial BCV
              </h2>
              <p className="text-xs text-on-surface-variant font-sans">
                Evolución de la cotización oficial del Banco Central de Venezuela
              </p>
            </div>
          </div>

          <button 
            onClick={onClose} 
            className="p-2 hover:bg-surface-high rounded-full text-on-surface-variant transition-colors flex items-center justify-center"
            title="Cerrar modal"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-6">

          {/* Top Key Indicator Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            
            {/* Tasa Actual */}
            <div className="p-4 rounded-2xl bg-surface-low border border-outline-variant/70 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-on-surface-variant uppercase font-mono tracking-wider">Tasa Actual</span>
                <span className="material-symbols-outlined text-primary text-lg">attach_money</span>
              </div>
              <div>
                <div className="text-2xl font-extrabold font-mono text-primary">
                  Bs {latestRate ? latestRate.toFixed(4) : '—'}
                </div>
                <div className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  Tasa de referencia de mercado
                </div>
              </div>
            </div>

            {/* Variación Día (%) */}
            <div className="p-4 rounded-2xl bg-surface-low border border-outline-variant/70 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-on-surface-variant uppercase font-mono tracking-wider">Var. Día</span>
                <span className={`material-symbols-outlined text-lg ${dailyVar.pct > 0 ? 'text-amber-600' : dailyVar.pct < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {dailyVar.pct > 0 ? 'trending_up' : dailyVar.pct < 0 ? 'trending_down' : 'trending_flat'}
                </span>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xl font-extrabold font-mono ${dailyVar.pct > 0 ? 'text-amber-700' : dailyVar.pct < 0 ? 'text-emerald-700' : 'text-slate-700'}`}>
                    {dailyVar.pct >= 0 ? `+${dailyVar.pct.toFixed(2)}%` : `${dailyVar.pct.toFixed(2)}%`}
                  </span>
                  <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded-full ${dailyVar.pct > 0 ? 'bg-amber-100 text-amber-800' : dailyVar.pct < 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                    {dailyVar.diff >= 0 ? `+Bs ${dailyVar.diff.toFixed(2)}` : `Bs ${dailyVar.diff.toFixed(2)}`}
                  </span>
                </div>
                <div className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  vs. anterior: Bs {dailyVar.prevVal ? dailyVar.prevVal.toFixed(2) : '—'}
                </div>
              </div>
            </div>

            {/* Variación Mes (%) */}
            <div className="p-4 rounded-2xl bg-surface-low border border-outline-variant/70 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-on-surface-variant uppercase font-mono tracking-wider">Var. Mes</span>
                <span className={`material-symbols-outlined text-lg ${monthlyVar.pct > 0 ? 'text-blue-600' : monthlyVar.pct < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {monthlyVar.pct > 0 ? 'stacked_line_chart' : monthlyVar.pct < 0 ? 'trending_down' : 'trending_flat'}
                </span>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xl font-extrabold font-mono ${monthlyVar.pct > 0 ? 'text-blue-700' : monthlyVar.pct < 0 ? 'text-emerald-700' : 'text-slate-700'}`}>
                    {monthlyVar.pct >= 0 ? `+${monthlyVar.pct.toFixed(2)}%` : `${monthlyVar.pct.toFixed(2)}%`}
                  </span>
                  <span className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded-full ${monthlyVar.pct > 0 ? 'bg-blue-100 text-blue-800' : monthlyVar.pct < 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                    {monthlyVar.diff >= 0 ? `+Bs ${monthlyVar.diff.toFixed(2)}` : `Bs ${monthlyVar.diff.toFixed(2)}`}
                  </span>
                </div>
                <div className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  vs. hace 30 días: Bs {monthlyVar.monthVal ? monthlyVar.monthVal.toFixed(2) : '—'}
                </div>
              </div>
            </div>

            {/* Rango (Mín / Max) */}
            <div className="p-4 rounded-2xl bg-surface-low border border-outline-variant/70 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-on-surface-variant uppercase font-mono tracking-wider">Rango en Período</span>
                <span className="material-symbols-outlined text-secondary text-lg">swap_vert</span>
              </div>
              <div>
                <div className="text-base font-extrabold font-mono text-on-surface flex items-center justify-between">
                  <span>Bs {rangeStats.min ? rangeStats.min.toFixed(2) : '—'}</span>
                  <span className="text-xs text-on-surface-variant font-normal">a</span>
                  <span>Bs {rangeStats.max ? rangeStats.max.toFixed(2) : '—'}</span>
                </div>
                <div className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  Promedio: Bs {rangeStats.avg ? rangeStats.avg.toFixed(2) : '—'}
                </div>
              </div>
            </div>

          </div>

          {/* Interactive Chart Section */}
          <div className="p-5 rounded-2xl border border-outline-variant bg-white space-y-4">
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
              <div className="flex items-center gap-1 bg-surface-low p-1 rounded-xl border border-outline-variant">
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
                        : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high/50'
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
                  <AreaChart data={chartData} margin={{ top: 10, right: 15, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="modalBcvGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#016874" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#016874" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e8e8ed" />
                    <XAxis dataKey="fecha" tick={{ fontSize: 11, fill: '#464650' }} />
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#464650' }} />
                    <Tooltip 
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload;
                          const startVal = chartData[0]?.valor || data.valor;
                          const varStartPct = startVal > 0 ? ((data.valor - startVal) / startVal) * 100 : 0;
                          return (
                            <div className="bg-white p-3 rounded-xl shadow-lg border border-outline-variant text-xs space-y-1 font-sans">
                              <p className="font-bold text-primary">{data.fecha} ({data.dayKey})</p>
                              <p className="font-mono text-sm font-extrabold text-on-surface">
                                Bs {Number(data.valor).toFixed(4)} / USD
                              </p>
                              <p className={`font-mono text-[11px] font-bold ${varStartPct >= 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
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
                    <ReferenceLine y={rangeStats.avg} stroke="#ea580c" strokeDasharray="3 3" label={{ value: `Prom: ${rangeStats.avg.toFixed(2)}`, fill: '#ea580c', fontSize: 10 }} />
                    <Area 
                      type="monotone" 
                      dataKey="valor" 
                      stroke="#016874" 
                      strokeWidth={2.5} 
                      fillOpacity={1} 
                      fill="url(#modalBcvGradient)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Historical Data Table Section */}
          <div className="p-5 rounded-2xl border border-outline-variant bg-white space-y-4">
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
                  <span className="material-symbols-outlined text-sm text-on-surface-variant absolute left-3 top-2.5">search</span>
                  <input
                    type="text"
                    placeholder="Buscar fecha o tasa..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="pl-8 pr-3 py-1.5 text-xs rounded-xl border border-outline-variant bg-surface-low focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary w-44 sm:w-60 font-sans"
                  />
                  {searchTerm && (
                    <button onClick={() => setSearchTerm('')} className="absolute right-2 top-2 text-on-surface-variant text-xs">×</button>
                  )}
                </div>

                {/* Export CSV Button */}
                <button
                  onClick={handleExportCSV}
                  className="px-3 py-1.5 text-xs font-bold font-mono bg-surface-low hover:bg-surface-high border border-outline-variant rounded-xl text-on-surface transition-all flex items-center gap-1.5"
                  title="Exportar historia a archivo CSV"
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  <span className="hidden sm:inline">Exportar CSV</span>
                </button>
              </div>
            </div>

            {/* Table Container */}
            <div className="max-h-64 overflow-y-auto rounded-xl border border-outline-variant">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-surface-low sticky top-0 z-10 border-b border-outline-variant text-on-surface-variant font-mono font-bold">
                  <tr>
                    <th className="p-3">Fecha</th>
                    <th className="p-3">Tasa Oficial (Bs/USD)</th>
                    <th className="p-3">Variación vs Anterior (%)</th>
                    <th className="p-3 text-right">Diferencia (Bs)</th>
                    <th className="p-3 text-center">Fuente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/60 font-sans">
                  {tableRows.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="p-6 text-center text-on-surface-variant italic">
                        No se encontraron registros que coincidan con la búsqueda.
                      </td>
                    </tr>
                  ) : (
                    tableRows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-surface-low/60 transition-colors">
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
                                ? 'bg-amber-50 text-amber-800 border border-amber-200' 
                                : row.pct < 0 
                                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' 
                                : 'bg-slate-100 text-slate-700'
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
                            <span className={row.diff > 0 ? 'text-amber-700' : row.diff < 0 ? 'text-emerald-700' : 'text-slate-600'}>
                              {row.diff >= 0 ? `+${row.diff.toFixed(2)}` : `${row.diff.toFixed(2)}`}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="p-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono capitalize ${
                            row.source === 'auto' ? 'bg-purple-100 text-purple-800' : row.source === 'manual' ? 'bg-amber-100 text-amber-800' : 'bg-primary/10 text-primary'
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
            <form onSubmit={handleSaveManual} className="p-4 rounded-2xl bg-surface-low border border-primary/40 flex flex-wrap items-center justify-between gap-3">
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
                  className="px-3 py-1.5 text-xs font-mono font-bold rounded-xl border border-outline-variant w-32 focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button type="submit" className="px-3 py-1.5 text-xs font-bold font-mono bg-primary text-on-primary rounded-xl hover:bg-primary/90 transition-all">
                  Guardar
                </button>
                <button type="button" onClick={() => setEditingManual(false)} className="px-3 py-1.5 text-xs font-bold font-mono bg-white border border-outline-variant rounded-xl hover:bg-surface-high transition-all">
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

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-surface-low border-t border-outline-variant flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2.5 bg-primary text-on-primary font-bold text-xs rounded-full hover:bg-primary/90 transition-all shadow-xs"
          >
            Entendido / Cerrar
          </button>
        </div>

      </div>
    </div>
  );
}
