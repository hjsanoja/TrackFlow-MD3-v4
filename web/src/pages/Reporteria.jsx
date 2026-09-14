import { useState, useMemo } from 'react';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';
import { exportToCSV, copyTextToClipboard } from '../utils/exportUtils';
import { getChainColor, getLabColor, getBrandBgTint } from '../utils/brandColors';
import { useToast } from '../context/ToastContext';

export default function Reporteria({ user, userDoc }) {
  const { productos = [], productosCompetencia = [], cadenas = [], loadingInitial } = useData();
  const bcv = useBcvRate();
  const { addToast } = useToast();

  const currentBcvRate = bcv?.rate || 744.23;

  // Filtros interactivos
  const [searchTerm, setSearchTerm] = useState('');
  const [filtroCadena, setFiltroCadena] = useState('todas');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroCategoria, setFiltroCategoria] = useState('todas');
  const [filtroLaboratorio, setFiltroLaboratorio] = useState('todos');
  const [filtroBrecha, setFiltroBrecha] = useState('todos'); // 'todos', 'mas_caro', 'mas_barato', 'paridad'
  const [vistaBrecha, setVistaBrecha] = useState('ambas'); // 'ambas', 'desc', 'full'
  const [incluirSinCompetencia, setIncluirSinCompetencia] = useState(false);
  
  // Paginación
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);

  // Mapa rápido de productos propios O(1)
  const prodMap = useMemo(() => {
    const map = new Map();
    productos.forEach(p => {
      const key = String(p.id_interno || p.id || '').trim();
      if (key) map.set(key, p);
    });
    return map;
  }, [productos]);

  // Agrupación de items por ID de producto propio para calcular la referencia "Mi marca" por cada ID
  const baseMiMarcaMap = useMemo(() => {
    const map = new Map();

    // 1. Inicializar con PVP propio registrado en el maestro de productos
    productos.forEach(p => {
      const idKey = String(p.id_interno || p.id || '').trim();
      if (!idKey) return;
      const pvpUsd = Number(p.pvp_propio_usd) || 0;
      map.set(idKey, {
        fuente: 'pvp_maestro',
        fullUsd: pvpUsd,
        descUsd: pvpUsd,
        fullBs: pvpUsd * currentBcvRate,
        descBs: pvpUsd * currentBcvRate,
        laboratorio: p.laboratorio || p.fabricante || 'La Santé'
      });
    });

    // 2. Si existe un enlace de tipo 'propio' en productosCompetencia con precio extraído, usarlo como referencia principal
    (productosCompetencia || []).forEach(comp => {
      if (comp.activo === false || comp.tipo !== 'propio') return;
      const idKey = String(comp.id_producto_propio || '').trim();
      if (!idKey) return;

      const pFullBs = comp.ultimo_precio_full_bs != null && comp.ultimo_precio_full_bs > 0 ? Number(comp.ultimo_precio_full_bs) : null;
      const pDescBs = comp.ultimo_precio_desc_bs != null && comp.ultimo_precio_desc_bs > 0 ? Number(comp.ultimo_precio_desc_bs) : pFullBs;

      if (pFullBs || pDescBs) {
        const fullUsd = pFullBs ? pFullBs / currentBcvRate : (pDescBs ? pDescBs / currentBcvRate : 0);
        const descUsd = pDescBs ? pDescBs / currentBcvRate : fullUsd;
        
        map.set(idKey, {
          fuente: 'enlace_propio_scraped',
          fullUsd,
          descUsd,
          fullBs: pFullBs || (pDescBs || 0),
          descBs: pDescBs || pFullBs || 0,
          laboratorio: comp.laboratorio || comp.fabricante || comp.marca || 'Mi Marca'
        });
      }
    });

    return map;
  }, [productos, productosCompetencia, currentBcvRate]);

  // Lista de categorías únicas
  const categorias = useMemo(() => {
    const set = new Set();
    productos.forEach(p => {
      if (p.categoria) set.add(p.categoria);
    });
    return ['todas', ...Array.from(set).sort()];
  }, [productos]);

  // Lista de laboratorios / fabricantes únicos del formulario de competencia
  const laboratoriosCompetencia = useMemo(() => {
    const set = new Set();
    (productosCompetencia || []).forEach(comp => {
      const lab = (comp.laboratorio || comp.fabricante || comp.marca || '').trim();
      if (lab) set.add(lab);
    });
    productos.forEach(p => {
      if (p.laboratorio) set.add(p.laboratorio);
    });
    return ['todos', ...Array.from(set).sort()];
  }, [productosCompetencia, productos]);

  // Construcción del Dataset de Reportería
  const datasetReporte = useMemo(() => {
    const rows = [];
    const processedProductIds = new Set();

    (productosCompetencia || []).forEach((comp, idx) => {
      if (comp.activo === false) return;
      const idPropio = String(comp.id_producto_propio || '').trim();
      const prodPropio = prodMap.get(idPropio) || {};
      processedProductIds.add(idPropio);

      // Referencia base "Mi marca" para este ID específico
      const refMiMarca = baseMiMarcaMap.get(idPropio) || {
        fullUsd: Number(prodPropio.pvp_propio_usd) || 0,
        descUsd: Number(prodPropio.pvp_propio_usd) || 0,
        fullBs: (Number(prodPropio.pvp_propio_usd) || 0) * currentBcvRate,
        descBs: (Number(prodPropio.pvp_propio_usd) || 0) * currentBcvRate,
        laboratorio: prodPropio.laboratorio || 'Mi Marca'
      };

      const pFullBs = comp.ultimo_precio_full_bs != null && comp.ultimo_precio_full_bs > 0 ? Number(comp.ultimo_precio_full_bs) : null;
      const pDescBs = comp.ultimo_precio_desc_bs != null && comp.ultimo_precio_desc_bs > 0 ? Number(comp.ultimo_precio_desc_bs) : null;

      const pFullUsd = pFullBs ? pFullBs / currentBcvRate : null;
      const pDescUsd = pDescBs ? pDescBs / currentBcvRate : null;

      // Laboratorio / Fabricante específico de la tabla de competencias (formulario Vincular Enlace)
      const labFabricanteSku = (comp.laboratorio || comp.fabricante || (comp.tipo === 'propio' ? (prodPropio.laboratorio || 'La Santé') : comp.marca) || '—').trim();

      const isMiMarca = comp.tipo === 'propio';

      // Cálculo de la brecha en dólares vs Mi Marca por cada ID
      let brechaFullPct = null;
      if (isMiMarca) {
        brechaFullPct = 0;
      } else if (refMiMarca.fullUsd > 0 && pFullUsd != null) {
        brechaFullPct = ((pFullUsd - refMiMarca.fullUsd) / refMiMarca.fullUsd) * 100;
      }

      let brechaDescPct = null;
      if (isMiMarca) {
        brechaDescPct = 0;
      } else if (refMiMarca.descUsd > 0 && pDescUsd != null) {
        brechaDescPct = ((pDescUsd - refMiMarca.descUsd) / refMiMarca.descUsd) * 100;
      } else if (refMiMarca.descUsd > 0 && pFullUsd != null) {
        brechaDescPct = ((pFullUsd - refMiMarca.descUsd) / refMiMarca.descUsd) * 100;
      }

      // Brecha primaria para ordenamiento y badges (prioriza descuento, si no full)
      const brechaPrimaria = brechaDescPct !== null ? brechaDescPct : brechaFullPct;

      let estadoBrecha = 'Sin precio';
      let estadoBrechaClase = 'neutral';
      if (isMiMarca) {
        estadoBrecha = 'Mi marca (Base 100%)';
        estadoBrechaClase = 'propio';
      } else if (brechaPrimaria !== null) {
        if (brechaPrimaria > 3) {
          estadoBrecha = `Competidor +${brechaPrimaria.toFixed(1)}% (Más caro)`;
          estadoBrechaClase = 'mas_caro';
        } else if (brechaPrimaria < -3) {
          estadoBrecha = `Competidor ${brechaPrimaria.toFixed(1)}% (Más barato / Ventaja)`;
          estadoBrechaClase = 'mas_barato';
        } else {
          estadoBrecha = `En paridad (${brechaPrimaria >= 0 ? '+' : ''}${brechaPrimaria.toFixed(1)}%)`;
          estadoBrechaClase = 'paridad';
        }
      }

      rows.push({
        uid: comp.id || `comp_${idx}`,
        id_producto_propio: idPropio || prodPropio.id_interno || prodPropio.id || 'N/A',
        producto_propio: prodPropio.nombre || 'Producto no identificado',
        laboratorio_fabricante: labFabricanteSku,
        cadena_competidor: comp.cadena || '—',
        marca_linea: comp.marca || comp.linea || comp.nombre_competidor || '—',
        tipo_raw: comp.tipo || 'alternativa',
        tipo: isMiMarca ? 'Mi marca' : 'Alternativa',
        is_mi_marca: isMiMarca,
        precio_full_bs: pFullBs,
        precio_desc_bs: pDescBs,
        precio_full_usd: pFullUsd,
        precio_desc_usd: pDescUsd,
        ref_mi_marca_full_usd: refMiMarca.fullUsd,
        ref_mi_marca_desc_usd: refMiMarca.descUsd,
        brecha_full_pct: brechaFullPct,
        brecha_desc_pct: brechaDescPct,
        brecha_primaria: brechaPrimaria,
        estado_brecha: estadoBrecha,
        estado_brecha_clase: estadoBrechaClase,
        categoria: prodPropio.categoria || 'Sin categoría',
        principio_activo: prodPropio.principio_activo || '—',
        url: comp.url || ''
      });
    });

    // Opcional: incluir productos propios sin enlaces de competencia
    if (incluirSinCompetencia) {
      productos.forEach((p, idx) => {
        const idPropio = String(p.id_interno || p.id || '').trim();
        if (!processedProductIds.has(idPropio)) {
          const pvpPropioUsd = Number(p.pvp_propio_usd) || 0;
          rows.push({
            uid: `unmapped_${p.id || idx}`,
            id_producto_propio: idPropio,
            producto_propio: p.nombre || '—',
            laboratorio_fabricante: p.laboratorio || p.fabricante || 'La Santé',
            cadena_competidor: 'Sin enlaces',
            marca_linea: '—',
            tipo_raw: 'propio',
            tipo: 'Mi marca',
            is_mi_marca: true,
            precio_full_bs: pvpPropioUsd * currentBcvRate,
            precio_desc_bs: null,
            precio_full_usd: pvpPropioUsd,
            precio_desc_usd: null,
            ref_mi_marca_full_usd: pvpPropioUsd,
            ref_mi_marca_desc_usd: pvpPropioUsd,
            brecha_full_pct: 0,
            brecha_desc_pct: 0,
            brecha_primaria: 0,
            estado_brecha: 'Mi marca (Base 100%)',
            estado_brecha_clase: 'propio',
            categoria: p.categoria || 'Sin categoría',
            principio_activo: p.principio_activo || '—',
            url: ''
          });
        }
      });
    }

    // Ordenar de forma natural por ID de producto propio y luego poniendo 'Mi marca' primero en cada grupo
    return rows.sort((a, b) => {
      const compId = a.id_producto_propio.localeCompare(b.id_producto_propio, undefined, { numeric: true });
      if (compId !== 0) return compId;
      if (a.is_mi_marca && !b.is_mi_marca) return -1;
      if (!a.is_mi_marca && b.is_mi_marca) return 1;
      return (a.cadena_competidor || '').localeCompare(b.cadena_competidor || '');
    });
  }, [productosCompetencia, prodMap, baseMiMarcaMap, productos, currentBcvRate, incluirSinCompetencia]);

  // Filtrado reactivo en memoria
  const rowsFiltradas = useMemo(() => {
    const term = searchTerm.toLowerCase().trim();

    return datasetReporte.filter(row => {
      if (filtroCadena !== 'todas' && row.cadena_competidor !== filtroCadena) return false;
      if (filtroTipo !== 'todos' && row.tipo_raw !== filtroTipo) return false;
      if (filtroCategoria !== 'todas' && row.categoria !== filtroCategoria) return false;
      if (filtroLaboratorio !== 'todos' && row.laboratorio_fabricante !== filtroLaboratorio) return false;
      
      if (filtroBrecha === 'mas_caro' && row.estado_brecha_clase !== 'mas_caro') return false;
      if (filtroBrecha === 'mas_barato' && row.estado_brecha_clase !== 'mas_barato') return false;
      if (filtroBrecha === 'paridad' && row.estado_brecha_clase !== 'paridad') return false;

      if (!term) return true;
      return (
        row.id_producto_propio.toLowerCase().includes(term) ||
        row.producto_propio.toLowerCase().includes(term) ||
        row.laboratorio_fabricante.toLowerCase().includes(term) ||
        row.cadena_competidor.toLowerCase().includes(term) ||
        row.marca_linea.toLowerCase().includes(term) ||
        row.categoria.toLowerCase().includes(term) ||
        row.principio_activo.toLowerCase().includes(term)
      );
    });
  }, [datasetReporte, searchTerm, filtroCadena, filtroTipo, filtroCategoria, filtroLaboratorio, filtroBrecha]);

  // Resumen de Métricas de Inteligencia
  const metricas = useMemo(() => {
    const totalRegistros = rowsFiltradas.length;
    const masCaros = rowsFiltradas.filter(r => r.estado_brecha_clase === 'mas_caro').length;
    const masBaratos = rowsFiltradas.filter(r => r.estado_brecha_clase === 'mas_barato').length;
    const enParidad = rowsFiltradas.filter(r => r.estado_brecha_clase === 'paridad').length;

    const brechasValidas = rowsFiltradas
      .filter(r => r.brecha_primaria !== null && !r.is_mi_marca)
      .map(r => r.brecha_primaria);
    
    const brechaPromedio = brechasValidas.length > 0
      ? brechasValidas.reduce((a, b) => a + b, 0) / brechasValidas.length
      : 0;

    return {
      totalRegistros,
      masCaros,
      masBaratos,
      enParidad,
      brechaPromedio
    };
  }, [rowsFiltradas]);

  // Paginación
  const totalPages = Math.ceil(rowsFiltradas.length / itemsPerPage) || 1;
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return rowsFiltradas.slice(start, start + itemsPerPage);
  }, [rowsFiltradas, currentPage, itemsPerPage]);

  // Generador de Exportación CSV con UTF-8 BOM
  const handleExportCSV = () => {
    if (rowsFiltradas.length === 0) {
      addToast('No hay datos disponibles para exportar con los filtros actuales.', 'warning');
      return;
    }

    const headers = [
      { key: 'id_producto_propio', label: 'ID Producto Propio' },
      { key: 'producto_propio', label: 'Producto Propio' },
      { key: 'laboratorio_fabricante', label: 'Laboratorio / Fabricante' },
      { key: 'cadena_competidor', label: 'Cadena/Competidor' },
      { key: 'marca_linea', label: 'Marca/Línea' },
      { key: 'tipo', label: 'Tipo' },
      { key: 'precio_full_bs_fmt', label: 'Precio Full (Bs)' },
      { key: 'precio_desc_bs_fmt', label: 'Precio Desc (Bs)' },
      { key: 'precio_full_usd_fmt', label: 'Precio Full (USD)' },
      { key: 'precio_desc_usd_fmt', label: 'Precio Desc (USD)' },
      { key: 'ref_mi_marca_full_usd_fmt', label: 'Mi Marca Full Ref (USD)' },
      { key: 'ref_mi_marca_desc_usd_fmt', label: 'Mi Marca Desc Ref (USD)' },
      { key: 'brecha_full_pct_fmt', label: 'Brecha Full vs Mi Marca (%)' },
      { key: 'brecha_desc_pct_fmt', label: 'Brecha Desc vs Mi Marca (%)' },
      { key: 'estado_brecha', label: 'Estado Brecha' },
      { key: 'tasa_bcv_aplicada', label: 'Tasa BCV (Bs/USD)' }
    ];

    const exportRows = rowsFiltradas.map(r => ({
      id_producto_propio: r.id_producto_propio,
      producto_propio: r.producto_propio,
      laboratorio_fabricante: r.laboratorio_fabricante,
      cadena_competidor: r.cadena_competidor,
      marca_linea: r.marca_linea,
      tipo: r.tipo,
      precio_full_bs_fmt: r.precio_full_bs != null ? r.precio_full_bs.toFixed(2) : '',
      precio_desc_bs_fmt: r.precio_desc_bs != null ? r.precio_desc_bs.toFixed(2) : '',
      precio_full_usd_fmt: r.precio_full_usd != null ? r.precio_full_usd.toFixed(2) : '',
      precio_desc_usd_fmt: r.precio_desc_usd != null ? r.precio_desc_usd.toFixed(2) : '',
      ref_mi_marca_full_usd_fmt: r.ref_mi_marca_full_usd > 0 ? r.ref_mi_marca_full_usd.toFixed(2) : '',
      ref_mi_marca_desc_usd_fmt: r.ref_mi_marca_desc_usd > 0 ? r.ref_mi_marca_desc_usd.toFixed(2) : '',
      brecha_full_pct_fmt: r.is_mi_marca ? '100% (Base)' : (r.brecha_full_pct != null ? `${r.brecha_full_pct >= 0 ? '+' : ''}${r.brecha_full_pct.toFixed(2)}%` : '—'),
      brecha_desc_pct_fmt: r.is_mi_marca ? '100% (Base)' : (r.brecha_desc_pct != null ? `${r.brecha_desc_pct >= 0 ? '+' : ''}${r.brecha_desc_pct.toFixed(2)}%` : '—'),
      estado_brecha: r.estado_brecha,
      tasa_bcv_aplicada: currentBcvRate.toFixed(2)
    }));

    exportToCSV('reporte_precios_brechas_por_id', headers, exportRows);
    addToast(`Reporte CSV exportado exitosamente (${exportRows.length} registros).`, 'success');
  };

  // Copiar tabla tabulada para Excel / Google Sheets
  const handleCopyTable = () => {
    if (rowsFiltradas.length === 0) {
      addToast('No hay registros para copiar.', 'warning');
      return;
    }

    const headers = [
      'ID Producto Propio',
      'Producto Propio',
      'Laboratorio / Fabricante',
      'Cadena/Competidor',
      'Marca/Línea',
      'Tipo',
      'Precio Full (Bs)',
      'Precio Desc (Bs)',
      'Precio Full (USD)',
      'Precio Desc (USD)',
      'Brecha Full vs Mi Marca (%)',
      'Brecha Desc vs Mi Marca (%)',
      'Estado Brecha'
    ];

    const lines = [headers.join('\t')];
    rowsFiltradas.forEach(r => {
      lines.push([
        r.id_producto_propio,
        r.producto_propio,
        r.laboratorio_fabricante,
        r.cadena_competidor,
        r.marca_linea,
        r.tipo,
        r.precio_full_bs != null ? r.precio_full_bs.toFixed(2) : '—',
        r.precio_desc_bs != null ? r.precio_desc_bs.toFixed(2) : '—',
        r.precio_full_usd != null ? `$${r.precio_full_usd.toFixed(2)}` : '—',
        r.precio_desc_usd != null ? `$${r.precio_desc_usd.toFixed(2)}` : '—',
        r.is_mi_marca ? '100%' : (r.brecha_full_pct != null ? `${r.brecha_full_pct >= 0 ? '+' : ''}${r.brecha_full_pct.toFixed(1)}%` : '—'),
        r.is_mi_marca ? '100%' : (r.brecha_desc_pct != null ? `${r.brecha_desc_pct >= 0 ? '+' : ''}${r.brecha_desc_pct.toFixed(1)}%` : '—'),
        r.estado_brecha
      ].join('\t'));
    });

    copyTextToClipboard(
      lines.join('\n'),
      () => addToast('Datos copiados al portapapeles en formato tabulado (listo para pegar en Excel).', 'success'),
      () => addToast('No se pudo copiar automáticamente al portapapeles.', 'error')
    );
  };

  return (
    <div className="space-y-6 pb-12 font-sans">
      {/* Banner de Identidad del Módulo de Reportería */}
      <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/25 rounded-3xl p-5 md:p-6 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-2xl bg-primary text-on-primary flex items-center justify-center shadow-xs">
                <span className="material-symbols-outlined text-xl">table_chart</span>
              </div>
              <h1 className="text-xl md:text-2xl font-display font-extrabold text-on-background tracking-tight">
                Módulo de Reportería
              </h1>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-wider bg-amber-500/20 text-amber-900 dark:text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                Submódulo Experimental
              </span>
            </div>
            <p className="text-xs text-on-surface-variant font-sans max-w-3xl leading-relaxed">
              Reporte comparativo por ID de producto propio. Evalúa la <strong>brecha porcentual en dólares de cada competidor (Calox, Genven, Leti, etc.) frente a tu marca (100% Base)</strong>, tanto a precio full como con descuento.
            </p>
          </div>

          {/* Botones de Exportación Primarios */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={handleCopyTable}
              className="h-10 px-4 rounded-full text-xs font-bold transition-all inline-flex items-center gap-2 border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-high active:scale-98 shadow-xs"
              title="Copiar datos al portapapeles en formato compatible con hojas de cálculo"
            >
              <span className="material-symbols-outlined text-[18px]">content_copy</span>
              <span>Copiar para Excel</span>
            </button>

            <button
              onClick={handleExportCSV}
              className="h-10 px-5 rounded-full text-xs font-bold transition-all inline-flex items-center gap-2 bg-primary text-on-primary hover:bg-primary/90 active:scale-98 shadow-elevation-1 font-display"
              title="Descargar archivo CSV estructurado con codificación UTF-8 BOM"
            >
              <span className="material-symbols-outlined text-[19px]">download</span>
              <span>Descargar Reporte CSV</span>
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards del Reporte */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-on-surface-variant uppercase tracking-wider">Registros</div>
          <div className="text-xl font-bold font-display text-on-surface mt-1">{metricas.totalRegistros}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Mapeos activos por SKU</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-on-surface-variant uppercase tracking-wider">Tasa BCV</div>
          <div className="text-xl font-bold font-display text-primary mt-1">{currentBcvRate.toFixed(2)}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Bs / USD Oficial</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-rose-700 dark:text-rose-400 uppercase tracking-wider">Competidor Más Caro</div>
          <div className="text-xl font-bold font-display text-rose-700 dark:text-rose-400 mt-1">{metricas.masCaros}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Tu marca tiene ventaja de precio</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">Competidor Más Barato</div>
          <div className="text-xl font-bold font-display text-emerald-700 dark:text-emerald-400 mt-1">{metricas.masBaratos}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">El competidor tiene ventaja</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-sky-700 dark:text-sky-400 uppercase tracking-wider">En Paridad</div>
          <div className="text-xl font-bold font-display text-sky-700 dark:text-sky-400 mt-1">{metricas.enParidad}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Diferencia dentro de ±3%</div>
        </div>
      </div>

      {/* Barra de Filtros y Configuración del Reporte */}
      <div className="bg-surface-container-lowest rounded-3xl border border-outline-variant/60 p-5 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-outline-variant/40">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">tune</span>
            <span className="text-sm font-bold font-display text-on-surface">Filtros y Parámetros del Reporte</span>
          </div>

          {/* Selector de visualización de columnas de brechas */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono font-semibold text-on-surface-variant">Columnas de Brecha:</span>
            <div className="inline-flex bg-surface-container-high rounded-full p-0.5 border border-outline-variant/60">
              <button
                onClick={() => setVistaBrecha('ambas')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  vistaBrecha === 'ambas'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Ambas (Full & Desc)
              </button>
              <button
                onClick={() => setVistaBrecha('desc')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  vistaBrecha === 'desc'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Solo Descuento
              </button>
              <button
                onClick={() => setVistaBrecha('full')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  vistaBrecha === 'full'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Solo Full / Lista
              </button>
            </div>
          </div>
        </div>

        {/* Fila de controles y filtros */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Búsqueda */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px] pointer-events-none">search</span>
            <input
              type="text"
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              placeholder="Buscar por ID, molécula, marca, lab..."
              className="m3-input pl-9 text-xs"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-sm w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-container">×</button>
            )}
          </div>

          {/* Cadena */}
          <div>
            <select
              value={filtroCadena}
              onChange={e => { setFiltroCadena(e.target.value); setCurrentPage(1); }}
              className="m3-select text-xs"
            >
              <option value="todas">Todas las cadenas ({cadenas.length})</option>
              {cadenas.map(c => (
                <option key={c.id || c.nombre} value={c.nombre}>{c.nombre}</option>
              ))}
            </select>
          </div>

          {/* Categoría */}
          <div>
            <select
              value={filtroCategoria}
              onChange={e => { setFiltroCategoria(e.target.value); setCurrentPage(1); }}
              className="m3-select text-xs"
            >
              {categorias.map(cat => (
                <option key={cat} value={cat}>
                  {cat === 'todas' ? 'Todas las categorías' : cat}
                </option>
              ))}
            </select>
          </div>

          {/* Laboratorio / Fabricante (de la tabla Competencias) */}
          <div>
            <select
              value={filtroLaboratorio}
              onChange={e => { setFiltroLaboratorio(e.target.value); setCurrentPage(1); }}
              className="m3-select text-xs"
            >
              {laboratoriosCompetencia.map(lab => (
                <option key={lab} value={lab}>
                  {lab === 'todos' ? 'Todos los laboratorios / fabricantes' : lab}
                </option>
              ))}
            </select>
          </div>

          {/* Estado de Brecha */}
          <div>
            <select
              value={filtroBrecha}
              onChange={e => { setFiltroBrecha(e.target.value); setCurrentPage(1); }}
              className="m3-select text-xs"
            >
              <option value="todos">Cualquier brecha</option>
              <option value="mas_caro">Competidores más caros (+)</option>
              <option value="mas_barato">Competidores más baratos (-) / Ventaja</option>
              <option value="paridad">En paridad (±3%)</option>
            </select>
          </div>
        </div>

        {/* Filtros secundarios y conteo */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-on-surface-variant">
          <div className="flex items-center gap-4 flex-wrap">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={incluirSinCompetencia}
                onChange={e => setIncluirSinCompetencia(e.target.checked)}
                className="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4 cursor-pointer"
              />
              <span className="font-medium text-on-surface">Incluir productos propios sin enlaces de competencia</span>
            </label>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px]">Tipo:</span>
              <div className="flex gap-1">
                {['todos', 'propio', 'alternativa'].map(t => (
                  <button
                    key={t}
                    onClick={() => { setFiltroTipo(t); setCurrentPage(1); }}
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border transition-all ${
                      filtroTipo === t
                        ? 'bg-primary border-primary text-on-primary'
                        : 'bg-surface-container-low border-outline-variant/60 text-on-surface-variant hover:bg-surface-container'
                    }`}
                  >
                    {t === 'todos' ? 'Todos' : t === 'propio' ? 'Mi marca' : 'Alternativa'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span>Mostrando <strong>{rowsFiltradas.length}</strong> de {datasetReporte.length} registros</span>
            {(searchTerm || filtroCadena !== 'todas' || filtroTipo !== 'todos' || filtroCategoria !== 'todas' || filtroLaboratorio !== 'todos' || filtroBrecha !== 'todos') && (
              <button
                onClick={() => {
                  setSearchTerm('');
                  setFiltroCadena('todas');
                  setFiltroTipo('todos');
                  setFiltroCategoria('todas');
                  setFiltroLaboratorio('todos');
                  setFiltroBrecha('todos');
                  setCurrentPage(1);
                }}
                className="text-primary hover:underline font-bold ml-1"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabla Principal del Reporte con Diseño Material 3 */}
      <div className="bg-surface-container-lowest rounded-3xl border border-outline-variant/60 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-low/80 border-b border-outline-variant/60 text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">ID Producto Propio</th>
                <th className="py-3 px-3.5 font-bold min-w-[190px]">Producto Propio</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap text-primary">Laboratorio / Fabricante (SKU)</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">Cadena / Competidor</th>
                <th className="py-3 px-3.5 font-bold min-w-[130px]">Marca / Línea</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">Tipo</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-surface-container/30">Precio Full (Bs)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-surface-container/30">Precio Desc (Bs)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-amber-500/10 text-amber-900 dark:text-amber-300">Precio Full ($)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-emerald-500/10 text-emerald-900 dark:text-emerald-300">Precio Desc ($)</th>
                
                {(vistaBrecha === 'ambas' || vistaBrecha === 'full') && (
                  <th className="py-3 px-3.5 font-bold text-center whitespace-nowrap bg-amber-500/15 text-amber-950 dark:text-amber-200">
                    Brecha Full vs Mi Marca (%)
                  </th>
                )}

                {(vistaBrecha === 'ambas' || vistaBrecha === 'desc') && (
                  <th className="py-3 px-3.5 font-bold text-center whitespace-nowrap bg-emerald-500/15 text-emerald-950 dark:text-emerald-200">
                    Brecha Desc vs Mi Marca (%)
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-on-surface font-sans">
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="text-center py-12 text-on-surface-variant">
                    <span className="material-symbols-outlined text-4xl block mx-auto mb-2 text-on-surface-variant/40">table_rows</span>
                    <p className="font-semibold text-sm">No se encontraron registros para los filtros seleccionados.</p>
                    <p className="text-xs mt-1 text-on-surface-variant/80">Prueba ajustando los criterios de búsqueda o limpiando los filtros.</p>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const chainColor = getChainColor(row.cadena_competidor);
                  const labColor = getLabColor(row.laboratorio_fabricante);

                  return (
                    <tr 
                      key={row.uid} 
                      className={`hover:bg-surface-container-high/40 transition-colors ${
                        row.is_mi_marca ? 'bg-primary/5 font-medium' : ''
                      }`}
                    >
                      {/* ID Producto Propio */}
                      <td className="py-3 px-3.5 font-mono font-bold text-primary whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded border ${
                          row.is_mi_marca 
                            ? 'bg-primary text-on-primary border-primary' 
                            : 'bg-primary-container/50 border-primary/20 text-primary'
                        }`}>
                          {row.id_producto_propio}
                        </span>
                      </td>

                      {/* Producto Propio */}
                      <td className="py-3 px-3.5 font-medium text-on-surface">
                        <div className="font-bold text-[13px]">{row.producto_propio}</div>
                        <div className="text-[10px] text-on-surface-variant font-mono">
                          {row.categoria} · {row.principio_activo}
                        </div>
                      </td>

                      {/* Laboratorio / Fabricante (del SKU / Competencia) */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span 
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border shadow-xs"
                          style={{
                            backgroundColor: getBrandBgTint(labColor),
                            borderColor: `${labColor}40`,
                            color: labColor
                          }}
                        >
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: labColor }}></span>
                          {row.laboratorio_fabricante}
                        </span>
                      </td>

                      {/* Cadena / Competidor */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span 
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold border"
                          style={{
                            backgroundColor: getBrandBgTint(chainColor),
                            borderColor: `${chainColor}40`,
                            color: chainColor
                          }}
                        >
                          {row.cadena_competidor}
                        </span>
                      </td>

                      {/* Marca / Línea */}
                      <td className="py-3 px-3.5 text-on-surface">
                        <div className="font-semibold">{row.marca_linea}</div>
                        {row.url && (
                          <a 
                            href={row.url} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5 mt-0.5"
                          >
                            <span>Ver enlace</span>
                            <span className="material-symbols-outlined text-[11px]">open_in_new</span>
                          </a>
                        )}
                      </td>

                      {/* Tipo */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          row.is_mi_marca
                            ? 'bg-emerald-600 text-white shadow-xs'
                            : 'bg-surface-container-high text-on-surface-variant border border-outline-variant/60'
                        }`}>
                          {row.tipo}
                        </span>
                      </td>

                      {/* Precio Full (Bs) */}
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap bg-surface-container/20">
                        {row.precio_full_bs != null ? `${row.precio_full_bs.toFixed(2)} Bs.` : '—'}
                      </td>

                      {/* Precio Desc (Bs) */}
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap bg-surface-container/20">
                        {row.precio_desc_bs != null ? (
                          <span className="font-bold text-emerald-700 dark:text-emerald-400">
                            {row.precio_desc_bs.toFixed(2)} Bs.
                          </span>
                        ) : '—'}
                      </td>

                      {/* Precio Full (USD) */}
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap bg-amber-500/5 font-semibold">
                        {row.precio_full_usd != null ? `$${row.precio_full_usd.toFixed(2)}` : '—'}
                      </td>

                      {/* Precio Desc (USD) */}
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap bg-emerald-500/5 font-bold">
                        {row.precio_desc_usd != null ? (
                          <span className="text-emerald-700 dark:text-emerald-400">
                            ${row.precio_desc_usd.toFixed(2)}
                          </span>
                        ) : '—'}
                      </td>

                      {/* Brecha Full vs Mi Marca (%) */}
                      {(vistaBrecha === 'ambas' || vistaBrecha === 'full') && (
                        <td className="py-3 px-3.5 text-center whitespace-nowrap bg-amber-500/10">
                          {row.is_mi_marca ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                              <span className="material-symbols-outlined text-xs">verified</span>
                              100% (Mi marca)
                            </span>
                          ) : row.brecha_full_pct !== null ? (
                            <div className="flex flex-col items-center">
                              <span className={`inline-flex items-center gap-0.5 font-mono font-extrabold text-xs px-2.5 py-0.5 rounded-full border shadow-xs ${
                                row.brecha_full_pct > 3
                                  ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30'
                                  : row.brecha_full_pct < -3
                                    ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
                                    : 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-500/30'
                              }`}>
                                {row.brecha_full_pct >= 0 ? '+' : ''}{row.brecha_full_pct.toFixed(0)}%
                              </span>
                              <span className="text-[9px] text-on-surface-variant font-mono mt-0.5">
                                {row.brecha_full_pct > 3 ? 'Más caro' : row.brecha_full_pct < -3 ? 'Más barato' : 'Paridad'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-on-surface-variant/60 font-mono text-[11px]">—</span>
                          )}
                        </td>
                      )}

                      {/* Brecha Desc vs Mi Marca (%) */}
                      {(vistaBrecha === 'ambas' || vistaBrecha === 'desc') && (
                        <td className="py-3 px-3.5 text-center whitespace-nowrap bg-emerald-500/10">
                          {row.is_mi_marca ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                              <span className="material-symbols-outlined text-xs">verified</span>
                              100% (Mi marca)
                            </span>
                          ) : row.brecha_desc_pct !== null ? (
                            <div className="flex flex-col items-center">
                              <span className={`inline-flex items-center gap-0.5 font-mono font-extrabold text-xs px-2.5 py-0.5 rounded-full border shadow-xs ${
                                row.brecha_desc_pct > 3
                                  ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30'
                                  : row.brecha_desc_pct < -3
                                    ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
                                    : 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-500/30'
                              }`}>
                                {row.brecha_desc_pct >= 0 ? '+' : ''}{row.brecha_desc_pct.toFixed(0)}%
                              </span>
                              <span className="text-[9px] text-on-surface-variant font-mono mt-0.5">
                                {row.brecha_desc_pct > 3 ? 'Más caro' : row.brecha_desc_pct < -3 ? 'Más barato' : 'Paridad'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-on-surface-variant/60 font-mono text-[11px]">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Barra de Paginación */}
        <div className="px-5 py-3.5 bg-surface-container-low border-t border-outline-variant/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-on-surface-variant">
            <span>Filas por página:</span>
            <select
              value={itemsPerPage}
              onChange={e => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
              className="bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-xs text-on-surface font-semibold"
            >
              <option value={15}>15</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500 (Todos)</option>
            </select>
            <span className="ml-2 font-mono">
              Mostrando {Math.min((currentPage - 1) * itemsPerPage + 1, rowsFiltradas.length)} - {Math.min(currentPage * itemsPerPage, rowsFiltradas.length)} de {rowsFiltradas.length}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="h-8 px-3 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-container-high transition-colors"
            >
              Anterior
            </button>
            <span className="px-3 py-1 font-mono font-bold text-primary bg-primary-container/40 rounded-lg border border-primary/20">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="h-8 px-3 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-container-high transition-colors"
            >
              Siguiente
            </button>
          </div>
        </div>
      </div>

      {/* Nota informativa de auditoría de reportería */}
      <div className="bg-surface-container-low rounded-2xl p-4 border border-outline-variant/40 flex items-start gap-3 text-xs text-on-surface-variant">
        <span className="material-symbols-outlined text-primary text-xl shrink-0 mt-0.5">info</span>
        <div className="space-y-1">
          <div className="font-bold text-on-surface font-display">Lógica de Cálculo de Brechas por ID:</div>
          <p>
            • <strong>Referencia Mi Marca (100% Base):</strong> Se toma el precio en dólares de tu producto propio para cada ID. Si tienes un enlace de tu marca extraído en esa cadena o el PVP maestro, se establece como el 100% de referencia.<br />
            • <strong>Brecha en Dólares (%):</strong> Se calcula como <code>((Precio Competidor USD - Precio Mi Marca USD) / Precio Mi Marca USD) * 100</code>.<br />
            • Si un competidor como <em>Calox</em> o <em>Genven</em> está en <strong>-60% o -67%</strong>, significa que su precio es menor y tiene ventaja competitiva de precio. Si está en <strong>+59%</strong>, tu producto es más económico.<br />
            • El campo <strong>Laboratorio / Fabricante</strong> refleja directamente el fabricante configurado en cada SKU del formulario de competencia.
          </p>
        </div>
      </div>
    </div>
  );
}
