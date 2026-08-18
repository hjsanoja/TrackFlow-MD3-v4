import { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { collection, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import ConfirmModal from './ConfirmModal';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { useData } from '../context/DataContext';
import { dbClearHistoricoPrecioForProduct } from '../utils/dbClient';
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LabelList, ReferenceLine
} from 'recharts';

const COLORS = ['#040d53', '#70C145', '#ba1a1a', '#004ecb', '#002f6c', '#0891b2', '#db2777'];

function InfoTooltip({ text, align = 'center' }) {
  const alignClass = align === 'left' 
    ? 'left-0 translate-x-0' 
    : align === 'right' 
      ? 'right-0 translate-x-0 animate-fade-in' 
      : 'left-1/2 -translate-x-1/2 animate-fade-in';
      
  return (
    <div className="relative group inline-block ml-1 align-middle leading-none">
      <span className="material-symbols-outlined text-[15px] text-[#464650] hover:text-[#040d53] transition-colors cursor-help select-none">
        info
      </span>
      <div className={`absolute bottom-full mb-2 w-64 p-3 bg-[#1c1b1f] text-white text-[10.5px] leading-relaxed rounded-xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-200 shadow-xl z-50 font-normal normal-case tracking-normal ${alignClass}`}>
        {text}
        <div className={`absolute top-full border-4 border-transparent border-t-[#1c1b1f] ${
          align === 'left' ? 'left-3' : align === 'right' ? 'right-3' : 'left-1/2 -translate-x-1/2'
        }`}></div>
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label, propios, labMap, currency, analisisMode }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-surface-container-lowest border border-outline-variant p-3 rounded-2xl shadow-elevation-3 space-y-2 max-w-sm text-xs font-sans">
        <p className="font-bold text-primary font-mono border-b border-outline-variant pb-1 flex justify-between items-center">
          <span>Fecha: {label ? label.split('-').reverse().join('/') : ''}</span>
          {analisisMode === 'unidosis' && (
            <span className="text-[10px] text-tertiary bg-tertiary-container text-on-tertiary-container px-1.5 py-0.5 rounded font-bold">Por unidosis</span>
          )}
        </p>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {payload.map((pld) => {
            const isPropio = propios && propios.includes(pld.name);
            const isPromedio = pld.name === 'Promedio' || pld.name === 'Promedio Mercado';
            const lab = labMap && labMap[pld.name];
            
            return (
              <div key={pld.name} className="flex justify-between gap-4 items-center">
                <div className="flex flex-col">
                  <span className={`font-semibold ${isPropio ? 'text-secondary' : isPromedio ? 'text-amber-600' : 'text-on-surface'}`}>
                    {pld.name}
                    {isPropio && (pld.name.includes('(') ? ' (Mi Marca)' : ' (Mi Cadena)')}
                  </span>
                  {lab && (
                    <span className="text-[10px] text-on-surface-variant font-sans leading-none mt-0.5">
                      Lab: {lab}
                    </span>
                  )}
                </div>
                <span className={`font-mono font-bold ${isPropio ? 'text-secondary' : isPromedio ? 'text-amber-600' : 'text-primary'}`}>
                  {currency === 'usd' ? '$' : 'Bs '}{pld.value?.toFixed(2)}{analisisMode === 'unidosis' ? '/u' : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return null;
}

function BarChartTooltip({ active, payload, label, currency, analisisMode }) {
  if (active && payload && payload.length) {
    const symbol = currency === 'usd' ? '$' : 'Bs ';
    const locale = currency === 'usd' ? 'en-US' : 'es-VE';
    return (
      <div className="bg-surface-container-lowest border border-outline-variant p-3 rounded-2xl shadow-elevation-3 space-y-1.5 max-w-xs text-xs font-sans">
        <p className="font-bold text-primary font-mono border-b border-outline-variant pb-1 flex justify-between items-center gap-2">
          <span>{label}</span>
          {analisisMode === 'unidosis' && (
            <span className="text-[10px] text-tertiary bg-tertiary-container text-on-tertiary-container px-1.5 py-0.5 rounded font-bold">Por unidosis</span>
          )}
        </p>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {payload.map((entry) => (
            <div key={entry.name} className="flex items-center justify-between gap-3 text-[11px]">
              <span className="flex items-center gap-1.5 font-medium" style={{ color: entry.color }}>
                <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }}></span>
                {entry.name}:
              </span>
              <span className="font-mono font-bold text-on-surface">
                {symbol}{Number(entry.value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{analisisMode === 'unidosis' ? '/u' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

export default function ProductDetailModal({ producto, competencia, currency, bcvRate, onClose, initialPriceMode = 'descuento', initialAnalisisMode = 'empaque' }) {
  const { productos = [], productosCompetencia = [], historicoPrecios = [], setHistoricoPrecios } = useData() || {};

  const [activeProduct, setActiveProduct] = useState(producto);
  const [activeCompetencia, setActiveCompetencia] = useState(competencia);

  useEffect(() => {
    setActiveProduct(producto);
  }, [producto]);

  useEffect(() => {
    setActiveCompetencia(competencia);
  }, [competencia]);

  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [priceMode, setPriceMode] = useState(initialPriceMode);
  const [analisisMode, setAnalisisMode] = useState(initialAnalisisMode);
  const [modalCurrency, setModalCurrency] = useState(currency || 'usd');
  const [chartViewType, setChartViewType] = useState('individual'); // 'individual' or 'chainAverage'
  const [barGroupMode, setBarGroupMode] = useState('laboratorio'); // 'laboratorio' | 'cadena'
  const [activeGraphTab, setActiveGraphTab] = useState('barras'); // 'barras' | 'tendencia' | 'ambos'

  // Dropdown selector states
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('Todas');

  // Filters inside modal
  const [filterRelacion, setFilterRelacion] = useState('todos'); // 'todos', 'propio', 'competencia'
  const [filterCadena, setFilterCadena] = useState('todas'); // 'todas', or specific chain name

  const handleSelectProduct = (newProd) => {
    setActiveProduct(newProd);
    if (productosCompetencia && productosCompetencia.length) {
      const compItems = productosCompetencia.filter(
        pc => pc.id_producto_propio === newProd.id_interno && pc.activo
      );
      setActiveCompetencia(compItems);
    } else {
      setActiveCompetencia([]);
    }
  };

  const categoriesList = useMemo(() => {
    const set = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(set).sort()];
  }, [productos]);

  const filteredProducts = useMemo(() => {
    const queryStr = searchTerm.toLowerCase().trim();
    return productos.filter(p => {
      const matchCategory = categoryFilter === 'Todas' || p.categoria === categoryFilter;
      if (!matchCategory) return false;
      if (!queryStr) return true;
      
      const name = (p.nombre || '').toLowerCase();
      const code = (p.id_interno || '').toLowerCase();
      const pa = (p.principio_activo || '').toLowerCase();
      const cat = (p.categoria || '').toLowerCase();
      const pres = (p.presentacion || '').toLowerCase();
      
      return name.includes(queryStr) || code.includes(queryStr) || pa.includes(queryStr) || cat.includes(queryStr) || pres.includes(queryStr);
    });
  }, [productos, searchTerm, categoryFilter]);

  const ownProductCount = useMemo(() => {
    return parseUnidosisCount(activeProduct?.tamano || activeProduct?.presentacion, activeProduct?.nombre, activeProduct?.unidosis);
  }, [activeProduct]);

  const competenciaWithUnidosis = useMemo(() => {
    return activeCompetencia.map(pc => {
      const count = parseUnidosisCount(pc.tamano, pc.marca, pc.unidosis) || ownProductCount;
      const factor = analisisMode === 'unidosis' ? Math.max(count, 1) : 1;
      return {
        ...pc,
        unidosisCount: count,
        factor,
        adjustedFullBs: pc.ultimo_precio_full_bs ? pc.ultimo_precio_full_bs / factor : null,
        adjustedDescBs: pc.ultimo_precio_desc_bs ? pc.ultimo_precio_desc_bs / factor : null,
      };
    });
  }, [activeCompetencia, ownProductCount, analisisMode]);

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      await dbClearHistoricoPrecioForProduct(activeProduct.id_interno);
      setHistorico([]);
      if (setHistoricoPrecios) {
        setHistoricoPrecios(prev => (prev || []).filter(h => h.id_producto_propio !== activeProduct.id_interno));
      }
    } catch (err) {
      console.warn('Aviso al borrar historial de producto:', err?.message || String(err));
      setHistorico([]);
      if (setHistoricoPrecios) {
        setHistoricoPrecios(prev => (prev || []).filter(h => h.id_producto_propio !== activeProduct.id_interno));
      }
    } finally {
      setClearing(false);
      setShowClearConfirm(false);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      let docs = [];

      // Primary: filter from DataContext historicoPrecios
      if (historicoPrecios && historicoPrecios.length > 0) {
        docs = historicoPrecios.filter(h => h.id_producto_propio === activeProduct.id_interno);
      }

      // Secondary: Try fetching from Supabase or Firestore if available and docs is empty
      if (docs.length === 0) {
        try {
          if (supabase) {
            const { data, error: sbErr } = await supabase
              .from('historico_precios')
              .select('*')
              .eq('id_producto_propio', activeProduct.id_interno);
            if (!sbErr && data && data.length > 0) {
              docs = data.map(d => ({
                ...d,
                scraped_at: d.scraped_at ? new Date(d.scraped_at) : null
              }));
            }
          }
        } catch (e) {
          console.warn('Supabase historico fetch warning:', e?.message || String(e));
        }

        if (docs.length === 0 && db) {
          try {
            const q = query(
              collection(db, 'historico_precios'),
              where('id_producto_propio', '==', activeProduct.id_interno)
            );
            const snap = await getDocs(q);
            docs = snap.docs.map(d => ({
              ...d.data(),
              scraped_at: d.data().scraped_at?.toDate?.() || null,
            }));
          } catch (err) {
            console.warn('Firestore historico fetch warning (insufficient permissions or missing collection):', err?.message || String(err));
          }
        }
      }

      docs.sort((a, b) => {
        const tA = a.scraped_at ? (a.scraped_at instanceof Date ? a.scraped_at.getTime() : new Date(a.scraped_at).getTime()) : 0;
        const tB = b.scraped_at ? (b.scraped_at instanceof Date ? b.scraped_at.getTime() : new Date(b.scraped_at).getTime()) : 0;
        return tA - tB;
      });

      setHistorico(docs);
      setLoading(false);
    })();
  }, [activeProduct.id_interno, historicoPrecios]);

  // Pivot: convertir historico en serie por marca-cadena o por promedio de cadena, agrupado por dia.
  const chartData = (() => {
    const byDate = new Map();
    const marcasVistas = new Set();
    const propios = new Set();

    const byDateChain = new Map();
    const chainsVistas = new Set();

    for (const h of historico) {
      if (!h.scraped_at) continue;

      // Apply chain and relation filters to the history to filter chart as requested
      const matchRelacion = filterRelacion === 'todos' || 
        (filterRelacion === 'propio' && h.tipo === 'propio') || 
        (filterRelacion === 'competencia' && h.tipo !== 'propio');
      const matchCadena = filterCadena === 'todas' || h.cadena === filterCadena;
      if (!matchRelacion || !matchCadena) continue;

      const dateKey = h.scraped_at.toISOString().slice(0, 10);
      const marca = `${h.marca} (${h.cadena})`;
      marcasVistas.add(marca);

      if (h.tipo === 'propio') {
        propios.add(marca);
      }

      const rawPrecioBs = priceMode === 'descuento'
        ? (h.precio_desc_bs || h.precio_full_bs)
        : h.precio_full_bs;
      if (!rawPrecioBs) continue;

      const hCount = parseUnidosisCount(h.tamano, h.marca, h.unidosis) || ownProductCount;
      const hFactor = analisisMode === 'unidosis' ? Math.max(hCount, 1) : 1;
      const precioBs = rawPrecioBs / hFactor;
      const precio = modalCurrency === 'usd' && bcvRate ? precioBs / bcvRate : precioBs;

      // 1. Individual Brand structure
      if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey });
      byDate.get(dateKey)[marca] = parseFloat(precio.toFixed(2));

      // 2. Chain Average structure
      if (!byDateChain.has(dateKey)) byDateChain.set(dateKey, { date: dateKey });
      if (!byDateChain.get(dateKey)[h.cadena]) {
        byDateChain.get(dateKey)[h.cadena] = { sum: 0, count: 0 };
      }
      byDateChain.get(dateKey)[h.cadena].sum += precio;
      byDateChain.get(dateKey)[h.cadena].count += 1;
      chainsVistas.add(h.cadena);
    }

    // Process individual series
    const dataIndividual = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    dataIndividual.forEach(item => {
      const keys = Object.keys(item).filter(k => k !== 'date');
      if (keys.length > 0) {
        const sum = keys.reduce((acc, k) => acc + item[k], 0);
        item['Promedio'] = parseFloat((sum / keys.length).toFixed(2));
      }
    });

    // Process chain average series
    const dataChainRaw = Array.from(byDateChain.values()).sort((a, b) => a.date.localeCompare(b.date));
    const dataChain = dataChainRaw.map(item => {
      const newItem = { date: item.date };
      const chainKeys = Object.keys(item).filter(k => k !== 'date');
      let totalSum = 0;
      let totalCount = 0;
      chainKeys.forEach(ch => {
        const avg = item[ch].sum / item[ch].count;
        newItem[ch] = parseFloat(avg.toFixed(2));
        totalSum += item[ch].sum;
        totalCount += item[ch].count;
      });
      if (totalCount > 0) {
        newItem['Promedio'] = parseFloat((totalSum / totalCount).toFixed(2));
      }
      return newItem;
    });

    return {
      individual: {
        data: dataIndividual,
        marcas: Array.from(marcasVistas),
        propios,
      },
      chainAverage: {
        data: dataChain,
        cadenas: Array.from(chainsVistas),
      }
    };
  })();

  // Map each competitor/product key to its laboratory
  const labMap = useMemo(() => {
    const map = new Map();
    for (const c of competenciaWithUnidosis) {
      const key = `${c.marca} (${c.cadena})`;
      map.set(key, c.laboratorio || '');
    }
    return map;
  }, [competenciaWithUnidosis]);

  // Available chains for dropdown filter
  const cadenasDisponibles = useMemo(() => {
    const set = new Set(competenciaWithUnidosis.map(c => c.cadena));
    return Array.from(set).sort();
  }, [competenciaWithUnidosis]);

  // Filtered competition list for table
  const competenciaFiltrada = useMemo(() => {
    const filtered = competenciaWithUnidosis.filter(pc => {
      const matchRelacion = filterRelacion === 'todos' || 
        (filterRelacion === 'propio' && pc.tipo === 'propio') || 
        (filterRelacion === 'competencia' && pc.tipo !== 'propio');
      const matchCadena = filterCadena === 'todas' || pc.cadena === filterCadena;
      return matchRelacion && matchCadena;
    });

    // Multi-criteria sort:
    // 1. Cadena (Alphabetical)
    // 2. Relación (propio / Mi Marca first, so it is in a predictable consistent position)
    // 3. Price (lowest to highest based on current active priceMode)
    return filtered.sort((a, b) => {
      const cadenaA = (a.cadena || '').toLowerCase();
      const cadenaB = (b.cadena || '').toLowerCase();
      if (cadenaA !== cadenaB) {
        return cadenaA.localeCompare(cadenaB, 'es');
      }

      if (a.tipo !== b.tipo) {
        return a.tipo === 'propio' ? -1 : 1;
      }

      const priceA = priceMode === 'descuento'
        ? (a.adjustedDescBs || a.adjustedFullBs || 0)
        : (a.adjustedFullBs || 0);
      const priceB = priceMode === 'descuento'
        ? (b.adjustedDescBs || b.adjustedFullBs || 0)
        : (b.adjustedFullBs || 0);

      return priceA - priceB;
    });
  }, [competenciaWithUnidosis, filterRelacion, filterCadena, priceMode]);

  // Data for Column/Bar chart: Price of each laboratory in each chain (omitting relation/chain filters as requested)
  const barChartData = useMemo(() => {
    const listToUse = competenciaWithUnidosis;
    if (barGroupMode === 'cadena') {
      const dataMap = new Map();
      const seriesSet = new Set();

      for (const pc of listToUse) {
        const cadena = pc.cadena || 'Sin Cadena';
        const labName = pc.laboratorio ? pc.laboratorio : (pc.marca || 'Sin Lab');
        const seriesKey = pc.tipo === 'propio' ? `${labName} ⭐` : labName;

        const rawBs = priceMode === 'descuento'
          ? (pc.adjustedDescBs || pc.adjustedFullBs)
          : pc.adjustedFullBs;

        if (!rawBs || rawBs <= 0) continue;

        const val = modalCurrency === 'usd' && bcvRate ? rawBs / bcvRate : rawBs;
        const priceNum = parseFloat(val.toFixed(2));

        seriesSet.add(seriesKey);

        if (!dataMap.has(cadena)) {
          dataMap.set(cadena, { name: cadena });
        }
        const item = dataMap.get(cadena);

        if (item[seriesKey] !== undefined) {
          const prevSum = item[`_sum_${seriesKey}`] || item[seriesKey];
          const prevCount = item[`_count_${seriesKey}`] || 1;
          const newSum = prevSum + priceNum;
          const newCount = prevCount + 1;
          item[`_sum_${seriesKey}`] = newSum;
          item[`_count_${seriesKey}`] = newCount;
          item[seriesKey] = parseFloat((newSum / newCount).toFixed(2));
        } else {
          item[seriesKey] = priceNum;
        }
      }

      return {
        data: Array.from(dataMap.values()),
        series: Array.from(seriesSet).sort(),
      };
    } else {
      const dataMap = new Map();
      const seriesSet = new Set();

      for (const pc of listToUse) {
        const cadena = pc.cadena || 'Sin Cadena';
        const labName = pc.laboratorio ? pc.laboratorio : (pc.marca || 'Sin Lab');
        const xKey = pc.tipo === 'propio' ? `${labName} ⭐` : labName;
        const seriesKey = cadena;

        const rawBs = priceMode === 'descuento'
          ? (pc.adjustedDescBs || pc.adjustedFullBs)
          : pc.adjustedFullBs;

        if (!rawBs || rawBs <= 0) continue;

        const val = modalCurrency === 'usd' && bcvRate ? rawBs / bcvRate : rawBs;
        const priceNum = parseFloat(val.toFixed(2));

        seriesSet.add(seriesKey);

        if (!dataMap.has(xKey)) {
          dataMap.set(xKey, { name: xKey });
        }
        const item = dataMap.get(xKey);

        if (item[seriesKey] !== undefined) {
          const prevSum = item[`_sum_${seriesKey}`] || item[seriesKey];
          const prevCount = item[`_count_${seriesKey}`] || 1;
          const newSum = prevSum + priceNum;
          const newCount = prevCount + 1;
          item[`_sum_${seriesKey}`] = newSum;
          item[`_count_${seriesKey}`] = newCount;
          item[seriesKey] = parseFloat((newSum / newCount).toFixed(2));
        } else {
          item[seriesKey] = priceNum;
        }
      }

      return {
        data: Array.from(dataMap.values()),
        series: Array.from(seriesSet).sort(),
      };
    }
  }, [competenciaWithUnidosis, barGroupMode, priceMode, modalCurrency, bcvRate]);

  // Calculate overall average price across all items for the column chart reference line
  const overallBarAverage = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const pc of competenciaWithUnidosis) {
      const rawBs = priceMode === 'descuento'
        ? (pc.adjustedDescBs || pc.adjustedFullBs)
        : pc.adjustedFullBs;
      if (rawBs && rawBs > 0) {
        const val = modalCurrency === 'usd' && bcvRate ? rawBs / bcvRate : rawBs;
        sum += val;
        count++;
      }
    }
    return count > 0 ? parseFloat((sum / count).toFixed(2)) : null;
  }, [competenciaWithUnidosis, priceMode, modalCurrency, bcvRate]);

  // Minimum and maximum prices for highlights in table (calculated on filtered set)
  const validFullPrices = competenciaFiltrada
    .map(c => c.adjustedFullBs)
    .filter(p => p && p > 0);
  const minFullPriceBs = validFullPrices.length > 0 ? Math.min(...validFullPrices) : null;
  const maxFullPriceBs = validFullPrices.length > 0 ? Math.max(...validFullPrices) : null;
  const avgFullPriceBs = validFullPrices.length > 0 ? validFullPrices.reduce((a, b) => a + b, 0) / validFullPrices.length : null;

  const validDescPrices = competenciaFiltrada
    .map(c => c.adjustedDescBs)
    .filter(p => p && p > 0);
  const minDescPriceBs = validDescPrices.length > 0 ? Math.min(...validDescPrices) : null;
  const maxDescPriceBs = validDescPrices.length > 0 ? Math.max(...validDescPrices) : null;
  const avgDescPriceBs = validDescPrices.length > 0 ? validDescPrices.reduce((a, b) => a + b, 0) / validDescPrices.length : null;

  // Calculations for smart indicators (calculated on filtered set)
  const validPrices = competenciaFiltrada
    .map(c => {
      const pBs = priceMode === 'descuento'
        ? (c.adjustedDescBs || c.adjustedFullBs)
        : c.adjustedFullBs;
      return pBs ? { cadena: c.cadena, marca: c.marca, priceBs: pBs, tipo: c.tipo, count: c.unidosisCount } : null;
    })
    .filter(Boolean);

  const minPriceItem = validPrices.length > 0 
    ? validPrices.reduce((prev, curr) => (prev.priceBs < curr.priceBs) ? prev : curr)
    : null;

  const avgPriceBs = validPrices.length > 0
    ? validPrices.reduce((sum, item) => sum + item.priceBs, 0) / validPrices.length
    : null;

  const propioItem = competenciaFiltrada.find(c => c.tipo === 'propio') || competenciaWithUnidosis.find(c => c.tipo === 'propio');
  const propioPriceBs = propioItem 
    ? (priceMode === 'descuento' 
        ? (propioItem.adjustedDescBs || propioItem.adjustedFullBs)
        : propioItem.adjustedFullBs)
    : null;

  const diffMinBs = (propioPriceBs !== null && minPriceItem !== null) ? propioPriceBs - minPriceItem.priceBs : null;
  const pctMin = (diffMinBs !== null && minPriceItem.priceBs > 0) ? (diffMinBs / minPriceItem.priceBs) * 100 : null;

  const diffAvgBs = (propioPriceBs !== null && avgPriceBs !== null) ? propioPriceBs - avgPriceBs : null;
  const pctAvg = (diffAvgBs !== null && avgPriceBs > 0) ? (diffAvgBs / avgPriceBs) * 100 : null;

  const getChainSpecificColor = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    if (lower.includes('farmatodo')) return '#004ecb'; // Farmatodo en azul
    if (lower.includes('locatel')) return '#2e7d32'; // Locatel en verde
    if (lower.includes('saas')) return '#0d9488'; // SAAS en azul-verde / teal
    return null;
  };

  const getLineColor = (marcaName, index, isPropioChain = false) => {
    const chainColor = getChainSpecificColor(marcaName);
    if (chainColor) return chainColor;

    if (isPropioChain || (chartData?.individual?.propios && chartData.individual.propios.has(marcaName))) {
      return '#2e7d32'; // Always green for Propio
    }
    const competitorColors = ['#040d53', '#ba1a1a', '#004ecb', '#0891b2', '#db2777', '#8b5cf6', '#ea580c', '#3b82f6'];
    return competitorColors[index % competitorColors.length];
  };

  const getBarColor = (seriesKey) => {
    const chainColor = getChainSpecificColor(seriesKey);
    if (chainColor) return chainColor;

    const isPropio = seriesKey.includes('⭐') || 
      (propioItem && seriesKey === propioItem.cadena) ||
      (propioItem && propioItem.marca && seriesKey.toLowerCase().includes(propioItem.marca.toLowerCase()));

    if (isPropio) {
      return '#2e7d32'; // Always green for user's product/brand/chain
    }
    const competitorColors = ['#040d53', '#004ecb', '#ba1a1a', '#0891b2', '#db2777', '#8b5cf6', '#ea580c', '#3b82f6'];
    let hash = 0;
    for (let i = 0; i < seriesKey.length; i++) {
      hash = seriesKey.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colorIndex = Math.abs(hash) % competitorColors.length;
    return competitorColors[colorIndex];
  };
  const formatHeaderPrice = (priceBs) => {
    if (priceBs == null) return '—';
    const suffix = analisisMode === 'unidosis' ? '/u' : '';
    if (modalCurrency === 'usd') {
      if (!bcvRate) return '—';
      return '$' + (priceBs / bcvRate).toFixed(2) + suffix;
    }
    return 'Bs ' + priceBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
  };

  return createPortal(
    <div className="fixed inset-0 bg-[#f8f9fa] z-50 flex flex-col overflow-hidden animate-fade-in text-[#1c1b1f]">
      {/* Header Navigation Bar */}
      <div className="bg-white border-b border-[#e1e2ec] px-4 md:px-8 py-3 flex items-center justify-between gap-4 shrink-0 shadow-sm z-30">
        {/* Left: Regresar / Volver button */}
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-3.5 py-2 bg-white border border-[#e1e2ec] hover:bg-[#f3f4f9] text-[#040d53] text-xs font-bold rounded-xl transition-all shadow-xs group"
            title="Regresar a la pantalla principal"
          >
            <span className="material-symbols-outlined text-base group-hover:-translate-x-0.5 transition-transform">
              arrow_back
            </span>
            <span className="hidden sm:inline">Volver</span>
          </button>
          <div className="h-6 w-[1px] bg-[#e1e2ec] hidden sm:block"></div>
        </div>

        {/* Center: Searchable Product Selector Dropdown */}
        <div className="flex-1 max-w-2xl relative">
          <button
            onClick={() => setDropdownOpen(prev => !prev)}
            className="w-full bg-[#f3f4f9] hover:bg-[#e8eaef] border border-[#e1e2ec] rounded-2xl px-3.5 py-2 flex items-center justify-between transition-all shadow-xs text-left group"
          >
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-xl bg-[#040d53] text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs font-mono">
                {activeProduct.id_interno || 'P'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-sm text-[#040d53] truncate">{activeProduct.nombre}</span>
                  {activeProduct.categoria && (
                    <span className="hidden sm:inline-block px-2 py-0.5 bg-[#e1e2ec] text-[#040d53] text-[10px] font-bold rounded-md font-mono shrink-0">
                      {activeProduct.categoria}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#464650] truncate leading-tight">
                  {activeProduct.principio_activo || 'Sin principio activo'} · {activeProduct.concentracion || ''} {activeProduct.presentacion || ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[#040d53] font-bold text-xs shrink-0 pl-2">
              <span className="hidden md:inline text-[11px] font-mono text-[#464650]">Cambiar producto</span>
              <span className="material-symbols-outlined text-lg group-hover:translate-y-0.5 transition-transform">
                {dropdownOpen ? 'expand_less' : 'unfold_more'}
              </span>
            </div>
          </button>

          {/* Searchable Dropdown Popover */}
          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setDropdownOpen(false)}></div>
              <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-[#e1e2ec] shadow-2xl z-40 p-3 space-y-2.5 animate-fade-in max-w-2xl w-full">
                {/* Search Bar */}
                <div className="relative flex items-center">
                  <span className="material-symbols-outlined absolute left-3 text-[18px] text-[#464650] pointer-events-none select-none">search</span>
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Buscar por nombre, id, principio activo o categoría..."
                    className="w-full pl-10 pr-8 py-2 bg-[#f3f4f9] border border-[#e1e2ec] focus:border-[#040d53] focus:bg-white rounded-xl text-xs font-medium text-[#1c1b1f] placeholder-[#464650]/60 outline-none transition-all"
                    autoFocus
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="absolute right-2.5 text-[#464650] hover:text-black w-5 h-5 flex items-center justify-center rounded-full"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                </div>

                {/* Categories Horizontal Scroll */}
                {categoriesList.length > 2 && (
                  <div className="flex items-center gap-1 overflow-x-auto pb-1 no-scrollbar text-[11px]">
                    {categoriesList.map(cat => (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(cat)}
                        className={`px-2.5 py-1 rounded-lg text-[10.5px] font-bold whitespace-nowrap transition-all ${
                          categoryFilter === cat
                            ? 'bg-[#040d53] text-white shadow-xs'
                            : 'bg-[#f3f4f9] text-[#464650] hover:bg-[#e1e2ec]'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                )}

                {/* Counter */}
                <div className="flex items-center justify-between text-[11px] font-mono text-[#464650] px-1 border-b border-[#f3f4f9] pb-1.5">
                  <span>{filteredProducts.length} productos coincidentes</span>
                  <span>{productos.length} total</span>
                </div>

                {/* Product List */}
                <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                  {filteredProducts.length === 0 ? (
                    <div className="p-4 text-center text-xs text-[#464650] italic">
                      No se encontraron productos que coincidan con "{searchTerm}"
                    </div>
                  ) : (
                    filteredProducts.map(p => {
                      const isSelected = p.id_interno === activeProduct.id_interno;
                      const compCount = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo).length;

                      return (
                        <button
                          key={p.id_interno || p.id}
                          onClick={() => {
                            handleSelectProduct(p);
                            setDropdownOpen(false);
                          }}
                          className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between gap-3 ${
                            isSelected
                              ? 'bg-[#040d53]/5 border border-[#040d53]/20 text-[#040d53]'
                              : 'hover:bg-[#f3f4f9] border border-transparent text-[#1c1b1f]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-extrabold text-xs truncate">{p.nombre}</span>
                              <span className="px-1.5 py-0.2 bg-[#f3f4f9] text-[#040d53] text-[9.5px] font-mono font-bold rounded">
                                {p.id_interno}
                              </span>
                            </div>
                            <p className="text-[11px] text-[#464650] truncate mt-0.5">
                              {p.principio_activo || '—'} {p.concentracion || ''} · {p.presentacion || ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] font-mono font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full">
                              {compCount} comp.
                            </span>
                            {isSelected && (
                              <span className="material-symbols-outlined text-base text-[#040d53] font-bold">check_circle</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={clearing || historico.length === 0}
            className="px-3 py-2 border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl text-xs font-bold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-xs"
            title="Eliminar historial acumulado para este producto"
          >
            <span className="material-symbols-outlined text-base">delete_sweep</span>
            <span className="hidden lg:inline">Limpiar Historial</span>
          </button>
          <button
            onClick={onClose}
            className="p-2 text-[#464650] hover:text-black hover:bg-[#e1e2ec]/50 rounded-xl transition-colors"
            title="Cerrar vista"
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>
        </div>
      </div>

      {/* Main Content Scrollable Container */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-7xl mx-auto w-full space-y-6">
          {/* Price and Currency Switch Controls */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-[#f3f4f9] p-4 rounded-2xl border border-[#e1e2ec] animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 flex-1">
              {/* Unidosis vs Empaque Switcher */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">medication</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Modo:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setAnalisisMode('empaque')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      analisisMode === 'empaque' 
                        ? 'bg-[#040d53] text-white shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Empaque
                  </button>
                  <button
                    onClick={() => setAnalisisMode('unidosis')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      analisisMode === 'unidosis' 
                        ? 'bg-[#040d53] text-white shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                    title="Analizar precios normalizados por 1 unidad/tableta/dosis"
                  >
                    Unidosis
                  </button>
                </div>
              </div>

              {/* Modo de Comparacion Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">receipt_long</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Comparación:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setPriceMode('descuento')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      priceMode === 'descuento' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Oferta
                  </button>
                  <button
                    onClick={() => setPriceMode('lista')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1 ${
                      priceMode === 'lista' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Lista
                  </button>
                </div>
              </div>

              {/* Moneda Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">monetization_on</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Moneda:</span>
                </div>
                <div className="bg-[#e1e2ec] p-1 rounded-xl flex gap-1 h-[34px] items-center">
                  <button
                    onClick={() => setModalCurrency('usd')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all ${
                      modalCurrency === 'usd' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    USD ($)
                  </button>
                  <button
                    onClick={() => setModalCurrency('bs')}
                    className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition-all ${
                      modalCurrency === 'bs' 
                        ? 'bg-white text-[#040d53] shadow-sm' 
                        : 'text-[#464650] hover:bg-white/50'
                    }`}
                  >
                    Bs
                  </button>
                </div>
              </div>

              {/* Relación Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">groups</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Relación Marca:</span>
                </div>
                <select
                  value={filterRelacion}
                  onChange={(e) => setFilterRelacion(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-[11px] font-bold focus:outline-none focus:border-[#040d53] text-[#464650] h-[34px] w-full"
                >
                  <option value="todos">Todos</option>
                  <option value="propio">Mi Marca</option>
                  <option value="competencia">Competidores</option>
                </select>
              </div>

              {/* Cadena Selector */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[#464650]">
                  <span className="material-symbols-outlined text-[16px]">storefront</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Cadena:</span>
                </div>
                <select
                  value={filterCadena}
                  onChange={(e) => setFilterCadena(e.target.value)}
                  className="bg-white border border-[#e1e2ec] rounded-xl px-2.5 py-1 text-[11px] font-bold focus:outline-none focus:border-[#040d53] text-[#464650] h-[34px] w-full"
                >
                  <option value="todas">Todas</option>
                  {cadenasDisponibles.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* BCV Rate Badge */}
            {bcvRate && (
              <div className="flex items-center gap-2 bg-white/60 border border-[#e1e2ec] px-3 py-2 rounded-xl text-[11px] font-mono text-[#464650] self-start xl:self-auto min-w-[110px] justify-center h-[34px] mt-auto">
                <span className="text-[9px] uppercase font-bold text-[#464650]/70">Tasa BCV:</span>
                <span className="font-extrabold text-[#040d53]">Bs {bcvRate.toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Smart Indicators Card Grid */}
          {validPrices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
              {/* Mas Barato Card */}
              <div className="bg-white border border-outline-variant p-4 rounded-2xl shadow-sm flex items-center justify-between relative">
                <div className="space-y-0.5 flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant truncate">
                      Más Barato {filterCadena !== 'todas' ? `(${filterCadena})` : (analisisMode === 'unidosis' ? '(Unidosis)' : '(Mercado)')}
                    </span>
                    <InfoTooltip text="El precio mínimo detectado entre todos tus competidores en el mercado para el modo seleccionado (con descuento o de lista)." align="left" />
                  </div>
                  <div className="text-xl font-display font-extrabold text-emerald-700">
                    {formatHeaderPrice(minPriceItem?.priceBs)}
                  </div>
                  <p className="text-[11px] text-on-surface-variant truncate font-sans">
                    En: {minPriceItem?.cadena} ({minPriceItem?.marca})
                  </p>
                </div>
                <div className="w-11 h-11 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                  <span className="material-symbols-outlined text-xl select-none">savings</span>
                </div>
              </div>

              {/* Mi Precio Card */}
              <div className="bg-white border border-emerald-500/30 p-4 rounded-2xl shadow-sm flex items-center justify-between relative">
                <div className="space-y-0.5 flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-emerald-800 truncate">
                      Mi Precio {analisisMode === 'unidosis' ? '(Unidosis)' : '(Marca Propia)'}
                    </span>
                    <InfoTooltip text="El precio actual de tu producto marca propia. Se muestra en verde para resaltar que es la referencia de tu marca." align="left" />
                  </div>
                  <div className="text-xl font-display font-extrabold text-emerald-800">
                    {propioPriceBs ? formatHeaderPrice(propioPriceBs) : '—'}
                  </div>
                  <p className="text-[11px] text-emerald-700 font-sans truncate">
                    {propioItem ? `Marca: ${propioItem.marca}` : 'No vinculado'}
                  </p>
                </div>
                <div className="w-11 h-11 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-800 shrink-0">
                  <span className="material-symbols-outlined text-xl select-none">verified_user</span>
                </div>
              </div>

              {/* vs Minimo Card */}
              <div className="bg-white border border-outline-variant p-4 rounded-2xl shadow-sm flex items-center justify-between relative">
                <div className="space-y-0.5 flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant truncate">Diferencia vs Mínimo</span>
                    <InfoTooltip text="Calculado como: ((Mi Precio - Precio Mínimo) / Precio Mínimo) * 100. Te indica qué tan por encima del precio más económico del mercado te encuentras. El valor ideal es <= 0%." align="right" />
                  </div>
                  {propioPriceBs && minPriceItem ? (
                    <>
                      <div className={`text-xl font-display font-extrabold ${pctMin && pctMin > 0.005 ? 'text-error' : 'text-emerald-700'}`}>
                        {pctMin && pctMin > 0.005 ? `+${pctMin.toFixed(2)}%` : '¡Precio Mínimo!'}
                      </div>
                      <p className="text-[11px] text-on-surface-variant font-sans truncate">
                        {pctMin && pctMin > 0.005 ? `+${formatHeaderPrice(diffMinBs)} vs mín.` : 'Líder en este producto'}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="text-xl font-display font-bold text-gray-300">—</div>
                      <p className="text-[11px] text-on-surface-variant font-sans">—</p>
                    </>
                  )}
                </div>
                <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${pctMin && pctMin > 0.005 ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
                  <span className="material-symbols-outlined text-xl select-none">balance</span>
                </div>
              </div>

              {/* Precio Promedio Card */}
              <div className="bg-white border border-outline-variant p-4 rounded-2xl shadow-sm flex items-center justify-between relative">
                <div className="space-y-0.5 flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant truncate">
                      Promedio {filterCadena !== 'todas' ? `(${filterCadena})` : (analisisMode === 'unidosis' ? '(Unidosis)' : '(Mercado)')}
                    </span>
                    <InfoTooltip text="El precio promedio aritmético calculado entre todos los competidores vigentes en el mercado." align="right" />
                  </div>
                  <div className="text-xl font-display font-extrabold text-primary">
                    {avgPriceBs ? formatHeaderPrice(avgPriceBs) : '—'}
                  </div>
                  {propioPriceBs && avgPriceBs ? (
                    <p className="text-[11px] font-sans truncate">
                      Mi precio:{' '}
                      <span className={pctAvg && pctAvg > 0 ? 'text-error font-bold' : 'text-emerald-700 font-bold'}>
                        {pctAvg && pctAvg > 0 ? `+${pctAvg.toFixed(1)}%` : `${pctAvg?.toFixed(1)}%`}
                      </span>
                    </p>
                  ) : (
                    <p className="text-[11px] text-on-surface-variant font-sans">
                      Referencia del mercado
                    </p>
                  )}
                </div>
                <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-xl select-none">analytics</span>
                </div>
              </div>
            </div>
          )}

          {/* Current Competitor Prices Table */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">payments</span>
                Precios Actuales por Cadena Farmacéutica {analisisMode === 'unidosis' ? '(Por Unidosis / Dosis)' : ''}
              </h3>
            </div>

            <div className="border border-outline-variant rounded-2xl overflow-hidden bg-white shadow-xs">
              <div className="overflow-x-auto">
                <table className="m3-table">
                  <thead className="m3-sticky-header">
                    <tr>
                      <th>Cadena</th>
                      <th>Marca / Variante</th>
                      <th>Relación</th>
                      <th className="text-right">
                        Precio Lista {analisisMode === 'unidosis' ? '(/u)' : ''}
                      </th>
                      <th className="text-right">
                        Precio Oferta {analisisMode === 'unidosis' ? '(/u)' : ''}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-variant">
                    {competenciaFiltrada.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="px-6 py-8 text-center text-on-surface-variant italic bg-white">
                          Sin productos que coincidan con los filtros seleccionados.
                        </td>
                      </tr>
                    ) : (
                      competenciaFiltrada.map(pc => {
                        const isCheapestFull = pc.adjustedFullBs && pc.adjustedFullBs === minFullPriceBs;
                        const isCheapestDesc = pc.adjustedDescBs && pc.adjustedDescBs === minDescPriceBs;
                        const isMostExpensiveFull = pc.adjustedFullBs && pc.adjustedFullBs === maxFullPriceBs && maxFullPriceBs > minFullPriceBs;
                        const isMostExpensiveDesc = pc.adjustedDescBs && pc.adjustedDescBs === maxDescPriceBs && maxDescPriceBs > minDescPriceBs;
                        
                        return (
                          <tr key={pc.id} className="hover:bg-surface-low transition-colors">
                            <td className="font-bold text-primary font-display text-sm">{pc.cadena}</td>
                            <td className="font-semibold text-on-surface">
                              {pc.url ? (
                                <a
                                  href={pc.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline inline-flex items-center gap-1 group transition-all"
                                  title="Ver enlace de origen del producto ↗"
                                >
                                  <span className="font-semibold">{pc.marca} {pc.concentracion || ''} {pc.tamano || ''}</span>
                                  {pc.unidosisCount > 0 && (
                                    <span className="px-1.5 py-0.2 text-[10px] bg-sky-50 text-sky-700 border border-sky-200 rounded font-bold ml-1">
                                      {pc.unidosisCount}u
                                    </span>
                                  )}
                                  <span className="material-symbols-outlined text-[13px] text-primary/70 group-hover:text-primary transition-colors leading-none">
                                    open_in_new
                                  </span>
                                </a>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <span>{pc.marca} {pc.concentracion || ''} {pc.tamano || ''}</span>
                                  {pc.unidosisCount > 0 && (
                                    <span className="px-1.5 py-0.2 text-[10px] bg-sky-50 text-sky-700 border border-sky-200 rounded font-bold">
                                      {pc.unidosisCount}u
                                    </span>
                                  )}
                                </div>
                              )}
                              {pc.laboratorio && (
                                <div className="text-xs text-on-surface-variant font-mono mt-0.5">Lab: {pc.laboratorio}</div>
                              )}
                            </td>
                            <td>
                              <span className={`text-[10px] uppercase font-mono font-bold px-2 py-0.5 rounded-full ${
                                pc.tipo === 'propio' ? 'bg-secondary/10 text-secondary border border-secondary/20' : 'bg-surface-low text-on-surface-variant border border-outline-variant'
                              }`}>
                                {pc.tipo === 'propio' ? 'Mi Marca' : 'Competencia'}
                              </span>
                            </td>
                            <td className="text-right font-mono font-bold text-on-surface">
                              <div className="flex flex-col items-end justify-center">
                                <span className={
                                  isCheapestFull ? 'text-emerald-700 font-extrabold' : 
                                  isMostExpensiveFull ? 'text-rose-700 font-extrabold' : ''
                                }>
                                  {formatHeaderPrice(pc.adjustedFullBs)}
                                </span>
                                {isCheapestFull && (
                                  <span className="text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                    Más bajo
                                  </span>
                                )}
                                {isMostExpensiveFull && (
                                  <span className="text-[9px] bg-rose-50 text-rose-700 border border-rose-200 font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                    Más alto
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="text-right font-mono font-extrabold text-primary">
                              <div className="flex flex-col items-end justify-center">
                                <span className={
                                  isCheapestDesc ? 'text-emerald-700 font-extrabold' : 
                                  isMostExpensiveDesc ? 'text-rose-700 font-extrabold' : ''
                                }>
                                  {formatHeaderPrice(pc.adjustedDescBs)}
                                </span>
                                {isCheapestDesc && (
                                  <span className="text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                    Más bajo
                                  </span>
                                )}
                                {isMostExpensiveDesc && (
                                  <span className="text-[9px] bg-rose-50 text-rose-700 border border-rose-200 font-bold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide">
                                    Más alto
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {competenciaFiltrada.length > 0 && (
                    <tfoot className="bg-surface-low border-t-2 border-outline-variant font-mono text-xs font-bold">
                      <tr className="border-b border-outline-variant/60">
                        <td colSpan="3" className="px-5 py-2.5 text-right font-sans text-on-surface-variant uppercase tracking-wider text-[10px]">
                          Mínimo de la Lista
                        </td>
                        <td className="px-5 py-2.5 text-right text-emerald-700 font-extrabold">
                          {minFullPriceBs ? formatHeaderPrice(minFullPriceBs) : '—'}
                        </td>
                        <td className="px-5 py-2.5 text-right text-emerald-700 font-extrabold">
                          {minDescPriceBs ? formatHeaderPrice(minDescPriceBs) : '—'}
                        </td>
                      </tr>
                      <tr className="border-b border-outline-variant/60">
                        <td colSpan="3" className="px-5 py-2.5 text-right font-sans text-on-surface-variant uppercase tracking-wider text-[10px]">
                          Máximo de la Lista
                        </td>
                        <td className="px-5 py-2.5 text-right text-rose-700 font-extrabold">
                          {maxFullPriceBs ? formatHeaderPrice(maxFullPriceBs) : '—'}
                        </td>
                        <td className="px-5 py-2.5 text-right text-rose-700 font-extrabold">
                          {maxDescPriceBs ? formatHeaderPrice(maxDescPriceBs) : '—'}
                        </td>
                      </tr>
                      <tr className="bg-surface-container-high/60">
                        <td colSpan="3" className="px-5 py-3 text-right font-sans text-primary uppercase tracking-wider text-[10px] font-extrabold">
                          Promedio General ({competenciaFiltrada.length} items)
                        </td>
                        <td className="px-5 py-3 text-right text-on-surface font-black text-xs">
                          {avgFullPriceBs ? formatHeaderPrice(avgFullPriceBs) : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-on-surface font-black text-xs">
                          {avgDescPriceBs ? formatHeaderPrice(avgDescPriceBs) : '—'}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>

          {/* Chart Section Header with Tab Switch */}
          <div className="space-y-4 pt-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-[#e1e2ec] shadow-sm">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-[#040d53]">analytics</span>
                <span className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider">Análisis Gráfico</span>
              </div>
              <div className="bg-[#f3f4f9] p-1 rounded-xl flex gap-1 border border-[#e1e2ec]">
                <button
                  onClick={() => setActiveGraphTab('tendencia')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                    activeGraphTab === 'tendencia'
                      ? 'bg-[#040d53] text-white shadow-sm'
                      : 'text-[#464650] hover:bg-white/60'
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">show_chart</span>
                  Historial de Tendencia
                </button>
                <button
                  onClick={() => setActiveGraphTab('barras')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                    activeGraphTab === 'barras'
                      ? 'bg-[#040d53] text-white shadow-sm'
                      : 'text-[#464650] hover:bg-white/60'
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">bar_chart</span>
                  Precios por Laboratorio
                </button>
                <button
                  onClick={() => setActiveGraphTab('ambos')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                    activeGraphTab === 'ambos'
                      ? 'bg-[#040d53] text-white shadow-sm'
                      : 'text-[#464650] hover:bg-white/60'
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">grid_view</span>
                  Ver Ambos
                </button>
              </div>
            </div>

            {/* Historical Trend Chart */}
            {(activeGraphTab === 'tendencia' || activeGraphTab === 'ambos') && (
              <div className="space-y-2 animate-fade-in">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">show_chart</span>
                    Historial de Tendencia de Precios ({modalCurrency === 'usd' ? 'USD $' : 'Bs'})
                  </h3>
                  {historico.length > 0 && (
                    <button
                      onClick={() => setShowClearConfirm(true)}
                      className="text-[10px] font-bold text-[#ba1a1a] hover:bg-red-50 px-3 py-1 rounded-full border border-red-200 transition-all flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[12px]">delete</span>
                      Borrar histórico
                    </button>
                  )}
                </div>
                <div className="bg-white rounded-2xl border border-[#e1e2ec] p-4 shadow-sm space-y-4">
                  {/* Selector de tipo de gráfico */}
                  {historico.length > 0 && !loading && !error && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#e1e2ec] animate-fade-in">
                      <div className="flex items-center gap-1.5 text-[#464650]">
                        <span className="material-symbols-outlined text-[16px]">insights</span>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Modo del Gráfico:</span>
                      </div>
                      <div className="bg-[#f3f4f9] p-0.5 rounded-xl flex gap-1 self-start sm:self-auto border border-[#e1e2ec]">
                        <button
                          onClick={() => setChartViewType('individual')}
                          className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                            chartViewType === 'individual'
                              ? 'bg-white text-[#040d53] shadow-sm'
                              : 'text-[#464650] hover:bg-white/50'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]">medication</span>
                          Detalle por Variante
                        </button>
                        <button
                          onClick={() => setChartViewType('chainAverage')}
                          className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                            chartViewType === 'chainAverage'
                              ? 'bg-white text-[#040d53] shadow-sm'
                              : 'text-[#464650] hover:bg-white/50'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]">corporate_fare</span>
                          Promedio por Cadena
                        </button>
                      </div>
                    </div>
                  )}

                  {loading ? (
                    <div className="h-64 flex flex-col items-center justify-center text-xs text-[#464650] font-semibold gap-1.5 animate-pulse">
                      <span className="material-symbols-outlined animate-spin text-2xl text-[#040d53]">autorenew</span>
                      Cargando tendencia histórica...
                    </div>
                  ) : error ? (
                    <div className="h-64 flex items-center justify-center text-[#ba1a1a] text-xs font-mono font-bold">{error}</div>
                  ) : chartData[chartViewType].data.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-[#464650] text-xs italic text-center px-4">
                      No hay suficiente historial que coincida con los filtros seleccionados (relación / cadena) para este gráfico.
                    </div>
                  ) : (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart 
                          key={`trend-line-${chartViewType}-${competenciaWithUnidosis.length}-${chartData[chartViewType].data.length}`}
                          data={chartData[chartViewType].data} 
                          margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                          <XAxis 
                            dataKey="date" 
                            tickFormatter={(tick) => {
                              try {
                                const parts = tick.split('-');
                                if (parts.length === 3) {
                                  return `${parts[2]}/${parts[1]}`;
                                }
                              } catch (e) {}
                              return tick;
                            }}
                            tick={{ fontSize: 11, fill: '#464650' }} 
                          />
                          <YAxis tick={{ fontSize: 11, fill: '#464650' }} />
                          <Tooltip content={
                            <CustomTooltip 
                              propios={chartViewType === 'individual' 
                                ? Array.from(chartData.individual.propios) 
                                : (propioItem ? [propioItem.cadena] : [])
                              } 
                              labMap={chartViewType === 'individual' ? Object.fromEntries(labMap) : {}} 
                              currency={modalCurrency} 
                              analisisMode={analisisMode}
                            />
                          } />
                          <Legend wrapperStyle={{ fontSize: 11, marginTop: 10 }} />
                          
                          {chartViewType === 'individual' ? (
                            chartData.individual.marcas.map((m, i) => {
                              const isPropio = chartData.individual.propios.has(m);
                              return (
                                <Line
                                  key={m}
                                  type="monotone"
                                  dataKey={m}
                                  name={isPropio ? `${m} ⭐ (Mi Marca)` : m}
                                  stroke={getLineColor(m, i)}
                                  strokeWidth={isPropio ? 4.5 : 2}
                                  dot={{ r: isPropio ? 5 : 3 }}
                                  connectNulls
                                  isAnimationActive={true}
                                  animationDuration={750}
                                  animationBegin={0}
                                  animationEasing="ease-out"
                                />
                              );
                            })
                          ) : (
                            chartData.chainAverage.cadenas.map((c, i) => {
                              const isPropioChain = propioItem && propioItem.cadena === c;
                              return (
                                <Line
                                  key={c}
                                  type="monotone"
                                  dataKey={c}
                                  name={isPropioChain ? `${c} ⭐ (Mi Cadena)` : c}
                                  stroke={getLineColor(c, i, isPropioChain)}
                                  strokeWidth={isPropioChain ? 4.5 : 2}
                                  dot={{ r: isPropioChain ? 5 : 3 }}
                                  connectNulls
                                  isAnimationActive={true}
                                  animationDuration={750}
                                  animationBegin={0}
                                  animationEasing="ease-out"
                                />
                              );
                            })
                          )}

                          {/* Línea especial para el Promedio del mercado */}
                          {chartData[chartViewType].data.length > 0 && (
                            <Line
                              type="monotone"
                              dataKey="Promedio"
                              name="Promedio Mercado"
                              stroke="#ea580c"
                              strokeWidth={3}
                              strokeDasharray="6 4"
                              dot={{ r: 4 }}
                              connectNulls
                              isAnimationActive={true}
                              animationDuration={750}
                              animationBegin={0}
                              animationEasing="ease-out"
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Column Chart: Price of each laboratory in each chain */}
            {(activeGraphTab === 'barras' || activeGraphTab === 'ambos') && (
              <div className="space-y-2 animate-fade-in">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-[#040d53] uppercase font-mono tracking-wider flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">bar_chart</span>
                    Precios por Laboratorio por Cadena ({modalCurrency === 'usd' ? 'USD $' : 'Bs'})
                  </h3>
                </div>
                <div className="bg-white rounded-2xl border border-[#e1e2ec] p-4 shadow-sm space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#e1e2ec]">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5 text-[#464650]">
                        <span className="material-symbols-outlined text-[16px]">tune</span>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider font-mono">Agrupar Eje X Por:</span>
                      </div>
                      <div className="bg-[#f3f4f9] p-0.5 rounded-xl flex gap-1 border border-[#e1e2ec]">
                        <button
                          onClick={() => setBarGroupMode('laboratorio')}
                          className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                            barGroupMode === 'laboratorio'
                              ? 'bg-white text-[#040d53] shadow-sm'
                              : 'text-[#464650] hover:bg-white/50'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]">science</span>
                          Por Laboratorio
                        </button>
                        <button
                          onClick={() => setBarGroupMode('cadena')}
                          className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 ${
                            barGroupMode === 'cadena'
                              ? 'bg-white text-[#040d53] shadow-sm'
                              : 'text-[#464650] hover:bg-white/50'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]">storefront</span>
                          Por Cadena
                        </button>
                      </div>
                    </div>

                    {overallBarAverage !== null && (
                      <div className="flex items-center gap-1.5 bg-orange-50 border border-orange-200 text-[#ea580c] px-3 py-1 rounded-xl text-[11px] font-bold font-mono self-start sm:self-auto shadow-xs">
                        <span className="material-symbols-outlined text-[15px]">show_chart</span>
                        <span>Promedio General: {modalCurrency === 'usd' ? '$' : 'Bs '}{overallBarAverage.toLocaleString(modalCurrency === 'usd' ? 'en-US' : 'es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    )}
                  </div>

                  {barChartData.data.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-[#464650] text-xs italic text-center px-4">
                      No hay productos registrados para mostrar en este gráfico.
                    </div>
                  ) : (
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart 
                          key={`modal-bars-${barGroupMode}-${modalCurrency}-${barChartData.data.length}`}
                          data={barChartData.data} 
                          margin={{ top: 22, right: 10, left: -10, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#464650' }} />
                          <YAxis tick={{ fontSize: 11, fill: '#464650' }} />
                          <Tooltip content={<BarChartTooltip currency={modalCurrency} analisisMode={analisisMode} />} />
                          <Legend wrapperStyle={{ fontSize: 11, marginTop: 10 }} />
                          {overallBarAverage !== null && (
                            <ReferenceLine
                              y={overallBarAverage}
                              stroke="#ea580c"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                              strokeOpacity={0.7}
                              isFront={false}
                            />
                          )}
                          {barChartData.series.map((seriesKey) => {
                            const barColor = getBarColor(seriesKey);
                            const symbol = modalCurrency === 'usd' ? '$' : 'Bs ';
                            return (
                              <Bar
                                key={seriesKey}
                                dataKey={seriesKey}
                                name={seriesKey}
                                fill={barColor}
                                radius={[4, 4, 0, 0]}
                                isAnimationActive={true}
                                animationDuration={750}
                                animationBegin={0}
                                animationEasing="ease-out"
                              >
                                {barGroupMode === 'cadena' && barChartData.data.map((entry, idx) => {
                                  const cellColor = getChainSpecificColor(entry.name);
                                  return cellColor ? <Cell key={`cell-${idx}`} fill={cellColor} /> : null;
                                })}
                                <LabelList
                                  dataKey={seriesKey}
                                  content={(props) => {
                                    const { x, y, width, value } = props;
                                    if (value == null || value <= 0) return null;
                                    const numStr = Number(value).toLocaleString(modalCurrency === 'usd' ? 'en-US' : 'es-VE', {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2
                                    });
                                    const labelText = `${symbol}${numStr}`;
                                    const cx = x + width / 2;
                                    const cy = y - 9;
                                    const pillWidth = Math.max(42, labelText.length * 5.2 + 8);
                                    const pillHeight = 14;
                                    return (
                                      <g>
                                        <rect
                                          x={cx - pillWidth / 2}
                                          y={cy - pillHeight / 2}
                                          width={pillWidth}
                                          height={pillHeight}
                                          rx={3}
                                          fill="#ffffff"
                                          stroke="#e1e2ec"
                                          strokeWidth={1}
                                          opacity={0.95}
                                        />
                                        <text
                                          x={cx}
                                          y={cy + 0.5}
                                          fill="#040d53"
                                          textAnchor="middle"
                                          dominantBaseline="middle"
                                          fontSize="8.5px"
                                          fontWeight="800"
                                          fontFamily="monospace"
                                        >
                                          {labelText}
                                        </text>
                                      </g>
                                    );
                                  }}
                                />
                              </Bar>
                            );
                          })}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

      {/* Clear Product History Dialog */}
      <ConfirmModal
        isOpen={showClearConfirm}
        title="¿Borrar Historial del Producto?"
        message={`¿Estás seguro de que deseas eliminar TODOS los registros de precios históricos para "${activeProduct.nombre}"?\n\nEsta acción no afectará la información actual del producto ni de sus competidores, pero vaciará el gráfico de tendencias.`}
        confirmText={clearing ? 'Borrando...' : 'Borrar'}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleClearHistory}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>,
    document.body
  );
}
