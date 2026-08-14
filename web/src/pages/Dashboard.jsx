import { useEffect, useState, useMemo } from 'react';
import { collection, query, orderBy, limit, doc, getDoc, getDocs, writeBatch, deleteDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useBcvRate } from '../hooks/useBcvRate';
import ProductDetailModal from '../components/ProductDetailModal';
import BcvDetailModal from '../components/BcvDetailModal';
import ConfirmModal from '../components/ConfirmModal';
import GitHubConfigModal from '../components/GitHubConfigModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { executeLiveBatchScrape } from '../utils/liveScraper';
import { getGitHubConfig, triggerGitHubScraper } from '../utils/githubClient';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, Legend, ReferenceLine
} from 'recharts';

export default function Dashboard({ user, userDoc }) {
  const {
    productos,
    productosCompetencia,
    bcvRates: bcvHistorico,
    historicoPrecios,
    ultimaCorrida: globalUltimaCorrida,
    loadingInitial: loading,
    refreshData
  } = useData();

  const [localUltimaCorrida, setLocalUltimaCorrida] = useState(null);
  const ultimaCorrida = localUltimaCorrida || globalUltimaCorrida;

  const [currency, setCurrency] = useState(() => {
    try {
      return localStorage.getItem('trackflow_pref_currency') || 'usd';
    } catch {
      return 'usd';
    }
  });
  const [analisisMode, setAnalisisMode] = useState(() => {
    try {
      return localStorage.getItem('trackflow_pref_analisis_mode') || 'empaque';
    } catch {
      return 'empaque';
    }
  });
  const [search, setSearch] = useState('');
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState('Todas');
  const [tipoMercadoSeleccionado, setTipoMercadoSeleccionado] = useState('Todos');
  const [unSeleccionada, setUnSeleccionada] = useState('Todas');
  const [paginaActual, setPaginaActual] = useState(1);
  const [mostrarCambiosHoy, setMostrarCambiosHoy] = useState(false);
  const [ocultarSinPrecios, setOcultarSinPrecios] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [dashboardPriceMode, setDashboardPriceMode] = useState('lista');
  const [refreshing, setRefreshing] = useState(false);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [waitingForScraper, setWaitingForScraper] = useState(false);
  const [scraperTriggerTime, setScraperTriggerTime] = useState(null);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [showBcvModal, setShowBcvModal] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('trackflow_pref_currency', currency);
    } catch {}
  }, [currency]);

  useEffect(() => {
    try {
      localStorage.setItem('trackflow_pref_analisis_mode', analisisMode);
    } catch {}
  }, [analisisMode]);

  const bcv = useBcvRate();
  const { addToast } = useToast();
  const isAdmin = userDoc?.rol === 'administrador';

  // Calculated variation percentages for BCV card (day & month)
  const bcvVariations = useMemo(() => {
    if (!bcvHistorico || bcvHistorico.length === 0) {
      return { dailyPct: 0, monthlyPct: 0, latestVal: bcv?.rate || 0 };
    }
    const sorted = [...bcvHistorico].sort((a, b) => {
      const dA = a.rawDate ? new Date(a.rawDate) : new Date(0);
      const dB = b.rawDate ? new Date(b.rawDate) : new Date(0);
      return dA - dB;
    });

    const latestVal = bcv?.rate || (sorted.length > 0 ? sorted[sorted.length - 1].valor : 0);

    // Prev rate
    const prevRateObj = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
    const dailyPct = prevRateObj && prevRateObj.valor > 0 ? ((latestVal - prevRateObj.valor) / prevRateObj.valor) * 100 : 0;

    // Month ago rate (closest to 30 days ago)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthCandidates = sorted.filter(r => r.rawDate && new Date(r.rawDate) <= thirtyDaysAgo);
    const monthAgoObj = monthCandidates.length > 0 ? monthCandidates[monthCandidates.length - 1] : sorted[0];
    const monthlyPct = monthAgoObj && monthAgoObj.valor > 0 ? ((latestVal - monthAgoObj.valor) / monthAgoObj.valor) * 100 : 0;

    return { dailyPct, monthlyPct, latestVal };
  }, [bcvHistorico, bcv?.rate]);

  const cargarDatos = async (showSilently = false) => {
    await refreshData(showSilently);
  };

  // Listener en tiempo real para detectar cuándo termina el scraper
  useEffect(() => {
    if (!db) return;
    let unsubscribe = () => {};
    try {
      const q = query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1));
      unsubscribe = onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const docData = snapshot.docs[0].data();
          const runDate = docData.started_at?.toDate?.() || null;
          setLocalUltimaCorrida({ ...docData, started_at: runDate });
          
          if (waitingForScraper && runDate && scraperTriggerTime && runDate >= scraperTriggerTime) {
            setWaitingForScraper(false);
            setScraperTriggerTime(null);
            addToast(`¡Actualización completada! El robot ha terminado de extraer y analizar los últimos precios (${docData.ok} exitosos, ${docData.errores} errores).`, 'success');
            cargarDatos(true); // Recargar los datos silenciosamente para actualizar la tabla
          }
        }
      }, (err) => {
        console.warn('Aviso en onSnapshot de scrape_runs (modo sin conexión / permisos):', err?.message || String(err));
      });
    } catch (err) {
      console.warn('No se pudo suscribir a scrape_runs:', err?.message || String(err));
    }

    return () => {
      try {
        unsubscribe();
      } catch (_) {}
    };
  }, [waitingForScraper, scraperTriggerTime]);

  // Reset pagination when filters change
  useEffect(() => {
    setPaginaActual(1);
  }, [search, categoriaSeleccionada, mostrarCambiosHoy, tipoMercadoSeleccionado, unSeleccionada, ocultarSinPrecios]);

  const handleActualizar = async () => {
    if (!isAdmin) return;
    setRefreshing(true);
    try {
      const config = await getGitHubConfig();

      if (!config || !config.token || !config.repo_owner || !config.repo_name) {
        addToast('No hay configuración de GitHub Actions. Ingresa tus credenciales para conectar.', 'info');
        setShowGithubModal(true);
        setRefreshing(false);
        return;
      }

      await triggerGitHubScraper({ config });
      setWaitingForScraper(true);
      setScraperTriggerTime(new Date());
      addToast('¡Robot scraper iniciado con éxito vía GitHub Actions! Los precios se actualizarán automáticamente.', 'success');
    } catch (err) {
      if (err.message === 'CONFIG_MISSING') {
        setShowGithubModal(true);
      } else {
        addToast('Error en GitHub Actions: ' + err.message, 'error');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleClearAllHistory = async () => {
    setClearingHistory(true);
    try {
      const q = query(collection(db, 'historico_precios'));
      const snap = await getDocs(q);
      const docs = snap.docs;
      
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // Clear execution runs logs too
      const runsQ = query(collection(db, 'scrape_runs'));
      const runsSnap = await getDocs(runsQ);
      const runsDocs = runsSnap.docs;
      for (let i = 0; i < runsDocs.length; i += 500) {
        const chunk = runsDocs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      setLocalUltimaCorrida(null);
      addToast('Historial de precios y análisis de scraper vaciados con éxito.', 'success');
      await cargarDatos();
    } catch (err) {
      console.error('Error al borrar historial:', err?.message || String(err));
      addToast('Error al borrar historial: ' + err.message, 'error');
    }
    setClearingHistory(false);
    setShowClearHistoryConfirm(false);
  };

  // Unique categories for filtering
  const categorias = useMemo(() => {
    const list = new Set(productos.map(p => p.categoria).filter(Boolean));
    return ['Todas', ...Array.from(list)];
  }, [productos]);

  // Helper to normalize the history grouping key
  const getHistoryKey = (id_producto, cadena, marca) => {
    return `${id_producto}_${cadena}_${marca}`.toLowerCase().replace(/[\s/\\]+/g, '_');
  };

  // Main calculations for products and competitors
  const analizados = useMemo(() => {
    // Group history by normalized key
    const historyGrouped = {};
    historicoPrecios.forEach(h => {
      if (!h.id_producto_propio || !h.cadena || !h.marca) return;
      const k = getHistoryKey(h.id_producto_propio, h.cadena, h.marca);
      if (!historyGrouped[k]) {
        historyGrouped[k] = [];
      }
      historyGrouped[k].push(h);
    });

    return productos
      .filter(p => p.activo)
      .map(p => {
        const compItems = productosCompetencia.filter(pc => pc.id_producto_propio === p.id_interno && pc.activo);
        
        const pUnidosisCount = parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis || p.unidades_empaque);
        const pUnitFactor = analisisMode === 'unidosis' ? Math.max(pUnidosisCount, 1) : 1;

        // Find competitor prices (converted to USD using current rate for standard comparison)
        const chainPrices = compItems.map(c => {
          const rawPriceBs = dashboardPriceMode === 'descuento'
            ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs)
            : c.ultimo_precio_full_bs;
          if (!rawPriceBs || !bcv.rate) return null;

          const cUnidosisCount = parseUnidosisCount(c.tamano, c.marca, c.unidosis || c.unidades_empaque) || pUnidosisCount;
          const cUnitFactor = analisisMode === 'unidosis' ? Math.max(cUnidosisCount, 1) : 1;

          const priceBs = rawPriceBs / cUnitFactor;

          // Calculate history trend for this competitor
          const k = getHistoryKey(p.id_interno, c.cadena, c.marca);
          const hList = historyGrouped[k] || [];
          const currentHist = hList[0];
          const previousHist = hList.find(x => x.run_id !== currentHist?.run_id);
          
          const currentVal = currentHist ? (dashboardPriceMode === 'descuento' ? (currentHist.precio_desc_bs || currentHist.precio_full_bs) : currentHist.precio_full_bs) : null;
          const prevVal = previousHist ? (dashboardPriceMode === 'descuento' ? (previousHist.precio_desc_bs || previousHist.precio_full_bs) : previousHist.precio_full_bs) : null;
          
          const valNow = currentVal !== null ? currentVal / cUnitFactor : priceBs;
          const valPrevAdjusted = prevVal !== null ? prevVal / cUnitFactor : null;
          let changePercent = 0;
          if (valNow && valPrevAdjusted && valPrevAdjusted > 0) {
            changePercent = ((valNow - valPrevAdjusted) / valPrevAdjusted) * 100;
          }

          return {
            id: c.id,
            tipo: c.tipo,
            cadena: c.cadena,
            priceUsd: priceBs / bcv.rate,
            priceBs: priceBs,
            marca: c.marca,
            url: c.url,
            unidosisCount: cUnidosisCount,
            changePercent,
            valPrev: valPrevAdjusted,
          };
        }).filter(v => v !== null && v.priceUsd > 0);

        // Check if there are any price changes in the latest run
        const hasChangesToday = chainPrices.some(cp => Math.abs(cp.changePercent) > 0.05);

        const allPricesUsd = chainPrices.map(x => x.priceUsd);

        const avgCompUsd = allPricesUsd.length > 0 
          ? allPricesUsd.reduce((a, b) => a + b, 0) / allPricesUsd.length 
          : null;

        const minCompUsd = allPricesUsd.length > 0 ? Math.min(...allPricesUsd) : null;
        const maxCompUsd = allPricesUsd.length > 0 ? Math.max(...allPricesUsd) : null;

        // Dispersion percent calculation
        const dispersionPercent = (minCompUsd && maxCompUsd && minCompUsd > 0)
          ? ((maxCompUsd - minCompUsd) / minCompUsd) * 100
          : 0;

        // Find cheapest chain(s) for this product
        const cheapestChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - minCompUsd) < 0.001)
          .map(x => x.cadena);

        // Find most expensive chain(s) for this product
        const mostExpensiveChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - maxCompUsd) < 0.001)
          .map(x => x.cadena);

        // Find own price (most economical one among all own listings)
        const propioOptions = chainPrices.filter(x => x.tipo === 'propio');
        const propioPriceUsd = propioOptions.length > 0 
          ? Math.min(...propioOptions.map(x => x.priceUsd)) 
          : null;

        // Difference vs cheapest (minCompUsd)
        const diffMinUsd = (propioPriceUsd !== null && minCompUsd !== null) ? propioPriceUsd - minCompUsd : null;
        const diffMinPercent = (diffMinUsd !== null && minCompUsd > 0) ? (diffMinUsd / minCompUsd) * 100 : null;

        // Difference vs average (avgCompUsd)
        const diffAvgUsd = (propioPriceUsd !== null && avgCompUsd !== null) ? propioPriceUsd - avgCompUsd : null;
        const diffAvgPercent = (diffAvgUsd !== null && avgCompUsd > 0) ? (diffAvgUsd / avgCompUsd) * 100 : null;

        // Calculate dynamic ranking of our brand among all available options
        const sortedOptions = [...chainPrices].sort((a, b) => a.priceUsd - b.priceUsd);
        const totalOptionsCount = sortedOptions.length;
        const ownOptionIndex = sortedOptions.findIndex(x => x.tipo === 'propio');
        const ranking = ownOptionIndex !== -1 ? ownOptionIndex + 1 : null;

        return {
          producto: p,
          competencia: compItems,
          chainPrices,
          avgCompUsd,
          minCompUsd,
          maxCompUsd,
          dispersionPercent,
          cheapestChains,
          mostExpensiveChains,
          propioPriceUsd,
          diffMinUsd,
          diffMinPercent,
          diffAvgUsd,
          diffAvgPercent,
          hasChangesToday,
          ranking,
          totalOptionsCount,
          pUnidosisCount,
        };
      });
  }, [productos, productosCompetencia, bcv.rate, dashboardPriceMode, historicoPrecios, analisisMode]);

  // Count products with no price in any chain
  const sinPreciosCount = useMemo(() => {
    return analizados.filter(item => (!item.chainPrices || item.chainPrices.length === 0) && !item.propioPriceUsd).length;
  }, [analizados]);

  // Filtered rows
  const filas = useMemo(() => {
    const term = search.toLowerCase().trim();
    const filtered = analizados.filter(item => {
      const matchSearch = !term || 
        item.producto.nombre.toLowerCase().includes(term) ||
        (item.producto.principio_activo || '').toLowerCase().includes(term) ||
        item.producto.id_interno.toLowerCase().includes(term);
      
      const matchCat = categoriaSeleccionada === 'Todas' || item.producto.categoria === categoriaSeleccionada;
      const matchChanges = !mostrarCambiosHoy || item.hasChangesToday;
      
      const pTipo = (item.producto.market_type || 'GENERICO').toUpperCase();
      const matchTipo = tipoMercadoSeleccionado === 'Todos' || pTipo === tipoMercadoSeleccionado.toUpperCase();

      const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
      const matchUn = unSeleccionada === 'Todas' || pUn === unSeleccionada.toUpperCase();

      const hasAnyPrice = (item.chainPrices && item.chainPrices.length > 0) || Boolean(item.propioPriceUsd);
      const matchSinPrecios = !ocultarSinPrecios || hasAnyPrice;

      return matchSearch && matchCat && matchChanges && matchTipo && matchUn && matchSinPrecios;
    });

    // Multi-criteria sorting:
    // 1. Producto (Alphabetical)
    // 2. Unidad de Negocio (Alphabetical)
    return filtered.sort((a, b) => {
      const nameA = a.producto.nombre || '';
      const nameB = b.producto.nombre || '';
      const nameComp = nameA.localeCompare(nameB, 'es', { sensitivity: 'base' });
      if (nameComp !== 0) {
        return nameComp;
      }
      const unA = a.producto.unidad_negocio || '';
      const unB = b.producto.unidad_negocio || '';
      return unA.localeCompare(unB, 'es', { sensitivity: 'base' });
    });
  }, [analizados, search, categoriaSeleccionada, mostrarCambiosHoy, tipoMercadoSeleccionado, unSeleccionada, ocultarSinPrecios]);

  const itemsPorPagina = 10;
  const totalPaginas = Math.ceil(filas.length / itemsPorPagina);
  const filasPaginadas = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filas.slice(inicio, inicio + itemsPorPagina);
  }, [filas, paginaActual]);

  // All active chains represented
  const cadenasUnicas = useMemo(() => {
    const set = new Set(productosCompetencia.map(pc => pc.cadena));
    return Array.from(set).sort();
  }, [productosCompetencia]);

  // Group by active ingredient to compare Generic vs Brand of the same molecule
  const analisisMoleculaParidad = useMemo(() => {
    // Group active analyzed products by active ingredient + presentation
    const grouped = {};
    filas.forEach(item => {
      const principio = (item.producto.principio_activo || '').trim().toLowerCase();
      if (!principio) return;
      
      const concentracion = (item.producto.concentracion || '').trim().toLowerCase();
      const tamano = (item.producto.tamano || '').trim().toLowerCase();
      const key = `${principio} | ${concentracion} | ${tamano}`;
      
      if (!grouped[key]) {
        grouped[key] = {
          principio_activo: item.producto.principio_activo,
          concentracion: item.producto.concentracion,
          tamano: item.producto.tamano,
          genericos: [],
          marcas: []
        };
      }
      
      const pTipo = (item.producto.market_type || 'GENERICO').toUpperCase();
      if (pTipo === 'MARCA') {
        grouped[key].marcas.push(item);
      } else {
        grouped[key].genericos.push(item);
      }
    });

    const comparacionesValidas = [];
    Object.entries(grouped).forEach(([key, g]) => {
      if (g.genericos.length > 0 && g.marcas.length > 0) {
        const miGenerico = g.genericos.find(x => x.propioPriceUsd !== null);
        const miMarca = g.marcas.find(x => x.propioPriceUsd !== null);
        
        const precioPropioGen = miGenerico ? miGenerico.propioPriceUsd : null;
        const precioPropioMarca = miMarca ? miMarca.propioPriceUsd : null;

        // Gap calculation: How much more expensive is my Brand than my Generic?
        let gapPercent = null;
        if (precioPropioGen && precioPropioMarca && precioPropioGen > 0) {
          gapPercent = ((precioPropioMarca - precioPropioGen) / precioPropioGen) * 100;
        }

        // Market average calculation
        const avgGenTotal = g.genericos.map(x => x.propioPriceUsd || x.avgCompUsd).filter(v => v !== null);
        const avgMarcaTotal = g.marcas.map(x => x.propioPriceUsd || x.avgCompUsd).filter(v => v !== null);
        const totalAvgGen = avgGenTotal.length > 0 ? avgGenTotal.reduce((a,b)=>a+b, 0) / avgGenTotal.length : null;
        const totalAvgMarca = avgMarcaTotal.length > 0 ? avgMarcaTotal.reduce((a,b)=>a+b, 0) / avgMarcaTotal.length : null;
        
        let marketGapPercent = null;
        if (totalAvgGen && totalAvgMarca && totalAvgGen > 0) {
          marketGapPercent = ((totalAvgMarca - totalAvgGen) / totalAvgGen) * 100;
        }

        // Diagnostics
        let diagnostico = '';
        let nivelSeveridad = 'normal'; // 'normal', 'alerta', 'critico', 'oportunidad'
        
        if (precioPropioGen && precioPropioMarca) {
          if (gapPercent < 0) {
            diagnostico = 'Inversión de Precio Crítica: Tu genérico cuesta más que tu marca propia.';
            nivelSeveridad = 'critico';
          } else if (gapPercent < 15) {
            diagnostico = 'Riesgo de Canibalización: Brecha < 15%. Genérico demasiado caro o marca muy barata.';
            nivelSeveridad = 'alerta';
          } else if (gapPercent > 70) {
            diagnostico = 'Oportunidad de Margen: Brecha > 70%. Tu genérico tiene margen de subida sin afectar liderazgo.';
            nivelSeveridad = 'oportunidad';
          } else {
            diagnostico = `Alineación Óptima: Brecha saludable del ${gapPercent.toFixed(0)}% entre marca y genérico.`;
            nivelSeveridad = 'normal';
          }
        } else if (precioPropioGen && !precioPropioMarca) {
          diagnostico = 'Solo tienes precio para el Genérico. Monitoreando paridad contra competidores.';
          nivelSeveridad = 'normal';
        } else if (!precioPropioGen && precioPropioMarca) {
          diagnostico = 'Solo tienes precio para la Marca. Monitoreando paridad contra competidores.';
          nivelSeveridad = 'normal';
        }

        comparacionesValidas.push({
          key,
          principio: g.principio_activo,
          concentracion: g.concentracion,
          tamano: g.tamano,
          miGenerico,
          miMarca,
          precioPropioGen,
          precioPropioMarca,
          gapPercent,
          marketGapPercent,
          diagnostico,
          nivelSeveridad,
          totalAvgGen,
          totalAvgMarca
        });
      }
    });

    return comparacionesValidas;
  }, [filas]);

  // Aggregate leadership chart data: how many times each chain is cheapest
  const chartChainLeadershipData = useMemo(() => {
    const counts = {};
    cadenasUnicas.forEach(c => { counts[c] = 0; });

    filas.forEach(item => {
      if (item.minCompUsd && item.cheapestChains.length > 0) {
        item.cheapestChains.forEach(ch => {
          if (counts[ch] !== undefined) {
            counts[ch]++;
          }
        });
      }
    });

    const colors = ['#016874', '#4f378a', '#7c0090', '#30312f', '#B3261E'];
    return Object.keys(counts).map((key, index) => ({
      name: key,
      liderazgos: counts[key],
      fill: colors[index % colors.length]
    }));
  }, [filas, cadenasUnicas]);

  // High volatility/dispersion alerts: dispersion > 20%
  const altaVolatilidad = useMemo(() => {
    return filas.filter(item => item.dispersionPercent > 20).sort((a,b) => b.dispersionPercent - a.dispersionPercent);
  }, [filas]);

  // Stats for cards
  const kpiStats = useMemo(() => {
    let totalDispersion = 0;
    let productsWithDispersion = 0;
    let maxDispersionVal = 0;
    let maxDispersionProd = '—';
    let maxDispersionItem = null;

    filas.forEach(item => {
      if (item.dispersionPercent > 0) {
        totalDispersion += item.dispersionPercent;
        productsWithDispersion++;
        if (item.dispersionPercent > maxDispersionVal) {
          maxDispersionVal = item.dispersionPercent;
          maxDispersionProd = item.producto.nombre;
          maxDispersionItem = item;
        }
      }
    });

    // Find overall leader (chain with highest cheap count)
    let bestChain = '—';
    let maxCheapCount = 0;
    const chainLeadershipMap = {};
    cadenasUnicas.forEach(c => { chainLeadershipMap[c] = 0; });

    filas.forEach(item => {
      if (item.minCompUsd) {
        item.cheapestChains.forEach(ch => {
          if (chainLeadershipMap[ch] !== undefined) chainLeadershipMap[ch]++;
        });
      }
    });

    Object.keys(chainLeadershipMap).forEach(k => {
      if (chainLeadershipMap[k] > maxCheapCount) {
        maxCheapCount = chainLeadershipMap[k];
        bestChain = k;
      }
    });

    // Own Brand leadership: how many times is our brand (tipo === 'propio') the cheapest or below market average?
    let ownBrandTotal = 0;
    let ownBrandLider = 0;
    let totalDiffVsMin = 0;
    let diffVsMinCount = 0;
    filas.forEach(item => {
      const propio = item.competencia.find(c => c.tipo === 'propio');
      if (propio) {
        const propioPrice = propio.ultimo_precio_desc_bs || propio.ultimo_precio_full_bs;
        if (propioPrice) {
          ownBrandTotal++;
          const alts = item.competencia.filter(c => c.tipo === 'alternativa');
          const pricesAlt = alts.map(a => a.ultimo_precio_desc_bs || a.ultimo_precio_full_bs).filter(Boolean);
          if (pricesAlt.length > 0) {
            const minAlt = Math.min(...pricesAlt);
            if (propioPrice <= minAlt) {
              ownBrandLider++;
            }
            // Difference percentage of own price versus the minimum alternative
            const diffPct = ((propioPrice - minAlt) / minAlt) * 100;
            totalDiffVsMin += diffPct;
            diffVsMinCount++;
          } else {
            // No alternatives, we are the only ones
            ownBrandLider++;
          }
        }
      }
    });

    const porcentajeLiderazgoPropio = ownBrandTotal > 0 ? Math.round((ownBrandLider / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMin = diffVsMinCount > 0 ? (totalDiffVsMin / diffVsMinCount) : 0;

    // Arbitrage Opportunity detection (> 15% dispersion)
    let arbitrajeInfo = null;
    if (maxDispersionItem && maxDispersionVal > 15) {
      const minPrice = maxDispersionItem.minCompUsd;
      const maxPrice = maxDispersionItem.maxCompUsd;
      const chMin = maxDispersionItem.cheapestChains.join(' / ');
      const chMax = maxDispersionItem.mostExpensiveChains.join(' / ');
      const ahorroPct = ((maxPrice - minPrice) / maxPrice) * 100;

      arbitrajeInfo = {
        producto: maxDispersionItem.producto.nombre,
        ahorroPct: Math.round(ahorroPct),
        chMin,
        chMax,
        minVal: minPrice,
        maxVal: maxPrice,
      };
    }

    // Global Relative Price Index (IPR)
    let totalIpr = 0;
    let iprCount = 0;
    let totalChangesToday = 0;

    filas.forEach(item => {
      if (item.propioPriceUsd && item.avgCompUsd) {
        totalIpr += (item.propioPriceUsd / item.avgCompUsd) * 100;
        iprCount++;
      }
      if (item.hasChangesToday) {
        totalChangesToday++;
      }
    });

    const globalIpr = iprCount > 0 ? totalIpr / iprCount : null;

    return {
      monitoredCount: filas.length,
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      maxDispersionVal,
      maxDispersionProd,
      bestChain: maxCheapCount > 0 ? `${bestChain} (${maxCheapCount} prods)` : '—',
      porcentajeLiderazgoPropio,
      brechaPromedioVsMin,
      arbitrajeInfo,
      globalIpr,
      totalChangesToday,
    };
  }, [filas, cadenasUnicas, productosCompetencia]);

  // Price gap bar chart data: deviation % vs competitors
  const priceGapData = useMemo(() => {
    return filas
      .filter(item => item.propioPriceUsd !== null && item.avgCompUsd !== null && item.avgCompUsd > 0)
      .map(item => {
        const name = item.producto.nombre;
        const shortName = name.length > 20 ? name.substring(0, 18) + '...' : name;
        return {
          name: shortName,
          fullName: name,
          gap: parseFloat(item.diffAvgPercent.toFixed(1)),
          propioPrice: item.propioPriceUsd,
          avgComp: item.avgCompUsd,
        };
      })
      .sort((a, b) => a.gap - b.gap); // Sort from most competitive to least competitive
  }, [filas]);

  // Currency Formatter Helper
  const fmt = (priceUsd) => {
    if (priceUsd == null || isNaN(priceUsd)) return '—';
    if (currency === 'usd') {
      return `$${priceUsd.toFixed(2)}`;
    }
    if (!bcv.rate) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Custom tooltip for price gap bar chart
  const PriceGapTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const isCheaper = data.gap < 0;
      const gapAbs = Math.abs(data.gap).toFixed(1);
      
      return (
        <div className="bg-white/95 p-3.5 border border-outline-variant rounded-2xl shadow-lg backdrop-blur-sm max-w-xs font-sans">
          <p className="text-xs font-bold text-on-surface mb-1.5">{data.fullName}</p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-6 text-on-surface-variant">
              <span>Nuestro Precio:</span>
              <span className="font-semibold text-on-surface">{fmt(data.propioPrice)}</span>
            </div>
            <div className="flex justify-between gap-6 text-on-surface-variant">
              <span>Promedio Competencia:</span>
              <span className="font-semibold text-on-surface">{fmt(data.avgComp)}</span>
            </div>
            <div className="pt-1.5 border-t border-outline/10 flex justify-between gap-6 items-center">
              <span>Desviación:</span>
              <span className={`font-bold px-1.5 py-0.5 rounded-full text-[11px] ${isCheaper ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {isCheaper ? `-${gapAbs}%` : `+${gapAbs}%`}
              </span>
            </div>
          </div>
          <p className={`text-[10px] mt-2 font-medium ${isCheaper ? 'text-emerald-600' : 'text-red-600'}`}>
            {isCheaper 
              ? `Estás un ${gapAbs}% más barato que el promedio.` 
              : `Estás un ${gapAbs}% más caro que el promedio.`}
          </p>
        </div>
      );
    }
    return null;
  };

  const getPriceForCell = (chainPrices, cadena) => {
    const matches = chainPrices.filter(c => c.cadena === cadena);
    if (matches.length === 0) return null;
    const prices = matches.map(m => m.priceUsd);
    return Math.min(...prices);
  };

  // CSV intelligence report generation
  const downloadReport = () => {
    // Add BOM for Excel UTF-8 compatibility
    let csv = '\ufeff';
    csv += 'ID Interno,Producto Propio,Categoría,Laboratorio Propio,Mi Precio Lista (Bs),Mi Precio Descuento (Bs),Mi Precio Lista (USD),Mi Precio Descuento (USD),Cadena Enlace,Tipo Enlace,Nombre Enlace,Laboratorio Enlace,Precio Lista Enlace (Bs),Precio Lista Enlace (USD),Precio Descuento Enlace (Bs),Precio Descuento Enlace (USD),Diferencia vs Mi Precio (%),URL Enlace\n';
    
    filas.forEach(item => {
      const p = item.producto;
      const comp = item.competencia || [];
      
      // Get own product details
      const propioItem = comp.find(c => c.tipo === 'propio');
      const miPrecioListaBs = propioItem ? (propioItem.ultimo_precio_full_bs || null) : null;
      const miPrecioDescBs = propioItem ? (propioItem.ultimo_precio_desc_bs || null) : null;
      
      const rate = bcv.rate || 1;
      const miPrecioListaUsd = miPrecioListaBs ? miPrecioListaBs / rate : null;
      const miPrecioDescUsd = miPrecioDescBs ? miPrecioDescBs / rate : null;

      if (comp.length === 0) {
        // If there are no competitors or links at all
        const row = [
          p.id_interno,
          p.nombre,
          p.categoria,
          p.laboratorio || '—',
          miPrecioListaBs !== null ? miPrecioListaBs.toFixed(2) : '—',
          miPrecioDescBs !== null ? miPrecioDescBs.toFixed(2) : '—',
          miPrecioListaUsd !== null ? miPrecioListaUsd.toFixed(2) : '—',
          miPrecioDescUsd !== null ? miPrecioDescUsd.toFixed(2) : '—',
          '—', // Cadena
          '—', // Tipo
          '—', // Nombre Enlace
          '—', // Lab Enlace
          '—', // Precio Lista Enlace Bs
          '—', // Precio Lista Enlace USD
          '—', // Precio Descuento Enlace Bs
          '—', // Precio Descuento Enlace USD
          '—', // Diferencia %
          '—'  // URL Enlace
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
        csv += row;
      } else {
        comp.forEach(pc => {
          const pcPrecioListaBs = pc.ultimo_precio_full_bs || null;
          const pcPrecioDescBs = pc.ultimo_precio_desc_bs || null;
          const pcPrecioListaUsd = pcPrecioListaBs && bcv.rate ? pcPrecioListaBs / bcv.rate : null;
          const pcPrecioDescUsd = pcPrecioDescBs && bcv.rate ? pcPrecioDescBs / bcv.rate : null;

          // Compare competitor price against own price
          const miCompPrecioBs = dashboardPriceMode === 'descuento' 
            ? (miPrecioDescBs || miPrecioListaBs) 
            : miPrecioListaBs;
            
          const pcCompPrecioBs = dashboardPriceMode === 'descuento'
            ? (pcPrecioDescBs || pcPrecioListaBs)
            : pcPrecioListaBs;

          let diffPercentStr = '—';
          if (miCompPrecioBs && pcCompPrecioBs && miCompPrecioBs > 0 && pc.tipo !== 'propio') {
            const diffPct = ((miCompPrecioBs - pcCompPrecioBs) / pcCompPrecioBs) * 100;
            diffPercentStr = `${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
          } else if (pc.tipo === 'propio') {
            diffPercentStr = 'Base (Propio)';
          }

          const row = [
            p.id_interno,
            p.nombre,
            p.categoria,
            p.laboratorio || '—',
            miPrecioListaBs !== null ? miPrecioListaBs.toFixed(2) : '—',
            miPrecioDescBs !== null ? miPrecioDescBs.toFixed(2) : '—',
            miPrecioListaUsd !== null ? miPrecioListaUsd.toFixed(2) : '—',
            miPrecioDescUsd !== null ? miPrecioDescUsd.toFixed(2) : '—',
            pc.cadena,
            pc.tipo === 'propio' ? 'Mi Marca' : 'Competidor',
            pc.marca,
            pc.laboratorio || '—',
            pcPrecioListaBs !== null ? pcPrecioListaBs.toFixed(2) : '—',
            pcPrecioListaUsd !== null ? pcPrecioListaUsd.toFixed(2) : '—',
            pcPrecioDescBs !== null ? pcPrecioDescBs.toFixed(2) : '—',
            pcPrecioDescUsd !== null ? pcPrecioDescUsd.toFixed(2) : '—',
            diffPercentStr,
            pc.url || '—'
          ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
          csv += row;
        });
      }
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Reporte_Detallado_Precios_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* HEADER PRINCIPAL */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">dashboard</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Panel de Inteligencia
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Análisis de volatilidad, liderazgo de precios por cadena farmacéutica y tasas de cambio oficial.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Mode Switcher: Empaque vs Unidosis */}
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
              title="Analizar precios normalizados por 1 unidad/tableta/dosis"
            >
              <span className="material-symbols-outlined text-[14px]">medication</span>
              <span>Por Unidosis</span>
            </button>
          </div>

          {/* Currency Switcher widget */}
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

          <button
            onClick={downloadReport}
            className="m3-btn-outline"
          >
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar CSV</span>
          </button>

          {isAdmin && (
            <button
              onClick={() => setShowClearHistoryConfirm(true)}
              className="touch-target px-4 py-2 bg-surface-low hover:bg-rose-50 text-rose-700 font-mono font-bold text-xs rounded-full border border-rose-200 transition-all flex items-center gap-1.5 shadow-xs"
            >
              <span className="material-symbols-outlined text-base">delete_sweep</span>
              <span>Borrar Historial</span>
            </button>
          )}
        </div>
      </div>

      {/* BCV and Status Control Bar */}
      <div className="neural-card p-5 flex flex-wrap items-center justify-between gap-4">
        <BcvController bcv={bcv} onOpenHistory={() => setShowBcvModal(true)} />
        
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-on-surface-variant font-sans font-semibold">Último Scraper:</span>
            {waitingForScraper ? (
              <span className="inline-flex items-center gap-1.5 font-mono bg-amber-500 text-white px-3 py-1 rounded-full font-bold animate-pulse">
                <span className="material-symbols-outlined text-xs animate-spin leading-none">sync</span>
                Robot Trabajando...
              </span>
            ) : ultimaCorrida ? (
              <>
                <span className="font-mono bg-primary text-on-primary px-3 py-1 rounded-full font-bold">
                  {ultimaCorrida.started_at ? formatTimeAgo(ultimaCorrida.started_at) : '—'}
                </span>
                <span className="text-on-surface-variant font-semibold hidden sm:inline">
                  ({ultimaCorrida.ok}/{ultimaCorrida.total} exitosos)
                </span>
              </>
            ) : (
              <span className="font-mono bg-surface-low text-on-surface-variant px-3 py-1 rounded-full font-bold border border-outline-variant/50">
                Sin ejecuciones previas
              </span>
            )}
          </div>

          <button
            onClick={handleActualizar}
            disabled={refreshing || waitingForScraper}
            className="m3-btn-primary"
            title="Iniciar robot extractor para actualizar precios de competidores"
          >
            <span className={`material-symbols-outlined text-base ${refreshing || waitingForScraper ? 'animate-spin' : ''}`}>
              {refreshing || waitingForScraper ? 'sync' : 'smart_toy'}
            </span>
            <span>{refreshing ? 'Iniciando...' : waitingForScraper ? 'Ejecutando Robot...' : 'Actualizar'}</span>
          </button>
        </div>
      </div>

      {/* KPI Cards Area */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <KpiCard label="Catálogo Monitoreado" value={kpiStats.monitoredCount} sub="Productos activos en análisis" icon="package" color="text-primary" />
        <KpiCard label="Líder de Precios" value={kpiStats.bestChain} sub="Cadena con precios más bajos" icon="emoji_events" color="text-secondary" />
      </div>



      {/* Visual Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Leadership Bar Chart */}
        <div className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider mb-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">bar_chart</span>
              Liderazgo de Precios
            </h2>
            <p className="text-[11px] text-on-surface-variant font-sans mb-4 leading-relaxed">
              Cantidad de productos donde cada cadena ofrece la opción más económica.
            </p>
          </div>
          <div className="h-60 mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart 
                key={`chain-lead-chart-${chartChainLeadershipData.map(d => d.liderazgos).join('-')}`}
                data={chartChainLeadershipData} 
                margin={{ top: 10, right: 10, left: -25, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#464650' }} />
                <YAxis tick={{ fontSize: 10, fill: '#464650' }} />
                <Tooltip formatter={(value) => [`${value} productos`, 'Líder en']} />
                <Bar 
                  dataKey="liderazgos"
                  isAnimationActive={true}
                  animationDuration={750}
                  animationBegin={0}
                  animationEasing="ease-out"
                  radius={[6, 6, 0, 0]}
                >
                  {chartChainLeadershipData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Historical BCV rate chart */}
        <div 
          onClick={() => setShowBcvModal(true)}
          className="bg-white rounded-3xl border border-outline-variant p-5 shadow-sm flex flex-col justify-between hover:border-primary/60 transition-all hover:shadow-md cursor-pointer group relative"
        >
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h2 className="text-xs font-bold text-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base group-hover:scale-110 transition-transform">show_chart</span>
                Evolución de Tasa Oficial BCV
              </h2>
              <button 
                onClick={(e) => { e.stopPropagation(); setShowBcvModal(true); }}
                className="text-[11px] font-bold font-mono text-primary hover:bg-primary/10 px-2.5 py-1 rounded-full flex items-center gap-1 transition-all"
                title="Ver historial completo y detalle"
              >
                <span>Ver Detalle</span>
                <span className="material-symbols-outlined text-xs">open_in_full</span>
              </button>
            </div>
            
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-[11px] text-on-surface-variant font-sans leading-relaxed">
                Evolución de los últimos 7 días de la tasa oficial del BCV.
              </p>

              {/* Indicadores de % de variación en Día y Mes */}
              <div className="flex items-center gap-1.5">
                {/* Badge Día */}
                <span 
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono border flex items-center gap-0.5 ${
                    bcvVariations.dailyPct > 0 
                      ? 'bg-amber-50 text-amber-800 border-amber-200' 
                      : bcvVariations.dailyPct < 0 
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
                      : 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                  title="Variación % con respecto al registro anterior"
                >
                  <span className="material-symbols-outlined text-xs">
                    {bcvVariations.dailyPct > 0 ? 'trending_up' : bcvVariations.dailyPct < 0 ? 'trending_down' : 'trending_flat'}
                  </span>
                  Día: {bcvVariations.dailyPct >= 0 ? `+${bcvVariations.dailyPct.toFixed(2)}%` : `${bcvVariations.dailyPct.toFixed(2)}%`}
                </span>

                {/* Badge Mes */}
                <span 
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono border flex items-center gap-0.5 ${
                    bcvVariations.monthlyPct > 0 
                      ? 'bg-blue-50 text-blue-800 border-blue-200' 
                      : bcvVariations.monthlyPct < 0 
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
                      : 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                  title="Variación % con respecto a hace 30 días"
                >
                  <span className="material-symbols-outlined text-xs">
                    {bcvVariations.monthlyPct > 0 ? 'show_chart' : bcvVariations.monthlyPct < 0 ? 'trending_down' : 'trending_flat'}
                  </span>
                  Mes: {bcvVariations.monthlyPct >= 0 ? `+${bcvVariations.monthlyPct.toFixed(2)}%` : `${bcvVariations.monthlyPct.toFixed(2)}%`}
                </span>
              </div>
            </div>
          </div>

          <div className="h-60 mt-2">
            {bcvHistorico.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#464650] italic">No hay registros históricos de tasa cargados.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart 
                  key={`bcv-history-chart-${bcvHistorico.slice(-7).map(d => d.valor).join('-')}`}
                  data={bcvHistorico.slice(-7)} 
                  margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="colorBcv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#016874" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#016874" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f3f6" />
                  <XAxis dataKey="fecha" tick={{ fontSize: 10, fill: '#464650' }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: '#464650' }} />
                  <Tooltip formatter={(value) => [`Bs ${value.toFixed(2)}`, 'Tasa Oficial']} />
                  <Area 
                    type="monotone" 
                    dataKey="valor" 
                    stroke="#016874" 
                    strokeWidth={2} 
                    fillOpacity={1} 
                    fill="url(#colorBcv)" 
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
      </div>

      {/* Versión 1.2: Gráfico "Análisis de Paridad de Escala Farmacéutica" ocultado temporalmente por solicitud del usuario. Descomentar para Reactivar.
      {analisisMoleculaParidad.length > 0 && (
        <div className="bg-white rounded-3xl border border-outline-variant p-6 shadow-sm space-y-4">
          <div>
            <h2 className="font-display font-extrabold text-lg text-primary flex items-center gap-2">
              <span className="material-symbols-outlined text-xl text-primary">balance</span>
              Análisis de Paridad de Escala Farmacéutica (Genérico vs. Marca)
            </h2>
            <p className="text-xs text-on-surface-variant font-sans mt-0.5">
              Optimización estratégica de portafolio: Verifica la consistencia de precios entre tus opciones Genéricas y de Marca para la misma molécula y presentación.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {analisisMoleculaParidad.map(item => {
              const badgeColors = {
                critico: 'bg-red-50 text-red-700 border-red-200',
                alerta: 'bg-amber-50 text-amber-700 border-amber-200',
                oportunidad: 'bg-purple-50 text-purple-700 border-purple-200',
                normal: 'bg-emerald-50 text-emerald-700 border-emerald-200'
              };
              const severityBadge = badgeColors[item.nivelSeveridad] || badgeColors.normal;

              return (
                <div key={item.key} className="p-4 rounded-2xl border border-outline-variant/60 bg-surface-low/30 hover:bg-surface-low/60 transition-all flex flex-col justify-between space-y-3">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <h3 className="font-display font-bold text-sm text-primary uppercase tracking-wide leading-tight">
                        {item.principio}
                      </h3>
                      <p className="text-xs text-on-surface-variant font-mono mt-0.5">
                        {item.concentracion} · {item.tamano}
                      </p>
                    </div>
                    {item.gapPercent !== null && (
                      <div className="text-right">
                        <span className="text-xs text-on-surface-variant block font-sans font-medium">Brecha de Marca</span>
                        <span className="font-mono text-base font-extrabold text-primary">
                          +{item.gapPercent.toFixed(0)}%
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-outline-variant/40 text-xs">
                    <div>
                      <span className="text-on-surface-variant font-sans block mb-1">Tus Precios</span>
                      <div className="space-y-0.5 font-mono">
                        <div className="flex justify-between text-on-surface">
                          <span>Genérico:</span>
                          <span className="font-bold">{fmt(item.precioPropioGen)}</span>
                        </div>
                        <div className="flex justify-between text-on-surface">
                          <span>Marca:</span>
                          <span className="font-bold">{fmt(item.precioPropioMarca)}</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <span className="text-on-surface-variant font-sans block mb-1">Referencia Mercado</span>
                      <div className="space-y-0.5 font-mono">
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Genérico:</span>
                          <span className="font-semibold">{fmt(item.totalAvgGen)}</span>
                        </div>
                        <div className="flex justify-between text-on-surface-variant">
                          <span>Marca:</span>
                          <span className="font-semibold">{fmt(item.totalAvgMarca)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={`p-2.5 rounded-xl border text-[11px] font-sans leading-relaxed flex items-start gap-2 ${severityBadge}`}>
                    <span className="material-symbols-outlined text-base select-none mt-0.5">
                      {item.nivelSeveridad === 'critico' ? 'dangerous' : item.nivelSeveridad === 'alerta' ? 'warning' : item.nivelSeveridad === 'oportunidad' ? 'rocket_launch' : 'verified_user'}
                    </span>
                    <span>{item.diagnostico}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )} */}

      {/* Heatmap Matrix Section */}
      <div className="neural-card overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-variant flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display font-extrabold text-lg text-on-background">Matriz Comparativa & Heatmap de Precios</h2>
            <p className="text-xs text-on-surface-variant font-sans">Identifica el precio de menor costo resaltado en color verde.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Price Mode Toggle */}
            <div className="m3-segmented">
              <button
                onClick={() => setDashboardPriceMode('descuento')}
                className={`m3-segmented-item ${dashboardPriceMode === 'descuento' ? 'active' : ''}`}
              >
                <span className="material-symbols-outlined text-[14px]">sell</span>
                <span>Con Descuento</span>
              </button>
              <button
                onClick={() => setDashboardPriceMode('lista')}
                className={`m3-segmented-item ${dashboardPriceMode === 'lista' ? 'active' : ''}`}
              >
                <span className="material-symbols-outlined text-[14px]">receipt_long</span>
                <span>Precio Lista</span>
              </button>
            </div>

            {/* Quick Audit: What changed today? */}
            <button
              onClick={() => setMostrarCambiosHoy(!mostrarCambiosHoy)}
              className={`h-9 px-3.5 rounded-full text-xs font-bold transition-all inline-flex items-center gap-2 border active:scale-98 select-none ${
                mostrarCambiosHoy 
                  ? 'bg-amber-600 border-amber-600 text-white font-extrabold shadow-xs' 
                  : 'bg-surface-container-lowest border-outline-variant text-on-surface hover:bg-surface-container-high hover:border-amber-500/50'
              }`}
            >
              <span className={`material-symbols-outlined text-[16px] leading-none ${mostrarCambiosHoy ? 'text-white' : 'text-amber-600'}`}>
                notifications_active
              </span>
              <span className="font-medium whitespace-nowrap">¿Qué cambió hoy?</span>
              {kpiStats.totalChangesToday > 0 && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-extrabold tracking-tight ${
                  mostrarCambiosHoy 
                    ? 'bg-white text-amber-800 shadow-xs' 
                    : 'bg-amber-100 text-amber-900 border border-amber-300'
                }`}>
                  {kpiStats.totalChangesToday}
                </span>
              )}
            </button>

            {/* Filter: Ocultar productos sin precio */}
            <button
              onClick={() => setOcultarSinPrecios(!ocultarSinPrecios)}
              className={`h-9 px-3.5 rounded-full text-xs font-bold transition-all inline-flex items-center gap-2 border active:scale-98 select-none ${
                ocultarSinPrecios 
                  ? 'bg-primary border-primary text-on-primary font-extrabold shadow-xs' 
                  : 'bg-surface-container-lowest border-outline-variant text-on-surface hover:bg-surface-container-high hover:border-primary/50'
              }`}
              title="Quitar de la matriz los productos que no tienen ningún precio en ninguna cadena"
            >
              <span className={`material-symbols-outlined text-[16px] leading-none ${ocultarSinPrecios ? 'text-on-primary' : 'text-primary'}`}>
                {ocultarSinPrecios ? 'visibility_off' : 'filter_alt'}
              </span>
              <span className="font-medium whitespace-nowrap">Ocultar sin precio</span>
              {sinPreciosCount > 0 && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-extrabold tracking-tight ${
                  ocultarSinPrecios 
                    ? 'bg-white text-primary shadow-xs' 
                    : 'bg-primary-container text-on-primary-container border border-primary/20'
                }`}>
                  {sinPreciosCount}
                </span>
              )}
            </button>

            {/* Market Type Selector */}
            <div className="m3-segmented">
              {['Todos', 'GENERICO', 'MARCA'].map(t => (
                <button
                  key={t}
                  onClick={() => setTipoMercadoSeleccionado(t)}
                  className={`m3-segmented-item ${tipoMercadoSeleccionado === t ? 'active' : ''}`}
                >
                  {t === 'Todos' ? 'Todos Tipo' : t === 'GENERICO' ? 'Genéricos' : 'Marca'}
                </button>
              ))}
            </div>

            {/* Business Unit Selector */}
            <div className="m3-segmented">
              {['Todas', 'La Sante', 'Pharmetique', 'OTC'].map(un => (
                <button
                  key={un}
                  onClick={() => setUnSeleccionada(un)}
                  className={`m3-segmented-item ${unSeleccionada === un ? 'active' : ''}`}
                >
                  {un === 'Todas' ? 'Todas UN' : un === 'La Sante' ? 'La Santé' : un}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Search & Categories Bar */}
        <div className="px-5 py-3 bg-surface-low/50 border-b border-surface-variant flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px] pointer-events-none select-none">search</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar producto en la matriz..."
              className="m3-input m3-input-search pr-8 h-9 text-xs"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-container-high">×</button>
            )}
          </div>

          {/* Categorías */}
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="text-[11px] font-mono font-bold text-on-surface-variant uppercase mr-1">Categoría:</span>
            {categorias.map(cat => (
              <button key={cat} onClick={() => setCategoriaSeleccionada(cat)}
                className={`px-3 py-1 text-xs rounded-full border transition-all ${
                  categoriaSeleccionada === cat 
                    ? 'bg-primary border-primary text-on-primary font-bold shadow-xs' 
                    : 'bg-white border-outline-variant/60 text-on-background hover:bg-surface-variant'
                }`}>
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Heatmap Grid Table */}
        <div className="overflow-x-auto max-h-[750px] relative">
          <table className="m3-table">
            <thead className="m3-sticky-header">
              <tr>
                <th className="rounded-tl-2xl">Producto</th>
                {cadenasUnicas.map(c => (
                  <th key={c} className="text-right">{c}</th>
                ))}
                <th className="text-right border-l border-outline-variant/30">Promedio</th>
                <th className="text-right">Mínimo</th>
                <th className="text-right bg-secondary-container/30 text-secondary font-bold border-l border-secondary/20">Mi Precio</th>
                <th className="text-right text-secondary">Mi Desviación</th>
                <th className="text-center rounded-tr-2xl">Dispersión (%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-variant">
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={5 + cadenasUnicas.length} className="px-6 py-12 text-center text-on-surface-variant">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant">
                        <span className="material-symbols-outlined text-2xl">search_off</span>
                      </div>
                      <div>
                        <div className="font-bold text-on-surface font-display text-base">No hay productos en esta selección</div>
                        <div className="text-xs text-on-surface-variant mt-0.5">Prueba ajustando los filtros de categoría, tipo de mercado o búsqueda.</div>
                      </div>
                      {(search || categoriaSeleccionada !== 'Todas' || tipoMercadoSeleccionado !== 'Todos' || unSeleccionada !== 'Todas') && (
                        <button
                          onClick={() => {
                            setSearch('');
                            setCategoriaSeleccionada('Todas');
                            setTipoMercadoSeleccionado('Todos');
                            setUnSeleccionada('Todas');
                          }}
                          className="m3-btn-outline h-8 px-4 text-xs mt-1"
                        >
                          Limpiar todos los filtros
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filasPaginadas.map(({ producto, competencia, chainPrices, avgCompUsd, minCompUsd, maxCompUsd, dispersionPercent, cheapestChains, propioPriceUsd, diffMinPercent, diffAvgPercent, ranking, totalOptionsCount }) => {
                  return (
                    <tr key={producto.id_interno} onClick={() => setSelectedProduct({ producto, competencia })}
                       className="hover:bg-surface-low cursor-pointer transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-bold text-on-surface font-display text-sm">{producto.nombre}</span>
                          <span className={`px-1.5 py-0.5 text-[8px] rounded font-mono font-bold tracking-wider ${
                            (producto.market_type || 'GENERICO').toUpperCase() === 'MARCA'
                              ? 'bg-purple-100 text-purple-800 border border-purple-200'
                              : 'bg-green-100 text-green-800 border border-green-200'
                          }`}>
                            {(producto.market_type || 'GENERICO').toUpperCase()}
                          </span>
                          {ranking && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold font-mono bg-[#e8f0fe] text-[#1a73e8] border border-[#d2e3fc]" title={`Posición de nuestra marca entre todas las opciones del mercado (1° es la más económica)`}>
                              Rank: {ranking}°/{totalOptionsCount}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-on-surface-variant font-mono mt-0.5">{producto.id_interno} · {producto.laboratorio}</div>
                      </td>

                      {/* Heatmap Cells */}
                      {cadenasUnicas.map(cadena => {
                        const cellPrice = getPriceForCell(chainPrices, cadena);
                        if (!cellPrice) {
                          return <td key={cadena} className="px-6 py-4 text-right text-gray-300 font-mono select-none">—</td>;
                        }

                        // Check if this chain is the cheapest for this product
                        const isCheapest = cheapestChains.includes(cadena);
                        let cellBg = 'bg-white';
                        let cellText = 'text-on-surface';

                        if (isCheapest) {
                          cellBg = 'bg-secondary-container/20';
                          cellText = 'text-secondary font-extrabold';
                        }

                        // Get matching item for trend calculation
                        const matchItem = chainPrices.find(cp => cp.cadena === cadena);
                        const changePercent = matchItem?.changePercent || 0;

                        return (
                          <td key={cadena} className={`px-6 py-4 text-right font-mono text-xs ${cellBg} ${cellText} border-l border-white`}>
                            <div>{fmt(cellPrice)}</div>
                            {Math.abs(changePercent) > 0.05 && (
                              <div className={`text-[9px] font-bold flex items-center justify-end gap-0.5 leading-none mt-0.5 ${changePercent > 0 ? 'text-error' : 'text-green-600'}`}>
                                <span className="material-symbols-outlined text-[10px] leading-none">{changePercent > 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                                {changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%
                              </div>
                            )}
                          </td>
                        );
                      })}

                      {/* Average Column */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-on-surface-variant font-semibold bg-surface-low/50 border-l border-surface-variant">
                        {avgCompUsd ? fmt(avgCompUsd) : '—'}
                      </td>

                      {/* Min Price */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-secondary font-bold bg-secondary-container/10">
                        {minCompUsd ? fmt(minCompUsd) : '—'}
                      </td>

                      {/* Mi Precio */}
                      <td className="px-6 py-4 text-right font-mono text-xs text-green-700 font-extrabold bg-green-500/5 border-l border-green-500/10">
                        {propioPriceUsd ? (
                          <>
                            <div>{fmt(propioPriceUsd)}</div>
                            {(() => {
                              const matchItem = chainPrices.find(cp => cp.tipo === 'propio');
                              const changePercent = matchItem?.changePercent || 0;
                              if (Math.abs(changePercent) > 0.05) {
                                return (
                                  <div className={`text-[9px] font-bold flex items-center justify-end gap-0.5 leading-none mt-0.5 ${changePercent > 0 ? 'text-error' : 'text-green-600'}`}>
                                    <span className="material-symbols-outlined text-[10px] leading-none">{changePercent > 0 ? 'arrow_upward' : 'arrow_downward'}</span>
                                    {changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </>
                        ) : '—'}
                      </td>

                      {/* Mi Desviación */}
                      <td className="px-6 py-4 text-right whitespace-nowrap bg-surface-low/30 border-r border-surface-variant">
                        {propioPriceUsd ? (
                          <div className="flex flex-col items-end gap-0.5 text-[10px] font-mono leading-none">
                            <span className={diffMinPercent && diffMinPercent > 0.1 ? 'text-error font-extrabold' : 'text-secondary font-extrabold'}>
                              {diffMinPercent && diffMinPercent > 0.1 ? `vs Mín: +${diffMinPercent.toFixed(1)}%` : 'vs Mín: Mismo'}
                            </span>
                            <span className={diffAvgPercent && diffAvgPercent > 0 ? 'text-error/80 font-bold' : 'text-secondary/80 font-bold'}>
                              {diffAvgPercent && diffAvgPercent > 0 ? `vs Prom: +${diffAvgPercent.toFixed(1)}%` : `vs Prom: -${Math.abs(diffAvgPercent || 0).toFixed(1)}%`}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-300 font-mono select-none">—</span>
                        )}
                      </td>

                      {/* Dispersion Column */}
                      <td className="px-6 py-4 text-center whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-wide uppercase ${
                          dispersionPercent > 20 ? 'bg-error-container text-error border border-error/20'
                          : dispersionPercent > 0 ? 'bg-secondary-container text-on-secondary-container border border-secondary/20'
                          : 'bg-surface-low text-on-surface-variant'
                        }`}>
                          {dispersionPercent > 0 ? `${dispersionPercent.toFixed(0)}%` : '0%'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {totalPaginas > 1 && (
          <div className="px-6 py-4 bg-surface-low border-t border-surface-variant flex flex-col sm:flex-row items-center justify-between gap-4">
            <span className="text-xs text-on-surface-variant font-medium">
              Mostrando {Math.min(filas.length, (paginaActual - 1) * itemsPorPagina + 1)} - {Math.min(filas.length, paginaActual * itemsPorPagina)} de {filas.length} productos
            </span>
            <div className="flex items-center gap-1">
              <button
                disabled={paginaActual === 1}
                onClick={() => setPaginaActual(p => Math.max(1, p - 1))}
                className="p-1.5 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface/50 text-on-surface-variant transition-all font-bold flex items-center"
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              {Array.from({ length: totalPaginas }, (_, i) => i + 1).map(num => (
                <button
                  key={num}
                  onClick={() => setPaginaActual(num)}
                  className={`w-7 h-7 rounded-lg text-xs font-bold transition-all ${
                    paginaActual === num
                      ? 'bg-primary text-on-primary shadow-sm'
                      : 'border border-outline-variant hover:bg-surface/50 text-on-surface-variant'
                  }`}
                >
                  {num}
                </button>
              ))}
              <button
                disabled={paginaActual === totalPaginas}
                onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))}
                className="p-1.5 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface/50 text-on-surface-variant transition-all font-bold flex items-center"
              >
                <span className="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {selectedProduct && (
        <ProductDetailModal
          producto={selectedProduct.producto}
          competencia={selectedProduct.competencia}
          currency={currency}
          bcvRate={bcv.rate}
          initialPriceMode={dashboardPriceMode}
          initialAnalisisMode={analisisMode}
          onClose={() => setSelectedProduct(null)}
        />
      )}

      {/* Clear History Confirmation Dialog */}
      <ConfirmModal
        isOpen={showClearHistoryConfirm}
        title="¿Borrar Todo el Historial?"
        message={`¿Estás seguro de que deseas eliminar TODOS los registros históricos de precios de todos los productos?\n\nEsta acción eliminará todas las tendencias y los logs de ejecución acumulados, reseteando las estadísticas a cero.\n\nLos productos, cadenas y URLs de competencia se conservarán intactos.`}
        confirmText={clearingHistory ? 'Borrando...' : 'Borrar Todo'}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleClearAllHistory}
        onCancel={() => setShowClearHistoryConfirm(false)}
      />

      <GitHubConfigModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
      />

      <BcvDetailModal
        isOpen={showBcvModal}
        onClose={() => setShowBcvModal(false)}
        rates={bcvHistorico}
        currentRate={bcv?.rate}
        bcv={bcv}
      />
    </div>
  );
}

function KpiCard({ label, value, sub, icon, color }) {
  return (
    <div className="neural-card p-5 flex items-center justify-between">
      <div className="space-y-1">
        <span className="text-[10px] uppercase font-mono font-bold tracking-wider text-on-surface-variant">{label}</span>
        <div className={`text-2xl font-display font-extrabold ${color}`}>{value}</div>
        <p className="text-[11px] text-on-surface-variant font-semibold">{sub}</p>
      </div>
      <div className="bg-surface-low p-3 rounded-2xl w-12 h-12 flex items-center justify-center border border-outline-variant/60">
        <span className="material-symbols-outlined text-primary text-2xl select-none">{icon}</span>
      </div>
    </div>
  );
}

function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const strHours = String(hours).padStart(2, '0');
  return `${day}/${month}/${year} ${strHours}:${minutes} ${ampm}`;
}

function BcvController({ bcv, onOpenHistory }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');

  const handleSave = async () => {
    const ok = await bcv.setManual(val);
    if (ok) {
      setVal('');
      setEditing(false);
    }
  };

  const formattedDate = bcv.updatedAt ? formatDateTime(bcv.updatedAt) : '';

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-secondary animate-ping"></span>
        <span className="text-on-surface-variant uppercase font-bold flex items-center gap-1">
          <span className="material-symbols-outlined text-sm leading-none select-none">payments</span>
          TASA:
        </span>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input type="text" value={val} onChange={e => setVal(e.target.value)}
            className="w-24 px-3 py-1.5 border border-outline-variant rounded-xl text-xs font-mono font-semibold focus:outline-none focus:ring-1 focus:ring-primary bg-surface-container-lowest text-on-surface" placeholder="0.00" />
          <button onClick={handleSave} className="m3-btn-primary h-7 px-3 text-[10px]">Guardar</button>
          <button onClick={() => setEditing(false)} className="m3-btn-outline h-7 px-3 text-[10px]">Cancelar</button>
          {bcv.error && <span className="text-[10px] text-error font-bold">{bcv.error}</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-extrabold text-primary text-base">
            {bcv.loading ? 'Recuperando...' : bcv.rate ? `Bs ${bcv.rate.toFixed(4)} / USD` : 'Sin tasa'}
          </span>
          <span className="text-[9px] uppercase bg-primary-container px-2.5 py-1 rounded-full text-on-primary-container font-bold">
            {bcv.source || 'Auto'}
          </span>
          {formattedDate && (
            <span className="text-[11px] text-on-surface-variant font-sans flex items-center gap-1 bg-surface-container-low px-2.5 py-1 rounded-full border border-outline-variant/50" title="Fecha y hora de la última actualización de la tasa">
              <span className="material-symbols-outlined text-xs text-primary leading-none">schedule</span>
              <span className="font-semibold">{formattedDate}</span>
            </span>
          )}
          <button onClick={() => { setEditing(true); setVal(bcv.rate || ''); }}
            className="text-[11px] font-bold text-primary hover:underline uppercase inline-flex items-center gap-0.5">
            <span className="material-symbols-outlined text-xs">edit</span>
            Editar Tasa
          </button>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'hace unos segundos';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}
