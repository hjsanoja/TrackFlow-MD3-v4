import { memo, useCallback, useDeferredValue, useState, useMemo } from 'react';
import StatCard from '../components/StatCard';
import { useBcvRate } from '../hooks/useBcvRate';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { factorPromo, AYUDA_OFERTA } from '../utils/promociones';
import { tokensGrafico } from '../utils/chartTokens';
import BarraFiltros from '../components/BarraFiltros';
import Segmentado from '../components/Segmentado';
import CadenaBadge from '../components/CadenaBadge';
import ProductDetailModal from '../components/ProductDetailModal';
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip,
  BarChart, Bar, Cell, ReferenceLine,
  ScatterChart, Scatter
} from 'recharts';

export default function Simulador({ user, userDoc }) {
  const { productos, productosCompetencia, variaciones = [], cadenas = [], loadingInitial: loading } = useData();
  // Antes bajaba 180 dias de historico solo para el cambio frente a ayer:
  // ese dato ya esta en v_variacion (variaciones), que el panel tiene en memoria.
  const [dashboardPriceMode, setDashboardPriceMode] = useState('lista');
  const [analisisMode, setAnalisisMode] = useState('empaque'); // 'empaque' or 'unidosis'
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Simulation State
  const [simulacionVariacion, setSimulacionVariacion] = useState(0);
  // El deslizador responde al instante; los indicadores se recalculan detras.
  const variacionSim = useDeferredValue(simulacionVariacion);
  const [reporteGenerado, setReporteGenerado] = useState(null);
  const [activeReportTab, setActiveReportTab] = useState('ejecutivo');

  const bcv = useBcvRate();
  const { addToast } = useToast();

  // Por enlace: precio actual y el de ayer (v_variacion).
  const mapaVariacion = useMemo(() => {
    const m = new Map();
    for (const v of variaciones || []) if (v.publicacion_id != null) m.set(v.publicacion_id, v);
    return m;
  }, [variaciones]);
  // Enlaces activos de cada producto tuyo (antes se filtraba la lista entera por producto).
  const enlacesPorProducto = useMemo(() => {
    const m = new Map();
    for (const pc of productosCompetencia || []) {
      if (!pc.activo || !pc.id_producto_propio) continue;
      const id = String(pc.id_producto_propio).trim();
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(pc);
    }
    return m;
  }, [productosCompetencia]);
  const nombreCadena = useMemo(() => {
    const m = new Map();
    for (const c of cadenas || []) { m.set(String(c.id).toLowerCase(), c.nombre); m.set(String(c.nombre).toLowerCase(), c.nombre); }
    return (v) => m.get(String(v || '').toLowerCase()) || v || '—';
  }, [cadenas]);

  // Main calculations for products and competitors
  const analizados = useMemo(() => {
    return productos
      .filter(p => p.activo)
      .map(p => {
        const pId = String(p.id_interno || p.id || '').trim();
        const compItems = pId ? (enlacesPorProducto.get(pId) || []) : [];
        
        const pUnidosisCount = parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis || p.unidades_empaque);
        const pUnitFactor = analisisMode === 'unidosis' ? Math.max(pUnidosisCount, 1) : 1;

        const chainPrices = compItems.map(c => {
          const rawPriceBs = dashboardPriceMode === 'descuento'
            ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs) * factorPromo(c.promo_codigo)
            : c.ultimo_precio_full_bs;
          if (!rawPriceBs || !bcv.rate) return null;

          const cUnidosisCount = parseUnidosisCount(c.tamano, c.marca, c.unidosis || c.unidades_empaque) || pUnidosisCount;
          const cUnitFactor = analisisMode === 'unidosis' ? Math.max(cUnidosisCount, 1) : 1;

          const priceBs = rawPriceBs / cUnitFactor;

          const fila = c.publicacion_id != null ? mapaVariacion.get(c.publicacion_id) : null;
          const desc = dashboardPriceMode === 'descuento';
          const currentVal = fila ? Number(desc ? (fila.precio_actual_desc_bs ?? fila.precio_actual_full_bs) : fila.precio_actual_full_bs) || null : null;
          const prevVal = fila ? Number(desc ? (fila.precio_1d_desc_bs ?? fila.precio_1d_full_bs) : fila.precio_1d_full_bs) || null : null;

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

        const hasChangesToday = chainPrices.some(cp => Math.abs(cp.changePercent) > 0.05);

        const allPricesUsd = chainPrices.map(x => x.priceUsd);

        const avgCompUsd = allPricesUsd.length > 0 
          ? allPricesUsd.reduce((a, b) => a + b, 0) / allPricesUsd.length 
          : null;

        const minCompUsd = allPricesUsd.length > 0 ? Math.min(...allPricesUsd) : null;
        const maxCompUsd = allPricesUsd.length > 0 ? Math.max(...allPricesUsd) : null;

        const dispersionPercent = (minCompUsd && maxCompUsd && minCompUsd > 0)
          ? ((maxCompUsd - minCompUsd) / minCompUsd) * 100
          : 0;

        const cheapestChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - minCompUsd) < 0.001)
          .map(x => x.cadena);

        const mostExpensiveChains = chainPrices
          .filter(x => Math.abs(x.priceUsd - maxCompUsd) < 0.001)
          .map(x => x.cadena);

        // Find own price (most economical one among all own listings)
        const propioOptions = chainPrices.filter(x => x.tipo === 'propio');
        const propioPriceUsd = propioOptions.length > 0 
          ? Math.min(...propioOptions.map(x => x.priceUsd)) 
          : null;

        const diffMinUsd = (propioPriceUsd !== null && minCompUsd !== null) ? propioPriceUsd - minCompUsd : null;
        const diffMinPercent = (diffMinUsd !== null && minCompUsd > 0) ? (diffMinUsd / minCompUsd) * 100 : null;

        const diffAvgUsd = (propioPriceUsd !== null && avgCompUsd !== null) ? propioPriceUsd - avgCompUsd : null;
        const diffAvgPercent = (diffAvgUsd !== null && avgCompUsd > 0) ? (diffAvgUsd / avgCompUsd) * 100 : null;

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
  }, [productos, enlacesPorProducto, mapaVariacion, bcv.rate, dashboardPriceMode, analisisMode]);

  // Strategic Business Unit (UN) analysis
  const analisisUnidadNegocio = useMemo(() => {
    const uns = ['La Sante', 'Pharmetique', 'OTC'];
    
    return uns.map(un => {
      // Filter analizados belonging to this UN
      const itemsUn = analizados.filter(item => {
        const pUn = (item.producto.unidad_negocio || 'La Sante').toUpperCase();
        return pUn === un.toUpperCase();
      });

      const totalProductos = itemsUn.length;
      
      // Calculate average deviation vs competitor average for products with own price
      const itemsConPrecio = itemsUn.filter(item => item.propioPriceUsd && item.avgCompUsd);
      
      let avgDiffAvg = 0;
      let avgDiffMin = 0;
      let ownAvgPrice = 0;
      let compAvgPrice = 0;

      if (itemsConPrecio.length > 0) {
        const sumDiffAvg = itemsConPrecio.reduce((sum, item) => sum + (item.diffAvgPercent || 0), 0);
        const sumDiffMin = itemsConPrecio.reduce((sum, item) => sum + (item.diffMinPercent || 0), 0);
        const sumOwnPrice = itemsConPrecio.reduce((sum, item) => sum + item.propioPriceUsd, 0);
        const sumCompPrice = itemsConPrecio.reduce((sum, item) => sum + item.avgCompUsd, 0);

        avgDiffAvg = sumDiffAvg / itemsConPrecio.length;
        avgDiffMin = sumDiffMin / itemsConPrecio.length;
        ownAvgPrice = sumOwnPrice / itemsConPrecio.length;
        compAvgPrice = sumCompPrice / itemsConPrecio.length;
      }

      // Calculate Brand vs Generic Premium within this UN
      const genericos = itemsUn.filter(item => (item.producto.market_type || 'GENERICO').toUpperCase() === 'GENERICO' && item.propioPriceUsd);
      const marcas = itemsUn.filter(item => (item.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' && item.propioPriceUsd);

      let avgPriceGenerico = 0;
      let avgPriceMarca = 0;
      let brandPremiumAvg = 0;

      if (genericos.length > 0) {
        avgPriceGenerico = genericos.reduce((sum, item) => sum + item.propioPriceUsd, 0) / genericos.length;
      }
      if (marcas.length > 0) {
        avgPriceMarca = marcas.reduce((sum, item) => sum + item.propioPriceUsd, 0) / marcas.length;
      }
      if (avgPriceGenerico > 0 && avgPriceMarca > 0) {
        brandPremiumAvg = ((avgPriceMarca - avgPriceGenerico) / avgPriceGenerico) * 100;
      }

      // Generate personalized business recommendations matching user triggers
      const alertas = [];
      const recomendaciones = [];

      if (totalProductos === 0) {
        recomendaciones.push({
          tipo: 'info',
          titulo: 'Sin datos registrados',
          detalle: `No se han detectado productos para la Unidad de Negocio ${un}. Configura la unidad en la sección "Productos" o sube un CSV para activarla.`
        });
      } else {
        // Rule 1: OTC raises prices if below avg
        if (un === 'OTC') {
          // If average price deviation is negative (cheaper than competitors), or less than -5%
          if (avgDiffAvg < -0.05) {
            alertas.push(`OTC Sub-indexado: La UN OTC se encuentra promediando un ${Math.abs(avgDiffAvg * 100).toFixed(0)}% por debajo del promedio del mercado.`);
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Oportunidad de Margen (Subir Precios)',
              detalle: `La UN OTC debe subir precios ya que se encuentra un ${Math.abs(avgDiffAvg * 100).toFixed(0)}% por debajo del promedio. Esto optimizará el EBITDA de la línea de consumo sin mermar la demanda.`
            });
          } else if (avgDiffAvg > 0.15) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Riesgo de Competitividad',
              detalle: `La línea OTC promedia un precio ${Math.abs(avgDiffAvg * 100).toFixed(0)}% superior al mercado, lo cual podría mermar la rotación rápida requerida en consumo masivo.`
            });
          } else {
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Posicionamiento Saludable',
              detalle: `La línea OTC se encuentra bien indexada (promedio vs competencia: ${avgDiffAvg >= 0 ? '+' : ''}${(avgDiffAvg * 100).toFixed(1)}%). Mantener monitoreo regular.`
            });
          }
        }

        // Rule 2: La Sante lower prices if above Brand prices
        if (un === 'La Sante') {
          // Let's check brand premium deviation vs overall generic pricing
          // If La Sante average price is significantly above competitor brands or has high brand premium
          if (avgDiffAvg > 0.15) {
            alertas.push(`La Santé Sobre-indexado: Promedia precios un ${(avgDiffAvg * 100).toFixed(0)}% por encima de la competencia.`);
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Ajuste de Precios a la Baja',
              detalle: `La UN La Santé debe bajar precios ya que tiene un precio superior al promedio de la competencia en un ${(avgDiffAvg * 100).toFixed(0)}%. Se recomienda regular descuentos para proteger la base de volumen.`
            });
          } else if (avgDiffAvg < -0.15) {
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Margen de Crecimiento',
              detalle: `La Santé promedia un ${(Math.abs(avgDiffAvg) * 100).toFixed(0)}% por debajo del mercado. Hay espacio estratégico para ajustar precios al alza en portafolio clave.`
            });
          } else {
            // General recommendation for Sante
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Indexación Estratégica',
              detalle: `La Santé promedia un ${avgDiffAvg >= 0 ? '+' : ''}${(avgDiffAvg * 100).toFixed(1)}% vs competencia. Cumple con la paridad óptima para conservar cuota de mercado.`
            });
          }

          // Brand parity issues inside Sante
          if (brandPremiumAvg > 33) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Brecha Excesiva de Marca vs Genérico',
              detalle: `La UN La Santé debe bajar precios ya que tiene un precio superior a los de Marca en un ${brandPremiumAvg.toFixed(0)}% promedio, ensanchando la brecha de compra del paciente.`
            });
          }
        }

        // Rule 3: Pharmetique specific rules
        if (un === 'Pharmetique') {
          if (avgDiffAvg > 0.10) {
            recomendaciones.push({
              tipo: 'bajar_precios',
              titulo: 'Optimización de Canal',
              detalle: `Pharmetique promedia un ${(avgDiffAvg * 100).toFixed(0)}% por encima del promedio del mercado. Analizar si la prima de prescripción médica justifica este diferencial.`
            });
          } else if (avgDiffAvg < -0.10) {
            recomendaciones.push({
              tipo: 'subir_precios',
              titulo: 'Captura de Valor',
              detalle: `Pharmetique está ${(Math.abs(avgDiffAvg) * 100).toFixed(0)}% por debajo de competidores de marca equivalentes. Oportunidad para subir precios de lista en moléculas premium.`
            });
          } else {
            recomendaciones.push({
              tipo: 'estable',
              titulo: 'Posicionamiento Competitivo Óptimo',
              detalle: `Pharmetique mantiene un excelente alineamiento competitivo, posicionándose un ${(avgDiffAvg * 100).toFixed(1)}% respecto al promedio de competencia.`
            });
          }
        }

        // Rule 4: General checks
        // Check for "Generic priced higher than Brand" anomaly inside the UN
        const anomalos = itemsUn.filter(item => {
          if ((item.producto.market_type || 'GENERICO').toUpperCase() === 'GENERICO' && item.propioPriceUsd) {
            // Find brands of the same molecule
            const marcasMolecula = itemsUn.filter(m => 
              (m.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' && 
              m.producto.principio_activo === item.producto.principio_activo &&
              m.propioPriceUsd
            );
            return marcasMolecula.some(m => item.propioPriceUsd > m.propioPriceUsd);
          }
          return false;
        });

        if (anomalos.length > 0) {
          alertas.push(`Inconsistencia Crítica de Precios: Se detectaron ${anomalos.length} productos Genéricos con un precio de venta superior a su opción de Marca correspondiente.`);
          recomendaciones.push({
            tipo: 'urgente',
            titulo: 'Corrección Urgente de Paridad (Anomalía)',
            detalle: `Se detectaron genéricos (${anomalos.map(a => a.producto.nombre).join(', ')}) costando más que su respectiva opción de marca en la misma UN. Corregir esta anomalía inmediatamente para evitar confusión en el canal.`
          });
        }
      }

      return {
        un,
        totalProductos,
        productosMonitoreados: itemsConPrecio.length,
        avgDiffAvg: avgDiffAvg * 100, // as percentage
        avgDiffMin: avgDiffMin * 100, // as percentage
        ownAvgPrice,
        compAvgPrice,
        brandPremiumAvg,
        alertas,
        recomendaciones
      };
    });
  }, [analizados]);

  const kpiStats = useMemo(() => {
    let totalDispersion = 0;
    let productsWithDispersion = 0;
    let maxDispersionVal = 0;
    let maxDispersionProd = '—';

    analizados.forEach(item => {
      if (item.dispersionPercent > 0) {
        totalDispersion += item.dispersionPercent;
        productsWithDispersion++;
        if (item.dispersionPercent > maxDispersionVal) {
          maxDispersionVal = item.dispersionPercent;
          maxDispersionProd = item.producto.nombre;
        }
      }
    });

    let ownBrandTotal = 0;
    let ownBrandLider = 0;
    let totalDiffVsMin = 0;
    let diffVsMinCount = 0;
    analizados.forEach(item => {
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
            const diffPct = ((propioPrice - minAlt) / minAlt) * 100;
            totalDiffVsMin += diffPct;
            diffVsMinCount++;
          } else {
            ownBrandLider++;
          }
        }
      }
    });

    const porcentajeLiderazgoPropio = ownBrandTotal > 0 ? Math.round((ownBrandLider / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMin = diffVsMinCount > 0 ? (totalDiffVsMin / diffVsMinCount) : 0;

    let totalIpr = 0;
    let iprCount = 0;

    analizados.forEach(item => {
      if (item.propioPriceUsd && item.avgCompUsd) {
        totalIpr += (item.propioPriceUsd / item.avgCompUsd) * 100;
        iprCount++;
      }
    });

    const globalIpr = iprCount > 0 ? totalIpr / iprCount : null;

    return {
      avgDispersion: productsWithDispersion > 0 ? totalDispersion / productsWithDispersion : 0,
      porcentajeLiderazgoPropio,
      brechaPromedioVsMin,
      globalIpr,
    };
  }, [analizados]);

  // Calculations for simulated pricing (Fase 3)
  const simulatedStats = useMemo(() => {
    let totalSimIpr = 0;
    let simIprCount = 0;
    let ownBrandTotal = 0;
    let ownBrandLiderSim = 0;
    let totalDiffVsMinSim = 0;
    let diffVsMinCountSim = 0;

    const itemsSimulados = analizados.map(item => {
      const { propioPriceUsd, avgCompUsd, chainPrices } = item;
      
      const simOwnPriceUsd = propioPriceUsd !== null 
        ? propioPriceUsd * (1 + variacionSim / 100) 
        : null;

      let simRanking = item.ranking;
      let isLiderSim = false;

      if (simOwnPriceUsd !== null) {
        ownBrandTotal++;
        
        const altPrices = chainPrices
          .filter(cp => cp.tipo === 'alternativa')
          .map(cp => cp.priceUsd);

        if (altPrices.length > 0) {
          const minAlt = Math.min(...altPrices);
          isLiderSim = simOwnPriceUsd <= minAlt;
          
          const diffPct = ((simOwnPriceUsd - minAlt) / minAlt) * 100;
          totalDiffVsMinSim += diffPct;
          diffVsMinCountSim++;
        } else {
          isLiderSim = true;
        }

        if (isLiderSim) {
          ownBrandLiderSim++;
        }

        const simChainPrices = chainPrices.map(cp => {
          if (cp.tipo === 'propio') {
            return { ...cp, priceUsd: simOwnPriceUsd, priceBs: simOwnPriceUsd * (bcv.rate || 1) };
          }
          return cp;
        });
        const sorted = [...simChainPrices].sort((a, b) => a.priceUsd - b.priceUsd);
        const ownIndex = sorted.findIndex(x => x.tipo === 'propio');
        simRanking = ownIndex !== -1 ? ownIndex + 1 : null;
      }

      if (simOwnPriceUsd !== null && avgCompUsd) {
        totalSimIpr += (simOwnPriceUsd / avgCompUsd) * 100;
        simIprCount++;
      }

      return {
        ...item,
        simOwnPriceUsd,
        simRanking,
        isLiderSim,
      };
    });

    const simGlobalIpr = simIprCount > 0 ? totalSimIpr / simIprCount : null;
    const porcentajeLiderazgoSim = ownBrandTotal > 0 ? Math.round((ownBrandLiderSim / ownBrandTotal) * 100) : 100;
    const brechaPromedioVsMinSim = diffVsMinCountSim > 0 ? (totalDiffVsMinSim / diffVsMinCountSim) : 0;

    return {
      itemsSimulados,
      simGlobalIpr,
      porcentajeLiderazgoSim,
      brechaPromedioVsMinSim,
    };
  }, [analizados, variacionSim, bcv.rate]);

  // Price gap bar chart data: deviation % vs competitors
  const priceGapData = useMemo(() => {
    return analizados
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
  }, [analizados]);

  // Currency Formatter Helper
  const fmt = (priceUsd) => {
    if (priceUsd === null || priceUsd === undefined) return '—';
    return '$' + priceUsd.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtBs = (priceUsd) => {
    if (priceUsd === null || priceUsd === undefined) return '—';
    return 'Bs ' + (priceUsd * bcv.rate).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // All active chains represented
  const cadenasUnicas = useMemo(() => {
    const set = new Set(productosCompetencia.map(pc => pc.cadena));
    return Array.from(set).sort();
  }, [productosCompetencia]);

  // Scatter Plot Positioning Matrix Data (Mi Precio USD vs. Promedio Mercado USD)
  const scatterPlotData = useMemo(() => {
    return analizados
      .filter(item => item.propioPriceUsd !== null && item.avgCompUsd !== null && item.avgCompUsd > 0)
      .map(item => ({
        id: item.producto.id_interno,
        name: item.producto.nombre,
        categoria: item.producto.categoria || 'Sin Cat',
        x: parseFloat(item.avgCompUsd.toFixed(2)),
        y: parseFloat(item.propioPriceUsd.toFixed(2)),
        diffAvgPercent: item.diffAvgPercent ? parseFloat(item.diffAvgPercent.toFixed(1)) : 0,
        dispersionPercent: parseFloat(item.dispersionPercent.toFixed(1)),
        ranking: item.ranking,
        totalOptions: item.totalOptionsCount,
        producto: item.producto,
        competencia: item.competencia,
      }));
  }, [analizados]);

  // Indicator: In which pharmacy chain are our products most expensive on average?
  const cadenaComparacionCostos = useMemo(() => {
    if (!analizados || analizados.length === 0 || cadenasUnicas.length === 0) return null;

    const statsPorCadena = cadenasUnicas.map(cName => {
      let sumDiffPct = 0;
      let count = 0;
      let masCostososCount = 0;
      let masBaratosCount = 0;

      analizados.forEach(item => {
        if (!item.propioPriceUsd || item.propioPriceUsd <= 0) return;
        
        const compInChain = item.chainPrices.find(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim() && x.tipo !== 'propio');
        if (compInChain && compInChain.priceUsd > 0) {
          const diffPct = ((item.propioPriceUsd - compInChain.priceUsd) / compInChain.priceUsd) * 100;
          sumDiffPct += diffPct;
          count++;
          if (diffPct > 1) masCostososCount++;
          if (diffPct < -1) masBaratosCount++;
        }
      });

      const avgDiff = count > 0 ? sumDiffPct / count : null;
      return {
        cadena: cName,
        avgDiff,
        count,
        masCostososCount,
        masBaratosCount
      };
    }).filter(s => s.count > 0 && s.avgDiff !== null);

    if (statsPorCadena.length === 0) return null;

    statsPorCadena.sort((a, b) => b.avgDiff - a.avgDiff);

    const cadenaMasCostosa = statsPorCadena[0];
    const cadenaMasBarata = statsPorCadena[statsPorCadena.length - 1];

    return {
      ranking: statsPorCadena,
      cadenaMasCostosa,
      cadenaMasBarata
    };
  }, [analizados, cadenasUnicas]);

  // Indicator: Share of Voice (SoV) de Precios y Cobertura de Competidores
  const shareOfVoiceData = useMemo(() => {
    if (!analizados || analizados.length === 0 || cadenasUnicas.length === 0) return [];

    const totalProductos = analizados.length;

    return cadenasUnicas.map(cName => {
      let skusMonitoreados = 0;
      let lowestCount = 0;
      let highestCount = 0;
      let totalComparados = 0;

      analizados.forEach(item => {
        const hasChain = item.chainPrices.some(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim());
        if (hasChain) skusMonitoreados++;

        if (item.minCompUsd && item.chainPrices.some(x => x.cadena.toLowerCase().trim() === cName.toLowerCase().trim() && x.tipo !== 'propio')) {
          totalComparados++;
          if (item.cheapestChains.some(ch => ch.toLowerCase().trim() === cName.toLowerCase().trim())) {
            lowestCount++;
          }
          if (item.mostExpensiveChains.some(ch => ch.toLowerCase().trim() === cName.toLowerCase().trim())) {
            highestCount++;
          }
        }
      });

      const coveragePct = totalProductos > 0 ? (skusMonitoreados / totalProductos) * 100 : 0;
      const cheapestSoVPct = totalComparados > 0 ? (lowestCount / totalComparados) * 100 : 0;

      return {
        cadena: cName,
        skusMonitoreados,
        coveragePct,
        lowestCount,
        highestCount,
        totalComparados,
        cheapestSoVPct
      };
    }).sort((a, b) => b.cheapestSoVPct - a.cheapestSoVPct);
  }, [analizados, cadenasUnicas]);

  // Indicator: Elasticidad Histórica por Molécula
  const elasticidadPorMolecula = useMemo(() => {
    if (!analizados || analizados.length === 0) return [];

    const grouped = {};
    analizados.forEach(item => {
      const principio = (item.producto.principio_activo || '').trim();
      if (!principio) return;
      
      const key = principio.toLowerCase();
      if (!grouped[key]) {
        grouped[key] = {
          nombre: principio,
          items: [],
        };
      }
      grouped[key].items.push(item);
    });

    const moleculasList = Object.values(grouped).map(g => {
      const totalSkus = g.items.length;
      const marcasCount = g.items.filter(x => (x.producto.market_type || '').toUpperCase() === 'MARCA').length;
      const genericosCount = totalSkus - marcasCount;

      const dispersions = g.items.map(x => x.dispersionPercent).filter(d => d > 0);
      const avgDispersion = dispersions.length > 0 ? dispersions.reduce((a,b) => a+b, 0) / dispersions.length : 0;

      let totalChangeCount = 0;
      let sumAbsChanges = 0;
      g.items.forEach(x => {
        x.chainPrices.forEach(cp => {
          if (cp.changePercent && Math.abs(cp.changePercent) > 0) {
            sumAbsChanges += Math.abs(cp.changePercent);
            totalChangeCount++;
          }
        });
      });
      const avgVolatilidad = totalChangeCount > 0 ? sumAbsChanges / totalChangeCount : 0;

      const elasticityScore = (avgDispersion * 0.6) + (avgVolatilidad * 0.4);

      let tipoElasticidad = 'Moderada';
      let badgeClass = '';
      let recomendacion = 'Comportamiento en paridad estándar.';

      if (elasticityScore > 18 || avgDispersion > 25) {
        tipoElasticidad = 'Alta Elasticidad (Sensible)';
        badgeClass = 'is-error';
        recomendacion = 'Sensibilidad alta al precio. Aumentos provocan rápida migración a genéricos u otra cadena.';
      } else if (elasticityScore < 10 && avgDispersion < 12) {
        tipoElasticidad = 'Inelástico (Oportunidad EBITDA)';
        badgeClass = 'is-primary';
        recomendacion = 'Baja sensibilidad. Oportunidad para realizar ajustes al alza y capturar margen de beneficio.';
      }

      return {
        nombre: g.nombre,
        totalSkus,
        marcasCount,
        genericosCount,
        avgDispersion,
        avgVolatilidad,
        elasticityScore,
        tipoElasticidad,
        badgeClass,
        recomendacion
      };
    });

    return moleculasList.sort((a, b) => b.elasticityScore - a.elasticityScore);
  }, [analizados]);

  // Report Generation with deep insights for BOTH overly expensive and overly cheap items
  const handleGenerarReporte = () => {
    // Antes esperaba 2,3 s con pasos de carga de adorno: el calculo es inmediato.

    const numSubir = [];
    const numBajar = [];
    
    analizados.forEach(item => {
      if (item.propioPriceUsd !== null && item.avgCompUsd !== null) {
        const diffAvg = item.diffAvgPercent || 0;
        if (diffAvg < -12) {
          numSubir.push(item);
        } else if (diffAvg > 12) {
          numBajar.push(item);
        }
      }
    });

    const iprStr = kpiStats.globalIpr ? kpiStats.globalIpr.toFixed(1) : '—';
    const statusText = kpiStats.globalIpr 
      ? (kpiStats.globalIpr < 98 ? 'altamente competitivo (marca líder en precios de bajo costo)' 
         : kpiStats.globalIpr <= 103 ? 'moderadamente competitivo (paridad de mercado aceptable)' 
         : 'premium / costoso (riesgo alto de pérdida de volumen ante competidores)')
      : 'no disponible';

    const reporte = {
      titulo: 'Dossier de Inteligencia y Estrategia de Precios · TrackFlow',
      fecha: new Date().toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      tasaBcv: bcv.rate || 1,
      resumenEjecutivo: `Tras un análisis detallado del portafolio monitoreado, su Índice de Precios Relativos (IPR) Global se sitúa en **${iprStr}%**, posicionándolo como un perfil **${statusText}**. La dispersión general de precios de los competidores promedia un **${kpiStats.avgDispersion.toFixed(1)}%**, lo que indica que el mercado farmacéutico de Venezuela se encuentra en una fase de alta dinámica y de constantes brechas de arbitraje de precios.`,
      
      // DEEP RECOMMENDATIONS FOR OVERLY CHEAP PRODUCTS (PROTECT MARGINS!)
      oportunidadesSubir: numSubir.map(x => {
        const gapAbs = Math.abs(x.diffAvgPercent);
        // Suggested increase that keeps them slightly cheaper but captures missing margins
        const incrementoRecomendado = Math.max(5, Math.round(gapAbs - 5));
        const precioSugeridoUsd = x.propioPriceUsd * (1 + incrementoRecomendado / 100);
        
        return {
          id: x.producto.id_interno,
          nombre: x.producto.nombre,
          precioPropio: x.propioPriceUsd,
          precioPromedio: x.avgCompUsd,
          gap: x.diffAvgPercent,
          incrementoPct: incrementoRecomendado,
          precioSugeridoUsd,
          recomendacion: `Estás un ${gapAbs.toFixed(1)}% por debajo del promedio. RECOMENDACIÓN MARGEN: Incrementar tu precio en un **${incrementoRecomendado}%** (hasta llegar a **${fmt(precioSugeridoUsd)}** / **${fmtBs(precioSugeridoUsd)}**). Esto te posiciona en la franja de descuento seguro del -5% frente al promedio de competencia, lo que detiene la erosión innecesaria de margen y recupera rentabilidad de forma segura, manteniendo una excelente percepción de bajo costo ante tus pacientes sin arriesgar volumen.`
        };
      }),

      // DEEP RECOMMENDATIONS FOR OVERLY EXPENSIVE PRODUCTS (AVOID FLIGHT OF CLIENTS!)
      oportunidadesBajar: numBajar.map(x => {
        const gapAbs = Math.abs(x.diffAvgPercent);
        // Suggested discount to enter competitive tolerance zone
        const descuentoRecomendado = Math.max(5, Math.round(gapAbs - 2));
        const precioSugeridoUsd = x.propioPriceUsd * (1 - descuentoRecomendado / 100);
        
        return {
          id: x.producto.id_interno,
          nombre: x.producto.nombre,
          precioPropio: x.propioPriceUsd,
          precioPromedio: x.avgCompUsd,
          gap: x.diffAvgPercent,
          descuentoPct: descuentoRecomendado,
          precioSugeridoUsd,
          recomendacion: `Estás un ${gapAbs.toFixed(1)}% por encima del promedio. ALERTA DE FUGA: Existe un riesgo crítico de pérdida de volumen. Recomendamos aplicar un descuento estratégico correctivo del **${descuentoRecomendado}%** (ajustando a **${fmt(precioSugeridoUsd)}** / **${fmtBs(precioSugeridoUsd)}**) para reingresar al rango de paridad del mercado y contener de inmediato la fuga persistente de pacientes hacia cadenas rivales.`
        };
      }),

      estrategiaElasticidad: `Con la simulación actual de **${simulacionVariacion > 0 ? '+' : ''}${simulacionVariacion}%**, su IPR Global se ajustaría a **${simulatedStats.simGlobalIpr ? simulatedStats.simGlobalIpr.toFixed(1) : '—'}%** y su liderazgo de precios en góndola pasaría de **${kpiStats.porcentajeLiderazgoPropio}%** a **${simulatedStats.porcentajeLiderazgoSim}%** de los productos activos. Esto generaría un ${simulacionVariacion > 0 ? 'incremento inmediato de margen unitario, pero con un riesgo estimado de contracción del 5-8% en el volumen de ventas en medicamentos elásticos' : simulacionVariacion < 0 ? 'estímulo en el volumen físico de ventas (estimado +10-15% en medicamentos de alta rotación) que compensará la reducción de margen' : 'posicionamiento estable en el mercado sin variaciones significativas de elasticidad'}.`,
    };

    setReporteGenerado(reporte);
    setActiveReportTab('ejecutivo');
  };

  const handleCopiarReporte = () => {
    if (!reporteGenerado) return;
    const r = reporteGenerado;
    let txt = `=== ${r.titulo.toUpperCase()} ===\n`;
    txt += `Fecha: ${r.fecha}\n`;
    txt += `Tasa Oficial BCV: Bs ${r.tasaBcv.toFixed(4)} / USD\n\n`;
    txt += `--- RESUMEN EJECUTIVO ---\n${r.resumenEjecutivo}\n\n`;
    txt += `--- IMPACTO DE SIMULACIÓN Y ELASTICIDAD ---\n${r.estrategiaElasticidad}\n\n`;
    
    if (r.oportunidadesSubir.length > 0) {
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (EVITAR PERDER DINERO) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (SOBREPRECIOS CRÍTICOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    navigator.clipboard.writeText(txt)
      .then(() => addToast('Reporte copiado.', 'success'))
      .catch(() => addToast('No se pudo copiar: usa «Descargar».', 'warning'));
  };

  const handleDescargarReporteTxt = () => {
    if (!reporteGenerado) return;
    const r = reporteGenerado;
    let txt = `=== ${r.titulo.toUpperCase()} ===\n`;
    txt += `Fecha: ${r.fecha}\n`;
    txt += `Tasa Oficial BCV: Bs ${r.tasaBcv.toFixed(4)} / USD\n\n`;
    txt += `--- RESUMEN EJECUTIVO ---\n${r.resumenEjecutivo}\n\n`;
    txt += `--- IMPACTO DE SIMULACIÓN Y ELASTICIDAD ---\n${r.estrategiaElasticidad}\n\n`;
    
    if (r.oportunidadesSubir.length > 0) {
      txt += `--- OPORTUNIDADES DE CAPTURA DE MARGEN (EVITAR PERDER DINERO) ---\n`;
      r.oportunidadesSubir.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    if (r.oportunidadesBajar.length > 0) {
      txt += `--- ALERTAS DE PÉRDIDA DE VOLUMEN (SOBREPRECIOS CRÍTICOS) ---\n`;
      r.oportunidadesBajar.forEach(o => {
        txt += `* ${o.nombre} (ID: ${o.id}) | Mi Precio actual: ${fmt(o.precioPropio)} | Promedio Competidores: ${fmt(o.precioPromedio)} (+${o.gap.toFixed(1)}% vs promedio)\n  Recomendación: ${o.recomendacion}\n\n`;
      });
    }

    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Reporte_Estrategico_Precios_${new Date().toISOString().slice(0, 10)}.txt`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportarSimulacion = () => {
    const headers = [
      { label: 'ID Interno', key: 'id' },
      { label: 'Producto', key: 'nombre' },
      { label: 'Categoría', key: 'categoria' },
      { label: 'Precio Base USD', key: 'precioPropioUsd' },
      { label: 'Precio Simulado USD', key: 'precioSimuladoUsd' },
      { label: 'Variación Aplicada (%)', key: 'variacion' },
      { label: 'Promedio Mercado USD', key: 'avgCompUsd' },
      { label: 'Brecha Mercado Sim. (%)', key: 'brechaSimulada' }
    ];

    const dataRows = analizados.map(item => {
      const precioPropio = item.propioPriceUsd || 0;
      const precioSimulado = precioPropio * (1 + simulacionVariacion / 100);
      const avgComp = item.avgCompUsd || 0;
      let brechaSim = 0;
      if (avgComp > 0) {
        brechaSim = ((precioSimulado - avgComp) / avgComp) * 100;
      }

      return {
        id: item.producto.id_interno,
        nombre: item.producto.nombre,
        categoria: item.producto.categoria || 'Sin Cat',
        precioPropioUsd: precioPropio ? precioPropio.toFixed(2) : '—',
        precioSimuladoUsd: precioSimulado ? precioSimulado.toFixed(2) : '—',
        variacion: `${simulacionVariacion > 0 ? '+' : ''}${simulacionVariacion}%`,
        avgCompUsd: avgComp ? avgComp.toFixed(2) : '—',
        brechaSimulada: avgComp > 0 ? `${brechaSim > 0 ? '+' : ''}${brechaSim.toFixed(1)}%` : '—'
      };
    });

    exportToCSV(`Simulacion_Precios_Estrategica_${simulacionVariacion}pct`, headers, dataRows);
    addToast(`Simulación exportada a CSV con variacion de ${simulacionVariacion}%.`, 'success');
  };

  const elegirProducto = useCallback((e) => setSelectedProduct({ producto: e.producto, competencia: e.competencia }), []);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-16 rounded-2xl m3-skeleton" />
        <div className="h-72 rounded-2xl m3-skeleton" />
      </div>
    );
  }

  const tonoDif = (v) => (v == null ? 'text-on-surface' : v > 5 ? 'text-error' : v < -5 ? 'text-[color:var(--md-sys-color-data-positive)]' : 'text-on-surface');
  const pctTxt = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)} %`);
  const ESCENARIOS = [[-10, '−10 %'], [-3, '−3 %'], [0, 'Actual'], [5, '+5 %']];

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="m3-body-medium text-on-surface-variant">
          Tu posición por unidad de negocio, qué pasaría si subes o bajas tus precios y dónde se aleja tu precio del mercado.
        </p>
        <button onClick={handleExportarSimulacion} className="m3-btn-outline self-start md:self-auto" title="Descargar en CSV tus precios actuales y simulados">
          <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
          <span>Exportar</span>
        </button>
      </div>

      <BarraFiltros
        etiqueta="Opciones del simulador"
        comparar={(
          <>
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={dashboardPriceMode} onChange={setDashboardPriceMode}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', AYUDA_OFERTA]]} />
            <Segmentado etiqueta="Comparar por" rotulo="Por" valor={analisisMode} onChange={setAnalisisMode}
              opciones={[['empaque', 'Empaque', 'Precio de la caja'], ['unidosis', 'Unidad', 'Precio por tableta, ml o g']]} />
          </>
        )}
      />

      {/* 1. Simulacion */}
      <section className="m3-card-outlined p-5 space-y-5" aria-labelledby="sim-titulo">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
          <div>
            <h2 id="sim-titulo" className="m3-title-medium text-on-surface">Simula un cambio de tus precios</h2>
            <p className="m3-body-small text-on-surface-variant mt-0.5">Mueve el control para subir o bajar todos tus precios a la vez y mira cómo cambia tu posición frente a la competencia de hoy.</p>
          </div>
          <button type="button" onClick={handleGenerarReporte} className="m3-btn-primary h-10 px-5 self-start">
            <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">description</span>
            Generar reporte
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] gap-5">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <label htmlFor="sim-variacion" className="m3-label-large text-on-surface-variant">Cambio de tus precios</label>
              <span className={`m3-title-large tabular-nums ${simulacionVariacion > 0 ? 'text-error' : simulacionVariacion < 0 ? 'text-[color:var(--md-sys-color-data-positive)]' : 'text-on-surface'}`}>
                {simulacionVariacion > 0 ? '+' : ''}{simulacionVariacion} %
              </span>
            </div>
            <input id="sim-variacion" type="range" min="-30" max="30" step="1" value={simulacionVariacion}
              onChange={e => setSimulacionVariacion(parseInt(e.target.value, 10))} className="w-full accent-primary cursor-pointer" />
            <div className="flex flex-wrap gap-2" role="group" aria-label="Escenarios">
              {ESCENARIOS.map(([v, t]) => (
                <button key={v} type="button" onClick={() => setSimulacionVariacion(v)} aria-pressed={simulacionVariacion === v}
                  className={`m3-choice-chip ${simulacionVariacion === v ? 'is-selected' : ''}`}>{t}</button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard compacto label="Tu precio frente al mercado" icon="speed" tono="primary"
              value={simulatedStats.simGlobalIpr ? `${simulatedStats.simGlobalIpr.toFixed(1)} %` : '—'}
              hint={`Hoy: ${kpiStats.globalIpr ? `${kpiStats.globalIpr.toFixed(1)} %` : '—'} · 100 % = igual al promedio`} />
            <StatCard compacto label="Productos donde eres el más barato" icon="leaderboard"
              value={`${simulatedStats.porcentajeLiderazgoSim} %`}
              hint={`Hoy: ${kpiStats.porcentajeLiderazgoPropio} %`} />
            <StatCard compacto label="Distancia al más barato" icon="unfold_more"
              tono={simulacionVariacion > 12 ? 'negative' : simulacionVariacion < 0 ? 'positive' : 'neutral'}
              value={`${simulatedStats.brechaPromedioVsMinSim.toFixed(1)} %`}
              hint={simulacionVariacion > 12 ? 'Riesgo alto de perder ventas' : simulacionVariacion > 0 ? 'Más margen, menos volumen' : simulacionVariacion < 0 ? 'Más volumen, menos margen' : 'Sin cambios'} />
          </div>
        </div>

        {reporteGenerado && (
          <Reporte reporte={reporteGenerado} tab={activeReportTab} onTab={setActiveReportTab} fmt={fmt} fmtBs={fmtBs}
            onCopiar={handleCopiarReporte} onDescargar={handleDescargarReporteTxt} onCerrar={() => setReporteGenerado(null)} />
        )}
      </section>

      {/* 2. Unidades de negocio */}
      <section className="space-y-3" aria-labelledby="un-titulo">
        <div>
          <h2 id="un-titulo" className="m3-title-medium text-on-surface">Por unidad de negocio</h2>
          <p className="m3-body-small text-on-surface-variant mt-0.5">Cuánto se aleja tu precio del promedio y del más barato, en promedio, en cada línea.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {analisisUnidadNegocio.map(item => (
            <article key={item.un} className="m3-card-outlined p-4 flex flex-col gap-3 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="m3-title-small text-on-surface">{item.un === 'La Sante' ? 'La Santé' : item.un}</h3>
                <span className="m3-etiqueta">{item.totalProductos} productos</span>
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 m3-body-small">
                <dt className="text-on-surface-variant">Frente al promedio</dt>
                <dd className={`tabular-nums font-medium text-right ${tonoDif(item.avgDiffAvg || null)}`}>{item.avgDiffAvg ? pctTxt(item.avgDiffAvg) : '—'}</dd>
                <dt className="text-on-surface-variant">Frente al más barato</dt>
                <dd className="tabular-nums font-medium text-right text-on-surface">{item.avgDiffMin ? pctTxt(item.avgDiffMin) : '—'}</dd>
                {item.brandPremiumAvg > 0 && (
                  <>
                    <dt className="text-on-surface-variant">Marca sobre genérico</dt>
                    <dd className="tabular-nums font-medium text-right text-on-surface">+{item.brandPremiumAvg.toFixed(0)} %</dd>
                  </>
                )}
              </dl>
              {item.recomendaciones.length > 0 && (
                <ul className="space-y-2 pt-3 border-t border-outline-variant">
                  {item.recomendaciones.map((rec, idx) => (
                    <li key={idx} className="flex gap-2 m3-body-small">
                      <span className={`material-symbols-outlined text-[18px] shrink-0 ${rec.tipo === 'bajar_precios' || rec.tipo === 'urgente' ? 'text-error' : rec.tipo === 'subir_precios' ? 'text-[color:var(--md-sys-color-data-positive)]' : 'text-on-surface-variant'}`} aria-hidden="true">
                        {rec.tipo === 'subir_precios' ? 'arrow_upward' : rec.tipo === 'bajar_precios' ? 'arrow_downward' : rec.tipo === 'urgente' ? 'priority_high' : 'info'}
                      </span>
                      <span className="min-w-0"><strong className="font-medium text-on-surface">{rec.titulo}</strong><span className="block text-on-surface-variant">{rec.detalle}</span></span>
                    </li>
                  ))}
                </ul>
              )}
              {item.alertas.length > 0 && (
                <p className="m3-etiqueta is-error self-start whitespace-normal">{item.alertas[0]}</p>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* 3. Graficos (no se redibujan al mover el deslizador) */}
      <GraficoBrechas datos={priceGapData} tasa={bcv.rate} />
      <MatrizPosicion datos={scatterPlotData} onElegir={elegirProducto} />

      {/* 4. Por cadena */}
      {cadenaComparacionCostos && cadenaComparacionCostos.ranking.length > 0 && (
        <section className="space-y-3" aria-labelledby="cad-titulo">
          <div>
            <h2 id="cad-titulo" className="m3-title-medium text-on-surface">Dónde son más caros tus productos</h2>
            <p className="m3-body-small text-on-surface-variant mt-0.5">Por cadena: cuánto se aleja tu precio, en promedio, de lo que cuesta allí lo comparable.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {cadenaComparacionCostos.ranking.map(item => {
              const caro = item.avgDiff > 0;
              return (
                <article key={item.cadena} className="m3-card-outlined p-4 space-y-2 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 m3-title-small text-on-surface min-w-0"><CadenaBadge cadena={item.cadena} tamano="xs" title="" /><span className="truncate">{nombreCadena(item.cadena)}</span></span>
                    <span className={`m3-title-small tabular-nums ${caro ? 'text-error' : 'text-[color:var(--md-sys-color-data-positive)]'}`}>{pctTxt(item.avgDiff)}</span>
                  </div>
                  <p className="m3-body-small text-on-surface-variant">
                    {item.count} productos comparados · {caro ? `${item.masCostososCount} por encima` : `${item.masBaratosCount} por debajo`}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {shareOfVoiceData.length > 0 && (
        <section className="space-y-3" aria-labelledby="sov-titulo">
          <div>
            <h2 id="sov-titulo" className="m3-title-medium text-on-surface">Qué cadena tiene el precio más bajo</h2>
            <p className="m3-body-small text-on-surface-variant mt-0.5">De tus productos vigilados en cada cadena, en cuántos esa cadena tiene el precio más bajo o el más alto del mercado.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {shareOfVoiceData.map(ch => (
              <article key={ch.cadena} className="m3-card-outlined p-4 space-y-2.5 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 m3-title-small text-on-surface min-w-0"><CadenaBadge cadena={ch.cadena} tamano="xs" title="" /><span className="truncate">{nombreCadena(ch.cadena)}</span></span>
                  <span className="m3-etiqueta">{ch.skusMonitoreados} productos</span>
                </div>
                <div className="flex justify-between m3-body-small"><span className="text-on-surface-variant">Precio más bajo</span><span className="tabular-nums font-medium">{ch.cheapestSoVPct.toFixed(0)} %</span></div>
                <div className="m3-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ch.cheapestSoVPct)}>
                  <div style={{ width: `${Math.min(100, ch.cheapestSoVPct)}%` }} />
                </div>
                <p className="m3-body-small text-on-surface-variant tabular-nums">{ch.lowestCount} más baratos · {ch.highestCount} más caros</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {elasticidadPorMolecula.length > 0 && (
        <section className="m3-data-table" aria-labelledby="ela-titulo">
          <div className="m3-data-table-toolbar">
            <h2 id="ela-titulo" className="m3-title-medium text-on-surface">Sensibilidad al precio por molécula</h2>
            <p className="m3-body-small text-on-surface-variant mt-0.5">Mercados con precios muy dispersos o que cambian mucho reaccionan más a una subida. Es una estimación a partir de los precios de hoy y de ayer.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table">
              <thead className="m3-sticky-header">
                <tr>
                  <th>Molécula</th>
                  <th className="text-right">Productos</th>
                  <th className="text-right">Dispersión</th>
                  <th className="text-right">Cambio de ayer</th>
                  <th>Sensibilidad</th>
                  <th>Qué significa</th>
                </tr>
              </thead>
              <tbody>
                {elasticidadPorMolecula.map(m => (
                  <tr key={m.nombre}>
                    <td className="m3-cell-primary">{m.nombre}</td>
                    <td className="text-right tabular-nums">{m.totalSkus} <span className="m3-cell-secondary">({m.marcasCount} marca · {m.genericosCount} gen.)</span></td>
                    <td className="text-right tabular-nums">{m.avgDispersion.toFixed(1)} %</td>
                    <td className="text-right tabular-nums">{m.avgVolatilidad > 0 ? `${m.avgVolatilidad.toFixed(1)} %` : 'Sin cambio'}</td>
                    <td><span className={`m3-etiqueta ${m.badgeClass}`}>{m.badgeClass === 'is-error' ? 'Alta' : m.badgeClass === 'is-primary' ? 'Baja' : 'Media'}</span></td>
                    <td className="m3-body-small text-on-surface-variant">{m.recomendacion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedProduct && (
        <ProductDetailModal
          producto={selectedProduct.producto}
          competencia={selectedProduct.competencia}
          currency="usd"
          bcvRate={bcv.rate}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

// Texto con **negritas** sin HTML inyectado.
function ConNegritas({ texto }) {
  return String(texto || '').split('**').map((t, i) => (i % 2 ? <strong key={i} className="font-medium text-on-surface">{t}</strong> : <span key={i}>{t}</span>));
}

function Reporte({ reporte: r, tab, onTab, fmt, fmtBs, onCopiar, onDescargar, onCerrar }) {
  const n = r.oportunidadesSubir.length + r.oportunidadesBajar.length;
  const Fila = ({ o, subir }) => (
    <li className="py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 sm:gap-4">
      <div className="min-w-0">
        <div className="m3-body-medium font-medium text-on-surface">{o.nombre} <span className="m3-cell-secondary">· {o.id}</span></div>
        <p className="m3-body-small text-on-surface-variant mt-0.5"><ConNegritas texto={o.recomendacion} /></p>
      </div>
      <div className="sm:text-right m3-body-small tabular-nums whitespace-nowrap">
        <div className="text-on-surface-variant">Hoy {fmt(o.precioPropio)} · promedio {fmt(o.precioPromedio)}</div>
        <div className={`font-medium ${subir ? 'text-[color:var(--md-sys-color-data-positive)]' : 'text-error'}`}>
          Sugerido {fmt(o.precioSugeridoUsd)} ({subir ? `+${o.incrementoPct}` : `−${o.descuentoPct}`} %) · {fmtBs(o.precioSugeridoUsd)}
        </div>
      </div>
    </li>
  );
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-low overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <span className="m3-title-small text-on-surface">Reporte de precios · <span className="text-on-surface-variant font-normal">{r.fecha}</span></span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onCopiar} className="m3-btn-text"><span className="material-symbols-outlined" aria-hidden="true">content_copy</span>Copiar</button>
          <button type="button" onClick={onDescargar} className="m3-btn-text"><span className="material-symbols-outlined" aria-hidden="true">download</span>Descargar</button>
          <button type="button" onClick={onCerrar} className="m3-icon-btn" aria-label="Cerrar el reporte"><span className="material-symbols-outlined">close</span></button>
        </div>
      </div>
      <nav className="m3-tabs px-2" aria-label="Partes del reporte">
        {[['ejecutivo', 'Resumen'], ['oportunidades', `Ajustes sugeridos (${n})`], ['margen', 'Efecto de la simulación']].map(([id, t]) => (
          <button key={id} type="button" onClick={() => onTab(id)} aria-current={tab === id ? 'page' : undefined} className={`m3-tab ${tab === id ? 'is-active' : ''}`}>{t}</button>
        ))}
      </nav>
      <div className="px-4 py-3 m3-body-medium text-on-surface-variant max-h-96 overflow-y-auto">
        {tab === 'ejecutivo' && <p><ConNegritas texto={r.resumenEjecutivo} /></p>}
        {tab === 'oportunidades' && (
          n === 0 ? <p>No hay productos lejos del promedio del mercado (más de 12 % por encima o por debajo).</p> : (
            <div className="space-y-4">
              {r.oportunidadesSubir.length > 0 && (
                <div>
                  <h3 className="m3-title-small text-on-surface">Más baratos que el mercado: podrías subir</h3>
                  <ul className="divide-y divide-outline-variant">{r.oportunidadesSubir.map(o => <Fila key={o.id} o={o} subir />)}</ul>
                </div>
              )}
              {r.oportunidadesBajar.length > 0 && (
                <div>
                  <h3 className="m3-title-small text-on-surface">Más caros que el mercado: riesgo de perder ventas</h3>
                  <ul className="divide-y divide-outline-variant">{r.oportunidadesBajar.map(o => <Fila key={o.id} o={o} />)}</ul>
                </div>
              )}
            </div>
          )
        )}
        {tab === 'margen' && (
          <div className="space-y-2">
            <p><ConNegritas texto={r.estrategiaElasticidad} /></p>
            <p className="m3-body-small">Los efectos sobre el volumen son estimaciones generales, no datos de tus ventas.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const fmtUsd = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Cuanto se aleja tu precio del promedio, producto por producto. Memo: no
// depende del deslizador, asi que no se redibuja al moverlo.
const GraficoBrechas = memo(function GraficoBrechas({ datos, tasa }) {
  const tg = tokensGrafico();
  const muchos = datos.length > 30;
  return (
    <section className="m3-card-outlined p-5 space-y-3" aria-labelledby="bre-titulo">
      <div>
        <h2 id="bre-titulo" className="m3-title-medium text-on-surface">Cuánto se aleja tu precio del promedio</h2>
        <p className="m3-body-small text-on-surface-variant mt-0.5">Cada barra es un producto, del más barato al más caro frente al promedio del mercado. Pasa el cursor para ver cuál es.</p>
      </div>
      <div className="h-72">
        {datos.length === 0 ? (
          <p className="h-full flex items-center justify-center m3-body-medium text-on-surface-variant">Aún no hay productos con tu precio y competencia.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={datos} margin={{ top: 8, right: 8, left: -12, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={tg.rejilla} vertical={false} />
              <XAxis dataKey="name" tick={muchos ? false : { fontSize: 10, fill: tg.eje }} interval={0} height={muchos ? 8 : 40} />
              <YAxis tick={{ fontSize: 11, fill: tg.eje }} tickFormatter={(v) => `${v}%`} />
              <Tooltip cursor={{ fill: tg.rejilla, opacity: 0.4 }} content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="m3-card-outlined p-3 m3-body-small space-y-0.5 max-w-xs" style={{ background: tg.superficie }}>
                    <div className="font-medium text-on-surface">{d.fullName}</div>
                    <div className="text-on-surface-variant tabular-nums">Tu precio {fmtUsd(d.propioPrice)} · Bs {(d.propioPrice * (tasa || 0)).toLocaleString('es-VE', { maximumFractionDigits: 2 })}</div>
                    <div className="text-on-surface-variant tabular-nums">Promedio {fmtUsd(d.avgComp)}</div>
                    <div className={`font-medium tabular-nums ${d.gap < 0 ? 'text-[color:var(--md-sys-color-data-positive)]' : 'text-error'}`}>{d.gap > 0 ? '+' : ''}{d.gap} %</div>
                  </div>
                );
              }} />
              <ReferenceLine y={0} stroke={tg.eje} />
              <Bar dataKey="gap" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                {datos.map((d, i) => <Cell key={i} fill={d.gap < 0 ? tg.positivo : tg.negativo} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
});

// Tu precio (vertical) frente al promedio del mercado (horizontal). Debajo de
// la diagonal eres mas barato. Toca un punto para abrir la ficha.
const MatrizPosicion = memo(function MatrizPosicion({ datos, onElegir }) {
  const tg = tokensGrafico();
  if (!datos.length) return null;
  return (
    <section className="m3-card-outlined p-5 space-y-3" aria-labelledby="mat-titulo">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div>
          <h2 id="mat-titulo" className="m3-title-medium text-on-surface">Tu precio frente al promedio del mercado</h2>
          <p className="m3-body-small text-on-surface-variant mt-0.5">Cada punto es un producto. Toca uno para abrir su ficha.</p>
        </div>
        <div className="flex flex-wrap gap-3 m3-body-small text-on-surface-variant">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tg.positivo }} />Más barato que el promedio</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tg.negativo }} />Más caro</span>
        </div>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, bottom: 24, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={tg.rejilla} />
            <XAxis type="number" dataKey="x" name="Promedio del mercado" unit=" $" tick={{ fontSize: 11, fill: tg.eje }}
              label={{ value: 'Promedio del mercado ($)', position: 'bottom', offset: 6, fontSize: 12, fill: tg.eje }} />
            <YAxis type="number" dataKey="y" name="Tu precio" unit=" $" tick={{ fontSize: 11, fill: tg.eje }}
              label={{ value: 'Tu precio ($)', angle: -90, position: 'insideLeft', offset: 12, fontSize: 12, fill: tg.eje }} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              return (
                <div className="m3-card-outlined p-3 m3-body-small space-y-0.5 max-w-xs" style={{ background: tg.superficie }}>
                  <div className="font-medium text-on-surface">{d.name}</div>
                  <div className="text-on-surface-variant tabular-nums">Tu precio {fmtUsd(d.y)} · promedio {fmtUsd(d.x)}</div>
                  <div className={`font-medium tabular-nums ${d.diffAvgPercent > 0 ? 'text-error' : 'text-[color:var(--md-sys-color-data-positive)]'}`}>{d.diffAvgPercent > 0 ? '+' : ''}{d.diffAvgPercent} % · lugar {d.ranking || '—'} de {d.totalOptions}</div>
                </div>
              );
            }} />
            <Scatter data={datos} onClick={onElegir} isAnimationActive={false}>
              {datos.map((d, i) => <Cell key={i} fill={d.y < d.x ? tg.positivo : tg.negativo} className="cursor-pointer" />)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});
