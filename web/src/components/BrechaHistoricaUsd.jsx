import { useState, useMemo } from 'react';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine
} from 'recharts';

export default function BrechaHistoricaUsd({ user, userDoc }) {
  const { productos = [], productosCompetencia = [], historicoPrecios = [], bcvRates = [] } = useData();
  const bcv = useBcvRate();
  const currentBcv = bcv?.rate || 853.5;

  // Selector de producto propio activo
  const [productoSeleccionadoId, setProductoSeleccionadoId] = useState('');
  const [cadenaSeleccionada, setCadenaSeleccionada] = useState('todas');
  const [rangoDias, setRangoDias] = useState(60); // 15, 30, 60, 90, 365
  const [busquedaProd, setBusquedaProd] = useState('');

  // Indexar tasas BCV históricas por fecha 'YYYY-MM-DD'
  const bcvPorFecha = useMemo(() => {
    const map = new Map();
    bcvRates.forEach(b => {
      if (b.rawDate) {
        const iso = b.rawDate.toISOString().slice(0, 10);
        map.set(iso, Number(b.valor));
      } else if (b.fecha) {
        map.set(b.fecha, Number(b.valor));
      }
    });
    return map;
  }, [bcvRates]);

  // Fallback para obtener tasa BCV más cercana a una fecha
  const obtenerTasaBcvFecha = (fechaObj) => {
    if (!fechaObj) return 853.5;
    const iso = fechaObj instanceof Date ? fechaObj.toISOString().slice(0, 10) : String(fechaObj).slice(0, 10);
    if (bcvPorFecha.has(iso)) return bcvPorFecha.get(iso);

    // Buscar la tasa más cercana en bcvRates
    if (bcvRates.length > 0) {
      const targetTs = new Date(iso).getTime();
      let bestDiff = Infinity;
      let bestVal = Number(bcvRates[bcvRates.length - 1].valor || 853.5);
      for (const b of bcvRates) {
        if (b.rawDate) {
          const diff = Math.abs(b.rawDate.getTime() - targetTs);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestVal = Number(b.valor);
          }
        }
      }
      return bestVal;
    }

    return 853.5;
  };

  // Filtrar lista de productos propios disponibles
  const productosPropiosConDatos = useMemo(() => {
    // Buscar qué IDs tienen histórico de precios
    const idsConHistorico = new Set();
    historicoPrecios.forEach(h => {
      if (h.id_producto_propio) idsConHistorico.add(String(h.id_producto_propio).trim());
    });

    const lista = productos.filter(p => {
      const pId = String(p.id_interno || p.id).trim();
      return idsConHistorico.has(pId) || true; // Incluir todos los productos
    });

    if (busquedaProd.trim()) {
      const q = busquedaProd.toLowerCase();
      return lista.filter(p => (p.nombre || '').toLowerCase().includes(q) || (p.principio_activo || '').toLowerCase().includes(q));
    }
    return lista;
  }, [productos, historicoPrecios, busquedaProd]);

  // Si no hay producto seleccionado, seleccionar el primero
  const prodActivo = useMemo(() => {
    if (productoSeleccionadoId) {
      return productos.find(p => String(p.id_interno || p.id).trim() === String(productoSeleccionadoId).trim()) || productos[0];
    }
    return productos[0] || null;
  }, [productos, productoSeleccionadoId]);

  // Obtener cadenas presentes en el histórico para este producto
  const cadenasDisponibles = useMemo(() => {
    if (!prodActivo) return [];
    const pId = String(prodActivo.id_interno || prodActivo.id).trim();
    const setCads = new Set();
    historicoPrecios.forEach(h => {
      if (String(h.id_producto_propio).trim() === pId && h.cadena) {
        setCads.add(h.cadena);
      }
    });
    return Array.from(setCads).sort();
  }, [prodActivo, historicoPrecios]);

  // Construir serie de tiempo diaria combinando Propio vs Competencia con Tasa BCV exacta de cada día
  const datosSerieHistorica = useMemo(() => {
    if (!prodActivo) return { puntosGrafico: [], tablaAuditoria: [], metricas: null };

    const pId = String(prodActivo.id_interno || prodActivo.id).trim();
    const ahora = Date.now();
    const limiteTiempo = ahora - (rangoDias * 24 * 60 * 60 * 1000);

    // 1. Filtrar registros históricos correspondientes a este producto
    const histProd = historicoPrecios.filter(h => {
      if (String(h.id_producto_propio).trim() !== pId) return false;
      if (cadenaSeleccionada !== 'todas' && h.cadena !== cadenaSeleccionada) return false;
      const ts = h.scraped_at ? new Date(h.scraped_at).getTime() : 0;
      return ts >= limiteTiempo;
    });

    // 2. Agrupar mediciones por fecha ('YYYY-MM-DD')
    const porFecha = new Map(); // key: 'YYYY-MM-DD' -> { propios: [], competidores: [], tasa_bcv: num }

    histProd.forEach(h => {
      const fechaObj = h.scraped_at ? new Date(h.scraped_at) : new Date();
      const fechaKey = fechaObj.toISOString().slice(0, 10);

      if (!porFecha.has(fechaKey)) {
        porFecha.set(fechaKey, {
          fechaKey,
          fechaLabel: fechaObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }),
          fechaObj,
          tasa_bcv: h.tasa_bcv || obtenerTasaBcvFecha(fechaObj),
          propios: [],
          competidores: []
        });
      }

      const grupo = porFecha.get(fechaKey);
      const precioBs = Number(h.precio_desc_bs || h.precio_full_bs || 0);
      const tasa = Number(grupo.tasa_bcv) > 0 ? Number(grupo.tasa_bcv) : 853.5;
      const precioUsd = Number(h.precio_desc_usd || (precioBs / tasa));

      if (precioBs > 0) {
        const item = {
          ...h,
          precio_bs: precioBs,
          precio_usd: precioUsd,
          tasa_bcv: tasa
        };

        // Clasificar si es propio (La Sante / Pharmetique) o competidor
        const esPropio = (h.marca || '').toUpperCase().includes('LA SANTE') ||
                         (h.marca || '').toUpperCase().includes('PHARMETIQUE') ||
                         h.tipo === 'propio';

        if (esPropio) {
          grupo.propios.push(item);
        } else {
          grupo.competidores.push(item);
        }
      }
    });

    // Si no hay competidores en historico_precios para ese producto, buscar la competencia en productosCompetencia
    const compFallback = productosCompetencia.filter(pc => String(pc.id_producto_propio).trim() === pId);

    // 3. Ordenar cronológicamente y calcular Brecha en USD diaria
    const fechasOrdenadas = Array.from(porFecha.values()).sort((a, b) => a.fechaObj.getTime() - b.fechaObj.getTime());

    const puntosGrafico = [];
    const tablaAuditoria = [];
    let sumBrechaPct = 0;
    let countBrecha = 0;
    let maxBrechaFav = -Infinity;
    let maxBrechaDesf = Infinity;

    fechasOrdenadas.forEach(f => {
      const avgPropioUsd = f.propios.length > 0
        ? f.propios.reduce((acc, x) => acc + x.precio_usd, 0) / f.propios.length
        : (prodActivo.pvp_propio_usd || null);

      const avgPropioBs = f.propios.length > 0
        ? f.propios.reduce((acc, x) => acc + x.precio_bs, 0) / f.propios.length
        : (avgPropioUsd && f.tasa_bcv ? avgPropioUsd * f.tasa_bcv : null);

      let avgCompUsd = null;
      let avgCompBs = null;
      let compNombre = '';

      if (f.competidores.length > 0) {
        avgCompUsd = f.competidores.reduce((acc, x) => acc + x.precio_usd, 0) / f.competidores.length;
        avgCompBs = f.competidores.reduce((acc, x) => acc + x.precio_bs, 0) / f.competidores.length;
        compNombre = f.competidores.map(c => c.marca || c.nombre).join(', ');
      } else if (compFallback.length > 0) {
        // Usar precio de catálogo de competencia convertido a esa tasa BCV histórica
        const pBs = compFallback[0].ultimo_precio_desc_bs || compFallback[0].ultimo_precio_full_bs;
        if (pBs && f.tasa_bcv) {
          avgCompBs = pBs;
          avgCompUsd = pBs / f.tasa_bcv;
          compNombre = compFallback[0].marca || 'Competidor';
        }
      }

      let brechaPct = null;
      let brechaUsd = null;

      if (avgPropioUsd && avgCompUsd && avgCompUsd > 0) {
        brechaUsd = avgPropioUsd - avgCompUsd;
        brechaPct = ((avgPropioUsd - avgCompUsd) / avgCompUsd) * 100;
        sumBrechaPct += brechaPct;
        countBrecha++;

        if (brechaPct < maxBrechaFav) maxBrechaFav = brechaPct;
        if (brechaPct > maxBrechaDesf) maxBrechaDesf = brechaPct;
      }

      const punto = {
        fecha: f.fechaLabel,
        fechaKey: f.fechaKey,
        tasa_bcv: Number(f.tasa_bcv.toFixed(2)),
        precio_propio_usd: avgPropioUsd ? Number(avgPropioUsd.toFixed(2)) : null,
        precio_comp_usd: avgCompUsd ? Number(avgCompUsd.toFixed(2)) : null,
        brecha_pct: brechaPct !== null ? Number(brechaPct.toFixed(1)) : null,
        brecha_usd: brechaUsd !== null ? Number(brechaUsd.toFixed(2)) : null
      };

      puntosGrafico.push(punto);

      tablaAuditoria.push({
        fecha: f.fechaKey,
        fechaLabel: f.fechaLabel,
        tasa_bcv: f.tasa_bcv,
        propio_bs: avgPropioBs,
        propio_usd: avgPropioUsd,
        comp_bs: avgCompBs,
        comp_usd: avgCompUsd,
        comp_nombre: compNombre || 'Mercado',
        brecha_pct: brechaPct,
        brecha_usd: brechaUsd,
        cadena: f.propios[0]?.cadena || cadenaSeleccionada
      });
    });

    // Métricas del Período
    const tasaInicial = fechasOrdenadas.length > 0 ? fechasOrdenadas[0].tasa_bcv : currentBcv;
    const tasaFinal = fechasOrdenadas.length > 0 ? fechasOrdenadas[fechasOrdenadas.length - 1].tasa_bcv : currentBcv;
    const devaluacionPct = tasaInicial > 0 ? ((tasaFinal - tasaInicial) / tasaInicial) * 100 : 0;
    const brechaPromedio = countBrecha > 0 ? sumBrechaPct / countBrecha : 0;

    return {
      puntosGrafico,
      tablaAuditoria: tablaAuditoria.reverse(), // Más reciente arriba
      metricas: {
        brechaPromedio,
        devaluacionPct,
        tasaInicial,
        tasaFinal,
        totalMediciones: tablaAuditoria.length
      }
    };
  }, [prodActivo, historicoPrecios, productosCompetencia, cadenaSeleccionada, rangoDias, bcvPorFecha, currentBcv]);

  // Exportar auditoría a CSV
  const exportarAuditoriaCSV = () => {
    if (!datosSerieHistorica.tablaAuditoria.length) return;
    const encabezados = [
      'Fecha',
      'Producto Propio',
      'Cadena',
      'Tasa BCV del Día (Bs/USD)',
      'Precio Propio Bs',
      'Precio Propio USD',
      'Competencia',
      'Precio Competencia Bs',
      'Precio Competencia USD',
      'Brecha Neta USD ($)',
      'Brecha Porcentual (%)'
    ];

    const filas = datosSerieHistorica.tablaAuditoria.map(f => [
      f.fecha,
      `"${prodActivo?.nombre || ''}"`,
      `"${f.cadena}"`,
      f.tasa_bcv.toFixed(4),
      f.propio_bs ? f.propio_bs.toFixed(2) : '—',
      f.propio_usd ? f.propio_usd.toFixed(2) : '—',
      `"${f.comp_nombre}"`,
      f.comp_bs ? f.comp_bs.toFixed(2) : '—',
      f.comp_usd ? f.comp_usd.toFixed(2) : '—',
      f.brecha_usd !== null ? f.brecha_usd.toFixed(2) : '—',
      f.brecha_pct !== null ? `${f.brecha_pct.toFixed(1)}%` : '—'
    ]);

    const csvContent = '\uFEFF' + [encabezados.join(';'), ...filas.map(r => r.join(';'))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Brecha_Historica_USD_${prodActivo?.id_interno || 'Prod'}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-6">
      {/* Header y Filtro Principal */}
      <div className="bg-surface-container-low border border-outline-variant/60 rounded-3xl p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-2xl">
                currency_exchange
              </span>
              <h2 className="text-xl font-display font-extrabold text-on-surface">
                Histórico de Brecha de Precios en USD (Tasa BCV del Día)
              </h2>
              <span className="text-label-sm font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full uppercase">
                Ajustado a Tasa Oficial Diaria
              </span>
            </div>
            <p className="text-xs text-on-surface-variant max-w-3xl leading-relaxed">
              Analiza la evolución real de la brecha competitiva en dólares. A diferencia de conversiones planas con la tasa actual, este motor reconstruye cada día histórico utilizando la <strong>tasa oficial de cambio del Banco Central de Venezuela</strong> vigente en esa fecha exacta.
            </p>
          </div>

          <button
            onClick={exportarAuditoriaCSV}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary text-on-primary rounded-xl text-xs font-semibold hover:bg-primary/90 transition-all shadow-xs self-start md:self-auto cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Exportar Serie Diaria CSV
          </button>
        </div>

        {/* Selector de Producto y Rango */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-6 pt-5 border-t border-outline-variant/40 items-center">
          {/* Selector de Producto */}
          <div className="md:col-span-6 space-y-1.5">
            <label className="text-xs font-semibold text-on-surface flex items-center justify-between">
              <span>Selecciona un Producto Propio:</span>
              <span className="text-label-sm text-on-surface-variant font-mono">
                {productosPropiosConDatos.length} disponibles
              </span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Filtrar por nombre..."
                value={busquedaProd}
                onChange={e => setBusquedaProd(e.target.value)}
                className="w-1/3 px-3 py-2 text-xs rounded-xl bg-surface-container-lowest border border-outline-variant text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={prodActivo?.id_interno || prodActivo?.id || ''}
                onChange={e => setProductoSeleccionadoId(e.target.value)}
                className="m3-select m3-select-dense flex-1"
              >
                {productosPropiosConDatos.map(p => (
                  <option key={p.id_interno || p.id} value={p.id_interno || p.id}>
                    {p.nombre} ({p.laboratorio || 'La Santé'})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Selector de Cadena */}
          <div className="md:col-span-3 space-y-1.5">
            <label className="text-xs font-semibold text-on-surface block">
              Cadena:
            </label>
            <select
              value={cadenaSeleccionada}
              onChange={e => setCadenaSeleccionada(e.target.value)}
              className="m3-select m3-select-dense w-full"
            >
              <option value="todas">Todas las cadenas ({cadenasDisponibles.length})</option>
              {cadenasDisponibles.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Rango de Días */}
          <div className="md:col-span-3 space-y-1.5">
            <label className="text-xs font-semibold text-on-surface block">
              Ventana Temporal:
            </label>
            <div className="flex items-center gap-1 m3-card-outlined p-1">
              {[
                { label: '30D', val: 30 },
                { label: '60D', val: 60 },
                { label: '90D', val: 90 },
                { label: 'Todo', val: 365 }
              ].map(r => (
                <button
                  key={r.val}
                  onClick={() => setRangoDias(r.val)}
                  className={`flex-1 py-1 text-xs font-mono font-bold rounded-lg transition-all ${
                    rangoDias === r.val
                      ? 'bg-primary text-on-primary shadow-xs'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tarjetas de Métricas de la Serie */}
      {datosSerieHistorica.metricas && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="m3-card-outlined p-4">
            <span className="text-xs text-on-surface-variant block">Brecha Promedio USD</span>
            <div className="text-2xl font-display font-black text-on-surface mt-1">
              {datosSerieHistorica.metricas.brechaPromedio > 0 ? '+' : ''}
              {datosSerieHistorica.metricas.brechaPromedio.toFixed(1)}%
            </div>
            <span className="text-label-md text-on-surface-variant">Frente a competidores</span>
          </div>

          <div className="m3-card-outlined p-4">
            <span className="text-xs text-on-surface-variant block">Tasa BCV Período</span>
            <div className="text-2xl font-display font-black text-on-surface mt-1">
              Bs {datosSerieHistorica.metricas.tasaFinal.toFixed(2)}
            </div>
            <span className="text-label-md text-on-surface-variant">
              Inició en Bs {datosSerieHistorica.metricas.tasaInicial.toFixed(2)}
            </span>
          </div>

          <div className="m3-card-outlined p-4">
            <span className="text-xs text-on-surface-variant block">Variación Cambiaria</span>
            <div className="text-2xl font-display font-black text-primary mt-1">
              +{datosSerieHistorica.metricas.devaluacionPct.toFixed(1)}%
            </div>
            <span className="text-label-md text-on-surface-variant">Devaluación oficial acumulada</span>
          </div>

          <div className="m3-card-outlined p-4">
            <span className="text-xs text-on-surface-variant block">Días con Registro</span>
            <div className="text-2xl font-display font-black text-on-surface mt-1">
              {datosSerieHistorica.metricas.totalMediciones}
            </div>
            <span className="text-label-md text-on-surface-variant">Mediciones auditadas</span>
          </div>
        </div>
      )}

      {/* Gráfico Principal ComposedChart Recharts */}
      <div className="m3-card-outlined p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-on-surface">
              Evolución Comparativa: Precios Reales en USD vs Brecha Porcentual
            </h3>
            <p className="text-xs text-on-surface-variant">
              Líneas superiores muestran precio en USD real. Barras inferiores reflejan la brecha % diaria.
            </p>
          </div>
        </div>

        {datosSerieHistorica.puntosGrafico.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center border border-dashed border-outline-variant rounded-2xl p-6 text-center">
            <span className="material-symbols-outlined text-3xl text-on-surface-variant mb-1">
              show_chart
            </span>
            <p className="text-xs text-on-surface-variant">
              No hay mediciones históricas registradas para este producto en la ventana de tiempo seleccionada.
            </p>
          </div>
        ) : (
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={datosSerieHistorica.puntosGrafico} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="fecha" tick={{ fontSize: 11 }} />
                
                {/* Eje izquierdo: Precio USD */}
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 11 }}
                  unit="$"
                  domain={['auto', 'auto']}
                />

                {/* Eje derecho: Brecha % */}
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  unit="%"
                  domain={['auto', 'auto']}
                />

                <Tooltip
                  formatter={(val, name) => {
                    if (name === 'Brecha %') return [`${val}%`, name];
                    if (name === 'Tasa BCV') return [`Bs ${val}`, name];
                    return [`$${val}`, name];
                  }}
                  contentStyle={{
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    borderRadius: '12px',
                    fontSize: '12px',
                    border: '1px solid #ddd'
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />

                <ReferenceLine yAxisId="right" y={0} stroke="#999" strokeDasharray="2 2" />

                <Bar
                  yAxisId="right"
                  dataKey="brecha_pct"
                  name="Brecha %"
                  fill="#9333ea"
                  opacity={0.3}
                  radius={[4, 4, 0, 0]}
                />

                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="precio_propio_usd"
                  name="Propio (USD Oficial)"
                  stroke="#2563eb"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />

                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="precio_comp_usd"
                  name="Competencia (USD Oficial)"
                  stroke="#dc2626"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={{ r: 2 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Tabla de Auditoría Diaria con Tasa BCV */}
      <div className="m3-card-outlined p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-on-surface">
            Bitácora de Precios Diarios y Tasa BCV Oficial
          </h3>
          <span className="text-xs font-mono text-on-surface-variant">
            {datosSerieHistorica.tablaAuditoria.length} registros
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-outline-variant/60 text-on-surface-variant font-mono uppercase text-label-sm">
                <th className="py-2.5 px-3">Fecha</th>
                <th className="py-2.5 px-3">Tasa BCV del Día</th>
                <th className="py-2.5 px-3">Propio Bs</th>
                <th className="py-2.5 px-3">Propio USD</th>
                <th className="py-2.5 px-3">Competidor</th>
                <th className="py-2.5 px-3">Competidor USD</th>
                <th className="py-2.5 px-3 text-right">Brecha USD %</th>
                <th className="py-2.5 px-3 text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 font-sans">
              {datosSerieHistorica.tablaAuditoria.map((fila, idx) => {
                const esFavorable = fila.brecha_pct !== null && fila.brecha_pct <= 0;
                const esDesfavorable = fila.brecha_pct !== null && fila.brecha_pct > 0;

                return (
                  <tr key={idx} className="hover:bg-surface-container-low/50 transition-colors">
                    <td className="py-2.5 px-3 font-mono font-semibold text-on-surface">
                      {fila.fecha}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-primary font-bold">
                      Bs {fila.tasa_bcv.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-on-surface-variant">
                      {fila.propio_bs ? `Bs ${fila.propio_bs.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 font-mono font-bold text-blue-600 dark:text-blue-400">
                      {fila.propio_usd ? `$${fila.propio_usd.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-on-surface truncate max-w-[160px]">
                      {fila.comp_nombre}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-on-surface-variant">
                      {fila.comp_usd ? `$${fila.comp_usd.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 font-mono font-bold text-right">
                      {fila.brecha_pct !== null ? (
                        <span className={esFavorable ? 'text-emerald-600' : 'text-red-600'}>
                          {fila.brecha_pct > 0 ? `+${fila.brecha_pct.toFixed(1)}%` : `${fila.brecha_pct.toFixed(1)}%`}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      {fila.brecha_pct !== null ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-label-sm font-mono font-bold uppercase ${
                            esFavorable
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                              : 'bg-red-500/10 text-red-700 dark:text-red-300'
                          }`}
                        >
                          {esFavorable ? 'Competitivo' : 'Por Encima'}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
