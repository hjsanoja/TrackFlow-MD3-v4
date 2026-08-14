import { useState, useMemo } from 'react';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import ProductDetailModal from '../components/ProductDetailModal';

export default function MapaCalor({ user, userDoc }) {
  const {
    productos,
    productosCompetencia,
    loadingInitial: loading
  } = useData();

  const bcv = useBcvRate();

  // Selected state controllers
  const [currency, setCurrency] = useState('usd');
  const [analisisMode, setAnalisisMode] = useState('empaque'); // 'empaque' or 'unidosis'
  const [search, setSearch] = useState('');
  const [cadenaSeleccionada, setCadenaSeleccionada] = useState('Todas');
  const [tipoMercadoSeleccionado, setTipoMercadoSeleccionado] = useState('Todos');
  const [unSeleccionada, setUnSeleccionada] = useState('Todas');
  const [sortField, setSortField] = useState('nombre'); // 'nombre', 'deviation'
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc', 'desc'
  const [filtroPosicionamiento, setFiltroPosicionamiento] = useState('Todos'); // 'Todos', 'Bajo Promedio', 'En Paridad', 'Sobre Promedio'
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Chains for filters (Point 7 requirement)
  const cadenas = useMemo(() => {
    const list = new Set(productosCompetencia.map(pc => pc.cadena).filter(Boolean));
    return ['Todas', ...Array.from(list).sort()];
  }, [productosCompetencia]);

  // Business Units for filters
  const unidadesNegocio = useMemo(() => {
    const list = new Set(productos.map(p => p.unidad_negocio).filter(Boolean));
    return ['Todas', ...Array.from(list).sort()];
  }, [productos]);

  // Clean and normalize strings (Point 12 requirement - stripping accents and case differences)
  const cleanStr = (str) => {
    return (str || '')
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  };

  // Main data processor to match products with competitor prices and calculate scale positioning
  const heatmapData = useMemo(() => {
    return productos
      .filter(p => p.activo)
      .map(p => {
        // Find competitor items for this product
        const compItems = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo);
        
        // Filter competency records by selected chain (Point 7 requirement)
        const compItemsFiltered = compItems.filter(c => {
          if (cadenaSeleccionada === 'Todas') return true;
          return c.cadena.toLowerCase() === cadenaSeleccionada.toLowerCase();
        });

        const pUnidosisCount = parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis || p.unidades_empaque);
        const pUnitFactor = analisisMode === 'unidosis' ? Math.max(pUnidosisCount, 1) : 1;

        const parsePrice = (val) => {
          if (val == null) return 0;
          const cleaned = String(val).replace(/\s/g, '').replace(',', '.');
          const parsed = parseFloat(cleaned);
          return isNaN(parsed) ? 0 : parsed;
        };

        // Parse and compile ALL valid prices for this product across selected chains (own brand + alternatives)
        const allPricesRaw = compItemsFiltered
          .map(c => {
            let rawPriceBs = parsePrice(c.ultimo_precio_full_bs);
            // Fallback to discount price if list price is zero/invalid (Point 4 requirement)
            if (rawPriceBs <= 0) {
              rawPriceBs = parsePrice(c.ultimo_precio_desc_bs);
            }
            if (rawPriceBs <= 0 || !bcv.rate) return null;

            const cUnidosisCount = parseUnidosisCount(c.tamano, c.marca, c.unidosis || c.unidades_empaque) || pUnidosisCount;
            const cUnitFactor = analisisMode === 'unidosis' ? Math.max(cUnidosisCount, 1) : 1;

            return {
              id: c.id,
              cadena: c.cadena,
              tipo: c.tipo,
              marca: c.marca,
              priceBs: rawPriceBs / cUnitFactor,
              priceUsd: (rawPriceBs / cUnitFactor) / bcv.rate,
            };
          })
          .filter(v => v !== null && v.priceUsd >= 0.05);

        // Omit products that have no valid prices in the selected chains
        if (allPricesRaw.length === 0) return null;

        // Extract own brand prices (tipo === 'propio')
        const propioPricesRaw = allPricesRaw.filter(c => c.tipo === 'propio');
        // Take minimum own price if multiple exist (Point 3 requirement)
        const propioPriceUsd = propioPricesRaw.length > 0 ? Math.min(...propioPricesRaw.map(p => p.priceUsd)) : null;

        // Compile all competitor-only prices (just for reference if needed, but the spectrum contains everything)
        const competitorPricesRaw = allPricesRaw.filter(c => c.tipo !== 'propio');

        // Collect all price numbers to calculate market spectrum extremes (Min, Max, Avg)
        const allPricesUsd = allPricesRaw.map(p => p.priceUsd);

        // Calculate absolute minimum, maximum, and average across ALL (including ours) (Point 2 and 5 requirements)
        const absoluteMin = Math.min(...allPricesUsd);
        const absoluteMax = Math.max(...allPricesUsd);
        const avgCompUsd = allPricesUsd.reduce((a, b) => a + b, 0) / allPricesUsd.length;

        // Locate our price on the spectrum (0% to 100%) relative to min/max and average (Point 3 requirement)
        let positionPct = 50;
        if (propioPriceUsd !== null && absoluteMax > absoluteMin) {
          if (propioPriceUsd <= avgCompUsd) {
            const range = avgCompUsd - absoluteMin;
            const diff = propioPriceUsd - absoluteMin;
            positionPct = range > 0 ? (diff / range) * 50 : 0;
          } else {
            const range = absoluteMax - avgCompUsd;
            const diff = propioPriceUsd - avgCompUsd;
            positionPct = range > 0 ? 50 + (diff / range) * 50 : 100;
          }
        }
        positionPct = Math.max(0, Math.min(100, positionPct));

        // Deviation of our price vs market average
        const diffAvgPercent = (propioPriceUsd !== null && avgCompUsd > 0) ? ((propioPriceUsd - avgCompUsd) / avgCompUsd) * 100 : null;

        // Dynamic status badge color and labeling based on deviation
        let posicionamientoLabel = 'Sin Precio Propio';
        let badgeColor = 'bg-slate-100 text-slate-800 border-slate-200';
        if (propioPriceUsd !== null && diffAvgPercent !== null) {
          if (diffAvgPercent < -5) {
            posicionamientoLabel = 'Bajo Promedio';
            badgeColor = 'bg-sky-100 text-sky-800 border-sky-200';
          } else if (diffAvgPercent > 5) {
            posicionamientoLabel = 'Sobre Promedio';
            badgeColor = 'bg-amber-100 text-amber-800 border-amber-200';
          } else {
            posicionamientoLabel = 'En Paridad';
            badgeColor = 'bg-emerald-100 text-emerald-800 border-emerald-200';
          }
        }

        return {
          producto: p,
          competitors: competitorPricesRaw,
          competencia: compItems, // Passing complete items list for detail modal support
          propioPriceUsd,
          absoluteMin,
          absoluteMax,
          avgCompUsd,
          diffAvgPercent,
          positionPct,
          posicionamientoLabel,
          badgeColor,
        };
      })
      .filter(Boolean);
  }, [productos, productosCompetencia, bcv.rate, analisisMode, cadenaSeleccionada]);

  // Filtering & Sorting (Default sorted alphabetically by product name - Point 14 requirement)
  const filteredRows = useMemo(() => {
    const term = search.toLowerCase().trim();
    return heatmapData
      .filter(item => {
        // Search term filter matching code, active principal, or product name
        const matchSearch = !term || 
          item.producto.nombre.toLowerCase().includes(term) ||
          (item.producto.principio_activo || '').toLowerCase().includes(term) ||
          item.producto.id_interno.toLowerCase().includes(term);
        
        // Market type filter resolved without accents (Point 12 requirement fix)
        const pTipo = cleanStr(item.producto.market_type || 'GENERICO');
        const matchTipo = tipoMercadoSeleccionado === 'Todos' || pTipo === cleanStr(tipoMercadoSeleccionado);

        // Business Unit filter
        const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
        const matchUn = unSeleccionada === 'Todas' || pUn === unSeleccionada.toUpperCase();

        // Positioning status filter
        const matchPos = filtroPosicionamiento === 'Todos' || item.posicionamientoLabel === filtroPosicionamiento;

        return matchSearch && matchTipo && matchUn && matchPos;
      })
      .sort((a, b) => {
        if (sortField === 'nombre') {
          const nameComp = a.producto.nombre.localeCompare(b.producto.nombre, 'es', { sensitivity: 'base' });
          if (nameComp !== 0) {
            return sortOrder === 'asc' ? nameComp : -nameComp;
          }
          const unA = a.producto.unidad_negocio || '';
          const unB = b.producto.unidad_negocio || '';
          const unComp = unA.localeCompare(unB, 'es', { sensitivity: 'base' });
          return sortOrder === 'asc' ? unComp : -unComp;
        } else if (sortField === 'deviation') {
          const valA = a.diffAvgPercent === null ? 999999 : a.diffAvgPercent;
          const valB = b.diffAvgPercent === null ? 999999 : b.diffAvgPercent;
          if (valA !== valB) {
            return sortOrder === 'asc' ? valA - valB : valB - valA;
          }
          const nameComp = a.producto.nombre.localeCompare(b.producto.nombre, 'es', { sensitivity: 'base' });
          if (nameComp !== 0) {
            return nameComp;
          }
          const unA = a.producto.unidad_negocio || '';
          const unB = b.producto.unidad_negocio || '';
          return unA.localeCompare(unB, 'es', { sensitivity: 'base' });
        }
        return 0;
      });
  }, [heatmapData, search, tipoMercadoSeleccionado, unSeleccionada, filtroPosicionamiento, sortField, sortOrder]);

  // Overall metrics summary cards at top of layout
  const statsSummary = useMemo(() => {
    if (heatmapData.length === 0) return { total: 0, bajoPromedio: 0, enParidad: 0, sobrePromedio: 0, avgDeviation: 0 };
    
    let total = heatmapData.length;
    let bajoPromedio = 0;
    let enParidad = 0;
    let sobrePromedio = 0;
    let totalDeviation = 0;
    let countWithDeviation = 0;

    heatmapData.forEach(item => {
      if (item.diffAvgPercent !== null) {
        totalDeviation += item.diffAvgPercent;
        countWithDeviation++;
      }
      if (item.posicionamientoLabel === 'Bajo Promedio') bajoPromedio++;
      else if (item.posicionamientoLabel === 'En Paridad') enParidad++;
      else if (item.posicionamientoLabel === 'Sobre Promedio') sobrePromedio++;
    });

    return {
      total,
      bajoPromedio,
      enParidad,
      sobrePromedio,
      avgDeviation: countWithDeviation > 0 ? totalDeviation / countWithDeviation : 0,
    };
  }, [heatmapData]);

  // Format currency helper matching dashboard
  const fmt = (priceUsd) => {
    if (priceUsd == null || isNaN(priceUsd)) return '—';
    if (currency === 'usd') {
      return `$${priceUsd.toFixed(2)}`;
    }
    if (!bcv.rate) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-3xl">thermostat</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Mapa de Calor y Posición Relativa
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant max-w-2xl font-sans leading-relaxed">
            Visualiza el espectro de precios del mercado. Los extremos representan los precios
            mínimo y máximo, el centro es el promedio y el marcador indica el posicionamiento exacto de tu precio.
          </p>
        </div>

        {/* Unified Mode Toggle & Currency switcher */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="m3-segmented">
            <button
              onClick={() => setAnalisisMode('empaque')}
              className={`m3-segmented-item ${analisisMode === 'empaque' ? 'active' : ''}`}
            >
              <span className="material-symbols-outlined text-[14px]">inventory_2</span>
              <span>Empaque</span>
            </button>
            <button
              onClick={() => setAnalisisMode('unidosis')}
              className={`m3-segmented-item ${analisisMode === 'unidosis' ? 'active' : ''}`}
            >
              <span className="material-symbols-outlined text-[14px]">medication</span>
              <span>Por Unidosis</span>
            </button>
          </div>

          <div className="m3-segmented">
            <button
              onClick={() => setCurrency('usd')}
              className={`m3-segmented-item ${currency === 'usd' ? 'active' : ''}`}
            >
              USD ($)
            </button>
            <button
              onClick={() => setCurrency('bs')}
              className={`m3-segmented-item ${currency === 'bs' ? 'active' : ''}`}
            >
              VES (Bs)
            </button>
          </div>
        </div>
      </div>

      {/* KPI Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total con precio */}
        <div className="neural-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
            <span className="material-symbols-outlined text-xl">medication</span>
          </div>
          <div>
            <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase tracking-wider block">Productos Vigentes</span>
            <div className="text-xl font-display font-extrabold text-primary mt-0.5">{statsSummary.total}</div>
            <span className="text-[9px] text-on-surface-variant font-semibold">Con precio o competencia activa</span>
          </div>
        </div>

        {/* Bajo Promedio (Más competitivos) */}
        <div className="neural-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-sky-50 border border-sky-200 flex items-center justify-center text-sky-700 shrink-0">
            <span className="material-symbols-outlined text-xl">trending_down</span>
          </div>
          <div>
            <span className="text-[10px] font-mono font-bold text-sky-700 uppercase tracking-wider block">Bajo el Promedio</span>
            <div className="text-xl font-display font-extrabold text-sky-800 mt-0.5">{statsSummary.bajoPromedio}</div>
            <span className="text-[9px] text-sky-600 font-semibold">Precios altamente competitivos</span>
          </div>
        </div>

        {/* En Paridad */}
        <div className="neural-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
            <span className="material-symbols-outlined text-xl">drag_handle</span>
          </div>
          <div>
            <span className="text-[10px] font-mono font-bold text-emerald-700 uppercase tracking-wider block">En Paridad</span>
            <div className="text-xl font-display font-extrabold text-emerald-800 mt-0.5">{statsSummary.enParidad}</div>
            <span className="text-[9px] text-emerald-600 font-semibold">Dentro del ±5% del promedio</span>
          </div>
        </div>

        {/* Sobre Promedio */}
        <div className="neural-card p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 shrink-0">
            <span className="material-symbols-outlined text-xl">trending_up</span>
          </div>
          <div>
            <span className="text-[10px] font-mono font-bold text-amber-700 uppercase tracking-wider block">Sobre el Promedio</span>
            <div className="text-xl font-display font-extrabold text-amber-800 mt-0.5">{statsSummary.sobrePromedio}</div>
            <span className="text-[9px] text-amber-600 font-semibold">Posibles márgenes premium</span>
          </div>
        </div>
      </div>

      {/* Filter and Search controls */}
      <div className="neural-card p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Search Box */}
          <div className="relative md:col-span-1">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px] pointer-events-none select-none">search</span>
            <input
              type="text"
              placeholder="Buscar producto o principio..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="m3-input m3-input-search pr-8"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-container-high">×</button>
            )}
          </div>

          {/* Chain Filter */}
          <div className="space-y-1">
            <select
              value={cadenaSeleccionada}
              onChange={(e) => setCadenaSeleccionada(e.target.value)}
              className="m3-select"
            >
              <option value="Todas">Cadena: Todas</option>
              {cadenas.filter(c => c !== 'Todas').map(cad => (
                <option key={cad} value={cad}>{cad}</option>
              ))}
            </select>
          </div>

          {/* UN Filter */}
          <div className="space-y-1">
            <select
              value={unSeleccionada}
              onChange={(e) => setUnSeleccionada(e.target.value)}
              className="m3-select"
            >
              <option value="Todas">Unidad de Negocio: Todas</option>
              {unidadesNegocio.filter(u => u !== 'Todas').map(un => (
                <option key={un} value={un}>{un}</option>
              ))}
            </select>
          </div>

          {/* Position Filter */}
          <div className="space-y-1">
            <select
              value={filtroPosicionamiento}
              onChange={(e) => setFiltroPosicionamiento(e.target.value)}
              className="m3-select"
            >
              <option value="Todos">Posición: Todos</option>
              <option value="Bajo Promedio">Bajo el Promedio</option>
              <option value="En Paridad">En Paridad</option>
              <option value="Sobre Promedio">Sobre el Promedio</option>
              <option value="Sin Precio Propio">Sin Precio Propio</option>
            </select>
          </div>
        </div>

        {/* Quick filters / Sort display */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-surface-variant text-xs text-on-surface-variant font-sans">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-on-background">Tipo de Mercado:</span>
            <div className="m3-segmented">
              {['Todos', 'Marca', 'Genérico'].map(opt => (
                <button
                  key={opt}
                  onClick={() => setTipoMercadoSeleccionado(opt)}
                  className={`m3-segmented-item ${tipoMercadoSeleccionado === opt ? 'active' : ''}`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold">
            <span className="material-symbols-outlined text-xs text-primary">info</span>
            <span>Mostrando <span className="font-black text-primary">{filteredRows.length}</span> de <span className="font-bold">{heatmapData.length}</span> productos</span>
          </div>
        </div>
      </div>

      {/* Heatmap Table Grid */}
      <div className="neural-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="m3-table table-fixed min-w-[800px]">
            <thead>
              <tr>
                <th className="cursor-pointer hover:bg-surface-variant/50 transition-colors w-[30%]" onClick={() => handleSort('nombre')}>
                  <div className="flex items-center gap-1">
                    <span>Medicamento / Producto</span>
                    {sortField === 'nombre' && (
                      <span className="material-symbols-outlined text-sm font-bold">{sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>
                    )}
                  </div>
                </th>
                <th className="text-center w-[70%]">
                  Espectro de Precios y Posicionamiento de Mi Precio
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-variant">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-16 text-center text-on-surface-variant italic bg-surface-low/30">
                    No se encontraron productos activos que coincidan con la selección y tengan precio.
                  </td>
                </tr>
              ) : (
                filteredRows.map((item) => {
                  const devVal = item.diffAvgPercent;
                  const isUnder = devVal !== null && devVal < -5;
                  const isOver = devVal !== null && devVal > 5;

                  return (
                    <tr 
                      key={item.producto.id_interno} 
                      onClick={() => setSelectedProduct(item)}
                      className="hover:bg-slate-50/80 transition-all border-b border-[#e1e2ec]/60 cursor-pointer"
                      title="Haz clic para ver detalles comparativos de este producto en Góndola"
                    >
                      {/* Product Column */}
                      <td className="px-6 py-6 align-middle">
                        <div className="flex flex-col space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-[#040d53] text-[13.5px] font-display leading-tight">{item.producto.nombre}</span>
                            <span className={`px-1.5 py-0.5 text-[9px] rounded font-mono font-bold tracking-wider uppercase ${
                              (item.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA'
                                ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                : 'bg-green-100 text-green-800 border border-green-200'
                            }`}>
                              {(item.producto.market_type || 'GENERICO').toUpperCase()}
                            </span>
                          </div>
                          
                          <div className="text-[11px] text-[#464650] font-mono space-y-0.5">
                            <div><strong className="text-[#1c1b1f]/80">Código:</strong> {item.producto.id_interno}</div>
                            {item.producto.laboratorio && <div><strong className="text-[#1c1b1f]/80">Laboratorio:</strong> {item.producto.laboratorio}</div>}
                            {item.producto.unidad_negocio && <div><strong className="text-[#1c1b1f]/80">Unidad de Negocio:</strong> {item.producto.unidad_negocio}</div>}
                          </div>

                          <div className="pt-1">
                            <span className="text-[10px] text-[#040d53] bg-[#040d53]/5 border border-[#040d53]/15 rounded-lg px-2 py-0.5 font-bold inline-flex items-center gap-1 hover:bg-[#040d53]/10 transition-colors">
                              <span className="material-symbols-outlined text-[11px]">visibility</span>
                              Analizar competencia ↗
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Redesigned Spectrum bar Column - visually enlarged and polished (Point 11 requirement) */}
                      <td className="px-8 py-9 align-middle">
                        <div className="flex flex-col space-y-6.5 justify-center relative pt-8 pb-1">
                          {/* Visual Spectrum Bar Container */}
                          <div className="relative h-3 w-full rounded-full overflow-visible flex bg-slate-100 border border-slate-200/80 shadow-inner">
                            {/* Premium double gradient spectrum background (Rose/Red extremes, Emerald/Green center) */}
                            <div className="w-full h-full rounded-full bg-gradient-to-r from-red-500 via-amber-400 via-emerald-500 via-amber-400 to-red-500 shadow-[inset_0_1.5px_2px_rgba(0,0,0,0.15)]"></div>

                            {/* Center and bounds markers on track */}
                            <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-white/40" title="Mínimo"></div>
                            <div className="absolute left-1/2 top-0 bottom-0 w-[2px] bg-white/60 -translate-x-1/2" title="Promedio"></div>
                            <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-white/40" title="Máximo"></div>

                            {/* Floating Marker pointing to our exact pricing position */}
                            {item.propioPriceUsd !== null ? (
                              <div 
                                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 group"
                                style={{ left: `${item.positionPct}%` }}
                              >
                                <div className="relative flex flex-col items-center">
                                  {/* Permanent Floating Label above spectrum bar */}
                                  <div className="absolute bottom-6 mb-1.5 bg-[#040d53] text-white text-[10.5px] px-2.5 py-1 rounded-xl shadow-lg font-mono font-extrabold whitespace-nowrap flex items-center gap-1.5 border border-white/10 transition-all duration-300 transform group-hover:scale-105 group-hover:-translate-y-1">
                                    <span className="text-[9px] uppercase tracking-wider text-white/75 font-sans">MI PRECIO:</span>
                                    <span>{fmt(item.propioPriceUsd)}</span>
                                    {devVal !== null && (
                                      <span className={`ml-1 px-1.5 py-0.2 rounded-md text-[9px] font-black ${
                                        isUnder ? 'bg-sky-500 text-white' : isOver ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white'
                                      }`}>
                                        {devVal > 0 ? '+' : ''}{devVal.toFixed(1)}%
                                      </span>
                                    )}
                                  </div>

                                  {/* Custom physical pin with glowing radar aura */}
                                  <div className="relative flex items-center justify-center">
                                    <div className="w-5.5 h-5.5 rounded-full bg-white border-[3.5px] border-[#040d53] shadow-md flex items-center justify-center transition-all duration-300 transform group-hover:scale-115">
                                      <div className="w-1.5 h-1.5 rounded-full bg-[#040d53]"></div>
                                    </div>
                                    <div className="absolute top-4.5 w-[2px] h-3 bg-[#040d53]/80"></div>
                                    {/* Pulse aura */}
                                    <div className="absolute w-8 h-8 rounded-full bg-[#040d53]/10 animate-ping pointer-events-none"></div>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              /* Subtle label if no own price is active */
                              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="text-[10px] text-[#040d53] font-mono font-bold tracking-wider uppercase bg-white/85 px-2 py-0.5 rounded-full shadow-sm border border-slate-100">
                                  COMPETENCIA ÚNICAMENTE (SIN MI PRECIO)
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Beautiful direct price tag blocks beneath the spectrum bar */}
                          <div className="grid grid-cols-3 text-[11px] font-mono font-bold pt-2.5 border-t border-slate-100">
                            {/* Left (Min) */}
                            <div className="text-left flex flex-col">
                              <span className="text-rose-700 flex items-center gap-1 text-[10px]">
                                <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
                                MÍNIMO
                              </span>
                              <span className="text-slate-800 font-extrabold text-xs mt-1 bg-rose-50/50 rounded-xl py-1 px-2.5 border border-rose-100 w-max shadow-sm">
                                {fmt(item.absoluteMin)}
                              </span>
                            </div>

                            {/* Center (Avg) */}
                            <div className="text-center flex flex-col items-center">
                              <span className="text-emerald-700 flex items-center gap-1 justify-center text-[10px]">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                                PROMEDIO
                              </span>
                              <span className="text-slate-800 font-extrabold text-xs mt-1 bg-emerald-50/50 rounded-xl py-1 px-2.5 border border-emerald-100 w-max shadow-sm">
                                {fmt(item.avgCompUsd)}
                              </span>
                            </div>

                            {/* Right (Max) */}
                            <div className="text-right flex flex-col items-end">
                              <span className="text-rose-700 flex items-center gap-1 justify-end text-[10px]">
                                <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
                                MÁXIMO
                              </span>
                              <span className="text-slate-800 font-extrabold text-xs mt-1 bg-rose-50/50 rounded-xl py-1 px-2.5 border border-rose-100 w-max shadow-sm">
                                {fmt(item.absoluteMax)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product detail modal view (Point 8 consistency and 10 requirements) */}
      {selectedProduct && (
        <ProductDetailModal
          producto={selectedProduct.producto}
          competencia={selectedProduct.competencia || []}
          currency={currency}
          bcvRate={bcv.rate}
          onClose={() => setSelectedProduct(null)}
          initialPriceMode="full"
          initialAnalisisMode={analisisMode}
        />
      )}
    </div>
  );
}
