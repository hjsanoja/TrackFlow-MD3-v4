import { useState, useMemo } from 'react';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { getChainColor, getLabColor } from '../utils/brandColors';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip
} from 'recharts';

export default function Analisis() {
  const { productos, productosCompetencia } = useData();
  const bcv = useBcvRate();

  // Estados para filtros
  const [selectedCategoria, setSelectedCategoria] = useState('todas');
  const [searchTerm, setSearchTerm] = useState('');
  const [bcvSimulatedRate, setBcvSimulatedRate] = useState(0); // Offset delta %
  const [compareProductIds, setCompareProductIds] = useState([]);
  const [tableLimit, setTableLimit] = useState(15); // Máximo 10 - 15 productos por defecto

  const currentRate = bcv?.rate || 744.23;
  const effectiveRate = currentRate * (1 + bcvSimulatedRate / 100);

  // Indexar productosCompetencia en un Map O(1) para máxima velocidad sin lag
  const compByProductMap = useMemo(() => {
    const map = new Map();
    if (!Array.isArray(productosCompetencia)) return map;
    for (let i = 0; i < productosCompetencia.length; i++) {
      const c = productosCompetencia[i];
      if (c.activo === false) continue;
      const key = c.id_producto_propio;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(c);
    }
    return map;
  }, [productosCompetencia]);

  // Categorías disponibles
  const categorias = useMemo(() => {
    if (!Array.isArray(productos)) return ['todas'];
    const set = new Set();
    for (let i = 0; i < productos.length; i++) {
      if (productos[i].categoria) set.add(productos[i].categoria);
    }
    return ['todas', ...Array.from(set)];
  }, [productos]);

  // Principios activos para sugerencias rápidas
  const principiosActivos = useMemo(() => {
    if (!Array.isArray(productos)) return [];
    const set = new Set();
    for (let i = 0; i < productos.length; i++) {
      if (productos[i].principio_activo) set.add(productos[i].principio_activo);
    }
    return Array.from(set);
  }, [productos]);

  // Productos filtrados
  const filteredProducts = useMemo(() => {
    if (!Array.isArray(productos)) return [];
    const term = searchTerm.toLowerCase().trim();
    return productos.filter(p => {
      const matchCat = selectedCategoria === 'todas' || p.categoria === selectedCategoria;
      if (!matchCat) return false;
      if (!term) return true;
      return (
        (p.nombre && p.nombre.toLowerCase().includes(term)) ||
        (p.principio_activo && p.principio_activo.toLowerCase().includes(term)) ||
        (p.laboratorio && p.laboratorio.toLowerCase().includes(term))
      );
    });
  }, [productos, selectedCategoria, searchTerm]);

  // Cálculo optimizado O(N) del ICP & Matriz de Posicionamiento
  const analisisData = useMemo(() => {
    let baratosCount = 0;
    let justosCount = 0;
    let carosCount = 0;
    let sumScore = 0;
    let validProductCount = 0;

    const brechasOportunidad = [];

    for (let i = 0; i < filteredProducts.length; i++) {
      const prod = filteredProducts[i];
      const compItems = compByProductMap.get(prod.id);
      if (!compItems || compItems.length === 0) continue;

      validProductCount++;

      let minCompUsd = Infinity;
      let maxCompUsd = -Infinity;
      let sumPricesUsd = 0;
      let validCompPricesCount = 0;
      let cheapestCompItem = null;
      let minCompBs = Infinity;

      for (let j = 0; j < compItems.length; j++) {
        const c = compItems[j];
        const bs = c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs;
        if (bs && bs > 0) {
          const usd = bs / effectiveRate;
          sumPricesUsd += usd;
          validCompPricesCount++;
          if (usd < minCompUsd) minCompUsd = usd;
          if (usd > maxCompUsd) maxCompUsd = usd;

          if (bs < minCompBs) {
            minCompBs = bs;
            cheapestCompItem = c;
          }
        }
      }

      if (validCompPricesCount === 0) continue;

      const avgCompUsd = sumPricesUsd / validCompPricesCount;
      const pvpPropioUsd = prod.pvp_propio_usd || 0;

      // Variación % vs la media del mercado
      const diffPct = avgCompUsd > 0 ? ((pvpPropioUsd - avgCompUsd) / avgCompUsd) * 100 : 0;

      if (diffPct < -3) {
        baratosCount++;
      } else if (diffPct >= -3 && diffPct <= 3) {
        justosCount++;
      } else {
        carosCount++;
      }

      // ICP Score
      const ratio = avgCompUsd > 0 ? (avgCompUsd / pvpPropioUsd) * 100 : 100;
      sumScore += Math.min(Math.max(ratio, 0), 120);

      const cheapestPriceUsd = cheapestCompItem ? (minCompBs / effectiveRate) : avgCompUsd;
      const diffVsCheapestUsd = pvpPropioUsd - cheapestPriceUsd;
      const diffVsCheapestPct = cheapestPriceUsd > 0 ? (diffVsCheapestUsd / cheapestPriceUsd) * 100 : 0;

      brechasOportunidad.push({
        producto: prod,
        compCount: compItems.length,
        pvpPropioUsd,
        avgCompUsd,
        minCompUsd,
        maxCompUsd,
        cheapestCompItem,
        cheapestPriceUsd,
        diffVsCheapestUsd,
        diffVsCheapestPct,
        status: diffVsCheapestPct > 5 ? 'sobreprecio' : diffVsCheapestPct < -5 ? 'oportunidad_margen' : 'competitivo'
      });
    }

    const icpScore = validProductCount > 0 ? Math.round(sumScore / validProductCount) : 100;

    // Ordenar brechas por mayor desviación
    brechasOportunidad.sort((a, b) => Math.abs(b.diffVsCheapestPct) - Math.abs(a.diffVsCheapestPct));

    return {
      icpScore,
      baratosCount,
      justosCount,
      carosCount,
      totalAnalizados: validProductCount,
      brechasOportunidad
    };
  }, [filteredProducts, compByProductMap, effectiveRate]);

  // Brechas recortadas al límite (10 - 15 productos para fluidez extrema)
  const visibleBrechas = useMemo(() => {
    return analisisData.brechasOportunidad.slice(0, tableLimit);
  }, [analisisData.brechasOportunidad, tableLimit]);

  // Datos para gráfico de Posicionamiento
  const positioningPieData = useMemo(() => [
    { name: 'Más Económico (>3%)', value: analisisData.baratosCount, color: '#16A34A' },
    { name: 'Precio Alineado (±3%)', value: analisisData.justosCount, color: '#0284C7' },
    { name: 'Sobreprecio (>3%)', value: analisisData.carosCount, color: '#DC2626' },
  ].filter(d => d.value > 0), [analisisData.baratosCount, analisisData.justosCount, analisisData.carosCount]);

  // Toggle de selección para comparador visual (2 a 4 productos)
  const toggleCompareProduct = (id) => {
    setCompareProductIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(pId => pId !== id);
      }
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  };

  const comparedProductsData = useMemo(() => {
    return compareProductIds.map(pId => {
      const prod = productos.find(p => p.id === pId);
      if (!prod) return null;
      const compItems = compByProductMap.get(pId) || [];
      return { prod, compItems };
    }).filter(Boolean);
  }, [compareProductIds, productos, compByProductMap]);

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide">
      {/* HEADER PRINCIPAL */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">insights</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Análisis Competitivo & Oportunidades
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Indicadores KPI de posicionamiento de mercado, índice ICP, simulador de tasa BCV y comparador de productos.
          </p>
        </div>

        <button
          onClick={() => window.print()}
          className="touch-target px-4 py-2 bg-surface-low hover:bg-surface-variant text-primary font-mono font-bold text-xs rounded-full border border-outline-variant/60 transition-all flex items-center gap-2 self-start lg:self-auto"
        >
          <span className="material-symbols-outlined text-base">picture_as_pdf</span>
          <span>Exportar Informe</span>
        </button>
      </div>

      {/* BÚSQUEDA Y FILTROS RÁPIDOS */}
      <div className="neural-card p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Buscar producto, laboratorio o principio activo..."
              className="w-full pl-9 pr-8 py-2 bg-surface-low border border-outline-variant/60 rounded-xl text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 font-sans"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-xs font-bold">×</button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase">Categoría:</span>
            <select
              value={selectedCategoria}
              onChange={e => setSelectedCategoria(e.target.value)}
              className="px-3 py-2 bg-surface-low border border-outline-variant/60 rounded-xl text-xs text-on-surface font-sans font-bold focus:outline-none"
            >
              {categorias.map(cat => (
                <option key={cat} value={cat}>
                  {cat === 'todas' ? 'Todas las categorías' : cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Sugerencias de búsqueda */}
        {principiosActivos.length > 0 && !searchTerm && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase shrink-0">Populares:</span>
            {principiosActivos.slice(0, 5).map(pa => (
              <button
                key={pa}
                onClick={() => setSearchTerm(pa)}
                className="px-2 py-0.5 bg-surface-low hover:bg-primary-container/40 text-on-surface text-[10px] font-medium rounded-full border border-outline-variant/40 transition-colors shrink-0"
              >
                {pa}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* BLOQUE DE KPIs PRINCIPALES */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: ICP */}
        <div className="neural-card p-4 flex flex-col justify-between neural-glow">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-bold uppercase text-primary">Índice ICP</span>
              <span className="material-symbols-outlined text-primary text-lg">speed</span>
            </div>
            <div className="text-2xl font-display font-extrabold text-on-background">
              {analisisData.icpScore}%
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1 leading-tight">
              Score de competitividad global de precios vs mercado.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-outline-variant/30 flex items-center justify-between text-[10px] font-mono">
            <span className="text-on-surface-variant">Evaluados:</span>
            <span className="font-bold text-primary">{analisisData.totalAnalizados} SKUs</span>
          </div>
        </div>

        {/* KPI 2: Sobreprecio */}
        <div className="neural-card p-4 flex flex-col justify-between border-l-4 border-l-rose-500">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-bold uppercase text-rose-700">Sobreprecio</span>
              <span className="material-symbols-outlined text-rose-600 text-lg">warning</span>
            </div>
            <div className="text-2xl font-display font-extrabold text-rose-700">
              {analisisData.carosCount} <span className="text-xs font-normal text-on-surface-variant">SKUs</span>
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1 leading-tight">
              Precio propio supera la media del mercado por &gt;3%.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-outline-variant/30 text-[10px] font-mono text-rose-700 font-bold">
            Revisar margen
          </div>
        </div>

        {/* KPI 3: Alineados */}
        <div className="neural-card p-4 flex flex-col justify-between border-l-4 border-l-sky-500">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-bold uppercase text-sky-700">Alineados</span>
              <span className="material-symbols-outlined text-sky-600 text-lg">balance</span>
            </div>
            <div className="text-2xl font-display font-extrabold text-sky-700">
              {analisisData.justosCount} <span className="text-xs font-normal text-on-surface-variant">SKUs</span>
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1 leading-tight">
              Dentro del rango promedio del mercado (±3%).
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-outline-variant/30 text-[10px] font-mono text-sky-700 font-bold">
            Equilibrio de precio
          </div>
        </div>

        {/* KPI 4: Más Económicos */}
        <div className="neural-card p-4 flex flex-col justify-between border-l-4 border-l-emerald-500">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono font-bold uppercase text-emerald-700">Económicos</span>
              <span className="material-symbols-outlined text-emerald-600 text-lg">trending_down</span>
            </div>
            <div className="text-2xl font-display font-extrabold text-emerald-700">
              {analisisData.baratosCount} <span className="text-xs font-normal text-on-surface-variant">SKUs</span>
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1 leading-tight">
              Más de 3% por debajo del promedio competidor.
            </p>
          </div>
          <div className="mt-3 pt-2 border-t border-outline-variant/30 text-[10px] font-mono text-emerald-700 font-bold">
            Ventaja competitiva
          </div>
        </div>
      </div>

      {/* SIMULADOR BCV + POSICIONAMIENTO */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Simulador */}
        <div className="neural-card p-5 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between border-b border-outline-variant/30 pb-3">
            <div>
              <h2 className="text-sm font-bold font-display text-on-background flex items-center gap-1.5">
                <span className="material-symbols-outlined text-primary text-base">tune</span>
                Simulador de Sensibilidad BCV
              </h2>
            </div>
            <div className="text-right font-mono text-xs">
              <span className="text-on-surface-variant">Tasa Oficial: </span>
              <span className="font-bold text-primary">{currentRate.toFixed(2)} Bs/$</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-mono font-bold">
              <span>Ajuste Tasa: {bcvSimulatedRate > 0 ? `+${bcvSimulatedRate}%` : `${bcvSimulatedRate}%`}</span>
              <span className="text-primary bg-primary-container/40 px-2.5 py-0.5 rounded-full border border-primary/20 text-[11px]">
                Tasa Simulada: {effectiveRate.toFixed(2)} Bs/$
              </span>
            </div>

            <input
              type="range"
              min="-15"
              max="25"
              step="1"
              value={bcvSimulatedRate}
              onChange={e => setBcvSimulatedRate(Number(e.target.value))}
              className="w-full accent-primary h-2 bg-surface-variant rounded-lg cursor-pointer"
            />

            <div className="flex items-center justify-between text-[10px] font-mono text-on-surface-variant">
              <span>-15% (Apreciación)</span>
              <span>0% (Actual)</span>
              <span>+25% (Devaluación)</span>
            </div>
          </div>
        </div>

        {/* Matriz Pie */}
        <div className="neural-card p-5 space-y-3 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-bold font-display text-on-background flex items-center gap-1.5">
              <span className="material-symbols-outlined text-primary text-base">pie_chart</span>
              Posicionamiento
            </h2>
          </div>

          <div className="h-36 w-full">
            {positioningPieData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-on-surface-variant italic">Sin datos.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={positioningPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={60}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {positioningPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => [`${value} SKUs`, 'Cantidad']}
                    contentStyle={{ borderRadius: '8px', fontSize: '11px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="space-y-1 text-[11px] font-mono">
            {positioningPieData.map(item => (
              <div key={item.name} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
                  <span className="text-on-surface-variant text-[10px]">{item.name}</span>
                </div>
                <span className="font-bold text-on-surface">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* TABLA DE ALERTAS Y BRECHAS (LIMITADA A 10 - 15 PRODUCTOS) */}
      <div className="neural-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-outline-variant/30 pb-3">
          <div>
            <h2 className="text-base font-bold font-display text-on-background flex items-center gap-2">
              <span className="material-symbols-outlined text-rose-600">warning_amber</span>
              Alertas de Brecha de Oportunidad
            </h2>
            <p className="text-xs text-on-surface-variant font-sans mt-0.5">
              Top productos propios con mayores desviaciones frente a competidores.
            </p>
          </div>

          {/* Selector de Límite (10, 15 o todos) */}
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="text-on-surface-variant">Mostrar:</span>
            {[10, 15, 25].map(limit => (
              <button
                key={limit}
                onClick={() => setTableLimit(limit)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                  tableLimit === limit
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface-low text-on-surface border-outline-variant/50 hover:bg-surface-variant'
                }`}
              >
                {limit} SKUs
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-surface-low text-on-surface text-[10px] uppercase font-mono tracking-wider border-b border-outline-variant/50">
              <tr>
                <th className="p-2.5 font-bold text-center">Comp.</th>
                <th className="p-2.5 font-bold">Producto Propio</th>
                <th className="p-2.5 font-bold">Laboratorio</th>
                <th className="p-2.5 font-bold text-right">PVP Propio ($)</th>
                <th className="p-2.5 font-bold text-right">Mín. Competidor ($)</th>
                <th className="p-2.5 font-bold">Cadena Más Económica</th>
                <th className="p-2.5 font-bold text-right">Diferencia %</th>
                <th className="p-2.5 font-bold text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 font-sans">
              {visibleBrechas.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-on-surface-variant italic">
                    No se encontraron brechas para los filtros aplicados.
                  </td>
                </tr>
              ) : (
                visibleBrechas.map(b => {
                  const isChecked = compareProductIds.includes(b.producto.id);
                  const chainColor = b.cheapestCompItem ? getChainColor(b.cheapestCompItem.cadena) : '#475569';
                  const labColor = getLabColor(b.producto.laboratorio);

                  return (
                    <tr key={b.producto.id} className="hover:bg-surface-low/60 transition-colors">
                      <td className="p-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleCompareProduct(b.producto.id)}
                          disabled={!isChecked && compareProductIds.length >= 4}
                          className="rounded text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                        />
                      </td>
                      <td className="p-2.5 font-bold text-on-surface">
                        <div>{b.producto.nombre}</div>
                        <div className="text-[10px] font-mono font-normal text-on-surface-variant">{b.producto.principio_activo}</div>
                      </td>
                      <td className="p-2.5 font-mono">
                        <span
                          className="px-2 py-0.5 rounded-full text-[9px] font-bold text-white"
                          style={{ backgroundColor: labColor }}
                        >
                          {b.producto.laboratorio || 'N/A'}
                        </span>
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold text-on-surface">
                        ${b.pvpPropioUsd.toFixed(2)}
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold text-primary">
                        ${b.cheapestPriceUsd.toFixed(2)}
                      </td>
                      <td className="p-2.5">
                        {b.cheapestCompItem ? (
                          <div className="flex items-center gap-1.5 font-mono text-[10px]">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: chainColor }}
                            ></span>
                            <span className="font-bold" style={{ color: chainColor }}>{b.cheapestCompItem.cadena}</span>
                          </div>
                        ) : (
                          <span className="text-on-surface-variant font-mono">—</span>
                        )}
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold">
                        <span className={b.diffVsCheapestPct > 0 ? 'text-rose-600' : 'text-emerald-600'}>
                          {b.diffVsCheapestPct >= 0 ? `+${b.diffVsCheapestPct.toFixed(1)}%` : `${b.diffVsCheapestPct.toFixed(1)}%`}
                        </span>
                      </td>
                      <td className="p-2.5 text-center">
                        <span className={`m3-chip ${
                          b.status === 'sobreprecio' 
                            ? 'bg-rose-50 text-rose-700 border border-rose-200'
                            : b.status === 'oportunidad_margen'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-sky-50 text-sky-700 border border-sky-200'
                        }`}>
                          {b.status === 'sobreprecio' ? 'Sobreprecio' : b.status === 'oportunidad_margen' ? 'Líder Barato' : 'Alineado'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {analisisData.brechasOportunidad.length > tableLimit && (
          <div className="text-center pt-2">
            <span className="text-[11px] font-mono text-on-surface-variant">
              Mostrando los primeros {tableLimit} de {analisisData.brechasOportunidad.length} productos analizados.
            </span>
          </div>
        )}
      </div>

      {/* COMPARADOR PARALELO */}
      {comparedProductsData.length > 0 && (
        <div className="neural-card p-5 space-y-4 border-2 border-primary/40 bg-primary-container/10">
          <div className="flex items-center justify-between border-b border-outline-variant/30 pb-3">
            <div>
              <h2 className="text-sm font-bold font-display text-on-background flex items-center gap-1.5">
                <span className="material-symbols-outlined text-primary text-base">compare</span>
                Comparador Paralelo Side-by-Side
              </h2>
            </div>
            <button
              onClick={() => setCompareProductIds([])}
              className="text-xs font-mono font-bold text-rose-600 hover:text-rose-800 bg-rose-50 px-2.5 py-1 rounded-full border border-rose-200 transition-colors"
            >
              Limpiar
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {comparedProductsData.map(({ prod, compItems }) => {
              const labColor = getLabColor(prod.laboratorio);
              return (
                <div key={prod.id} className="bg-white rounded-xl p-3 border border-outline-variant/50 shadow-xs space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span
                        className="px-2 py-0.5 rounded-full text-[9px] font-bold text-white font-mono"
                        style={{ backgroundColor: labColor }}
                      >
                        {prod.laboratorio}
                      </span>
                      <button
                        onClick={() => toggleCompareProduct(prod.id)}
                        className="text-on-surface-variant hover:text-rose-600 text-xs font-bold"
                      >
                        ×
                      </button>
                    </div>
                    <h3 className="text-xs font-bold font-display text-on-surface leading-tight">{prod.nombre}</h3>

                    <div className="mt-2 p-2 bg-surface-low rounded-lg text-center border border-outline-variant/30 font-mono">
                      <div className="text-[9px] text-on-surface-variant uppercase">PVP Propio</div>
                      <div className="text-base font-extrabold text-primary">${(prod.pvp_propio_usd || 0).toFixed(2)}</div>
                    </div>

                    <div className="mt-2 space-y-1">
                      <div className="text-[9px] font-mono font-bold text-on-surface-variant uppercase">Competencia ({compItems.length}):</div>
                      {compItems.length === 0 ? (
                        <div className="text-[10px] text-on-surface-variant italic">No registrado.</div>
                      ) : (
                        compItems.map(c => {
                          const chainColor = getChainColor(c.cadena);
                          const pUsd = (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs) ? ((c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs) / effectiveRate) : 0;
                          return (
                            <div key={c.id} className="flex items-center justify-between text-[10px] font-mono bg-surface-low/50 p-1 rounded border border-outline-variant/20">
                              <span className="font-bold" style={{ color: chainColor }}>{c.cadena}</span>
                              <span className="font-bold text-on-surface">${pUsd.toFixed(2)}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
