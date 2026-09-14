import { useState, useMemo, useRef } from 'react';
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
  const [tipoBrechaBase, setTipoBrechaBase] = useState('efectivo'); // 'efectivo' (desc o full), 'full', 'desc'
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

  // Lista de categorías únicas
  const categorias = useMemo(() => {
    const set = new Set();
    productos.forEach(p => {
      if (p.categoria) set.add(p.categoria);
    });
    return ['todas', ...Array.from(set).sort()];
  }, [productos]);

  // Lista de laboratorios / fabricantes únicos
  const laboratorios = useMemo(() => {
    const set = new Set();
    productos.forEach(p => {
      if (p.laboratorio) set.add(p.laboratorio);
      if (p.fabricante) set.add(p.fabricante);
    });
    return ['todos', ...Array.from(set).sort()];
  }, [productos]);

  // Construcción unificada del dataset del reporte
  const datasetReporte = useMemo(() => {
    const rows = [];
    const processedProductIds = new Set();

    // 1. Mapeo de cada registro de competencia
    (productosCompetencia || []).forEach((comp, idx) => {
      if (comp.activo === false) return;
      const idPropio = String(comp.id_producto_propio || '').trim();
      const prodPropio = prodMap.get(idPropio) || {};

      processedProductIds.add(idPropio);

      const pvpPropioUsd = Number(prodPropio.pvp_propio_usd) || 0;
      const pvpPropioBs = pvpPropioUsd * currentBcvRate;

      const pFullBs = comp.ultimo_precio_full_bs != null && comp.ultimo_precio_full_bs > 0 ? Number(comp.ultimo_precio_full_bs) : null;
      const pDescBs = comp.ultimo_precio_desc_bs != null && comp.ultimo_precio_desc_bs > 0 ? Number(comp.ultimo_precio_desc_bs) : null;

      const pFullUsd = pFullBs ? pFullBs / currentBcvRate : null;
      const pDescUsd = pDescBs ? pDescBs / currentBcvRate : null;

      // Precio efectivo del competidor
      const compEffectiveUsd = pDescUsd || pFullUsd;
      const compEffectiveBs = pDescBs || pFullBs;

      // Cálculo de Brecha vs Producto Propio
      let brechaFullPct = null;
      if (pvpPropioUsd > 0 && pFullUsd != null) {
        brechaFullPct = ((pFullUsd - pvpPropioUsd) / pvpPropioUsd) * 100;
      }

      let brechaDescPct = null;
      if (pvpPropioUsd > 0 && pDescUsd != null) {
        brechaDescPct = ((pDescUsd - pvpPropioUsd) / pvpPropioUsd) * 100;
      }

      let brechaEfectivaPct = null;
      if (pvpPropioUsd > 0 && compEffectiveUsd != null) {
        brechaEfectivaPct = ((compEffectiveUsd - pvpPropioUsd) / pvpPropioUsd) * 100;
      }

      // Brecha activa según selección
      const brechaActiva = tipoBrechaBase === 'full' 
        ? brechaFullPct 
        : tipoBrechaBase === 'desc' 
          ? brechaDescPct 
          : brechaEfectivaPct;

      let estadoBrecha = 'Sin datos de precio';
      let estadoBrechaClase = 'neutral';
      if (comp.tipo === 'propio') {
        estadoBrecha = 'Mi marca (Canal)';
        estadoBrechaClase = 'propio';
      } else if (brechaActiva !== null) {
        if (brechaActiva > 3) {
          estadoBrecha = `Competidor +${brechaActiva.toFixed(1)}% (Más caro)`;
          estadoBrechaClase = 'mas_caro';
        } else if (brechaActiva < -3) {
          estadoBrecha = `Competidor ${brechaActiva.toFixed(1)}% (Más barato)`;
          estadoBrechaClase = 'mas_barato';
        } else {
          estadoBrecha = `En paridad (${brechaActiva >= 0 ? '+' : ''}${brechaActiva.toFixed(1)}%)`;
          estadoBrechaClase = 'paridad';
        }
      }

      rows.push({
        uid: comp.id || `comp_${idx}`,
        id_producto_propio: idPropio || prodPropio.id_interno || prodPropio.id || 'N/A',
        producto_propio: prodPropio.nombre || 'Producto no identificado',
        laboratorio_fabricante: prodPropio.laboratorio || prodPropio.fabricante || '—',
        categoria: prodPropio.categoria || 'Sin categoría',
        principio_activo: prodPropio.principio_activo || '—',
        cadena_competidor: comp.cadena || '—',
        marca_linea: comp.marca || comp.linea || comp.nombre_competidor || '—',
        tipo_raw: comp.tipo || 'alternativa',
        tipo: comp.tipo === 'propio' ? 'Mi marca' : 'Alternativa',
        precio_full_bs: pFullBs,
        precio_desc_bs: pDescBs,
        precio_full_usd: pFullUsd,
        precio_desc_usd: pDescUsd,
        pvp_propio_usd: pvpPropioUsd,
        pvp_propio_bs: pvpPropioBs,
        brecha_full_pct: brechaFullPct,
        brecha_desc_pct: brechaDescPct,
        brecha_efectiva_pct: brechaEfectivaPct,
        brecha_activa: brechaActiva,
        estado_brecha: estadoBrecha,
        estado_brecha_clase: estadoBrechaClase,
        url: comp.url || ''
      });
    });

    // 2. Opcional: Agregar productos propios sin competencia mapeada
    if (incluirSinCompetencia) {
      productos.forEach((p, idx) => {
        const idPropio = String(p.id_interno || p.id || '').trim();
        if (!processedProductIds.has(idPropio)) {
          const pvpPropioUsd = Number(p.pvp_propio_usd) || 0;
          const pvpPropioBs = pvpPropioUsd * currentBcvRate;
          rows.push({
            uid: `unmapped_${p.id || idx}`,
            id_producto_propio: idPropio,
            producto_propio: p.nombre || '—',
            laboratorio_fabricante: p.laboratorio || p.fabricante || '—',
            categoria: p.categoria || 'Sin categoría',
            principio_activo: p.principio_activo || '—',
            cadena_competidor: 'Sin mapeo aún',
            marca_linea: '—',
            tipo_raw: 'sin_mapeo',
            tipo: 'Sin mapeo',
            precio_full_bs: null,
            precio_desc_bs: null,
            precio_full_usd: null,
            precio_desc_usd: null,
            pvp_propio_usd: pvpPropioUsd,
            pvp_propio_bs: pvpPropioBs,
            brecha_full_pct: null,
            brecha_desc_pct: null,
            brecha_efectiva_pct: null,
            brecha_activa: null,
            estado_brecha: 'Sin enlaces asignados',
            estado_brecha_clase: 'neutral',
            url: ''
          });
        }
      });
    }

    return rows;
  }, [productosCompetencia, prodMap, productos, currentBcvRate, tipoBrechaBase, incluirSinCompetencia]);

  // Filtrado reactivo en memoria
  const rowsFiltradas = useMemo(() => {
    const term = searchTerm.toLowerCase().trim();

    return datasetReporte.filter(row => {
      // Filtro de Cadena
      if (filtroCadena !== 'todas' && row.cadena_competidor !== filtroCadena) {
        return false;
      }
      // Filtro de Tipo
      if (filtroTipo !== 'todos' && row.tipo_raw !== filtroTipo) {
        return false;
      }
      // Filtro de Categoría
      if (filtroCategoria !== 'todas' && row.categoria !== filtroCategoria) {
        return false;
      }
      // Filtro de Laboratorio / Fabricante
      if (filtroLaboratorio !== 'todos' && row.laboratorio_fabricante !== filtroLaboratorio) {
        return false;
      }
      // Filtro de Brecha
      if (filtroBrecha === 'mas_caro' && row.estado_brecha_clase !== 'mas_caro') return false;
      if (filtroBrecha === 'mas_barato' && row.estado_brecha_clase !== 'mas_barato') return false;
      if (filtroBrecha === 'paridad' && row.estado_brecha_clase !== 'paridad') return false;

      // Búsqueda libre
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
    const conPrecio = rowsFiltradas.filter(r => r.precio_full_bs || r.precio_desc_bs).length;
    const masCaros = rowsFiltradas.filter(r => r.estado_brecha_clase === 'mas_caro').length;
    const masBaratos = rowsFiltradas.filter(r => r.estado_brecha_clase === 'mas_barato').length;
    const enParidad = rowsFiltradas.filter(r => r.estado_brecha_clase === 'paridad').length;

    // Brecha promedio del mercado
    const brechasValidas = rowsFiltradas
      .filter(r => r.brecha_activa !== null && r.tipo_raw === 'alternativa')
      .map(r => r.brecha_activa);
    
    const brechaPromedio = brechasValidas.length > 0
      ? brechasValidas.reduce((a, b) => a + b, 0) / brechasValidas.length
      : 0;

    return {
      totalRegistros,
      conPrecio,
      masCaros,
      masBaratos,
      enParidad,
      brechaPromedio
    };
  }, [rowsFiltradas]);

  // Paginación calculada
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
      { key: 'pvp_propio_usd_fmt', label: 'PVP Propio Ref (USD)' },
      { key: 'pvp_propio_bs_fmt', label: 'PVP Propio Ref (Bs)' },
      { key: 'brecha_pct_fmt', label: 'Brecha vs Propio (%)' },
      { key: 'estado_brecha', label: 'Estado Brecha' },
      { key: 'tasa_bcv_aplicada', label: 'Tasa BCV Aplicada' }
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
      pvp_propio_usd_fmt: r.pvp_propio_usd > 0 ? r.pvp_propio_usd.toFixed(2) : '',
      pvp_propio_bs_fmt: r.pvp_propio_bs > 0 ? r.pvp_propio_bs.toFixed(2) : '',
      brecha_pct_fmt: r.brecha_activa != null ? `${r.brecha_activa >= 0 ? '+' : ''}${r.brecha_activa.toFixed(2)}%` : '—',
      estado_brecha: r.estado_brecha,
      tasa_bcv_aplicada: currentBcvRate.toFixed(2)
    }));

    exportToCSV('reporte_precios_brechas_competencia', headers, exportRows);
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
      'Laboratorio/Fabricante',
      'Cadena/Competidor',
      'Marca/Línea',
      'Tipo',
      'Precio Full (Bs)',
      'Precio Desc (Bs)',
      'Precio Full (USD)',
      'Precio Desc (USD)',
      'Brecha vs Propio (%)',
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
        r.brecha_activa != null ? `${r.brecha_activa >= 0 ? '+' : ''}${r.brecha_activa.toFixed(1)}%` : '—',
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
              Generador oficial de reportes unificados de auditoría y monitoreo. Descarga y analiza la comparativa completa de precios (Bs / USD) con el cálculo automático de <strong>brechas porcentuales frente a tus productos por cada ID</strong>.
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-on-surface-variant uppercase tracking-wider">Registros</div>
          <div className="text-xl font-bold font-display text-on-surface mt-1">{metricas.totalRegistros}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">{metricas.conPrecio} con precio activo</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-on-surface-variant uppercase tracking-wider">Tasa BCV</div>
          <div className="text-xl font-bold font-display text-primary mt-1">{currentBcvRate.toFixed(2)}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Bs / USD Oficial</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-on-surface-variant uppercase tracking-wider">Brecha Media</div>
          <div className={`text-xl font-bold font-display mt-1 ${metricas.brechaPromedio > 0 ? 'text-rose-600' : metricas.brechaPromedio < 0 ? 'text-emerald-600' : 'text-on-surface'}`}>
            {metricas.brechaPromedio >= 0 ? '+' : ''}{metricas.brechaPromedio.toFixed(1)}%
          </div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">vs mercado alternativo</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-rose-700 dark:text-rose-400 uppercase tracking-wider">Comp. Más Caros</div>
          <div className="text-xl font-bold font-display text-rose-700 dark:text-rose-400 mt-1">{metricas.masCaros}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Precio superior al tuyo</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">Comp. Más Baratos</div>
          <div className="text-xl font-bold font-display text-emerald-700 dark:text-emerald-400 mt-1">{metricas.masBaratos}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Precio menor al tuyo</div>
        </div>

        <div className="bg-surface-container-lowest p-3.5 rounded-2xl border border-outline-variant/60 shadow-xs">
          <div className="text-[11px] font-mono font-semibold text-sky-700 dark:text-sky-400 uppercase tracking-wider">En Paridad</div>
          <div className="text-xl font-bold font-display text-sky-700 dark:text-sky-400 mt-1">{metricas.enParidad}</div>
          <div className="text-[10px] text-on-surface-variant mt-0.5">Diferencia ±3%</div>
        </div>
      </div>

      {/* Barra de Filtros y Configuración del Reporte */}
      <div className="bg-surface-container-lowest rounded-3xl border border-outline-variant/60 p-5 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-outline-variant/40">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">tune</span>
            <span className="text-sm font-bold font-display text-on-surface">Filtros y Parámetros del Reporte</span>
          </div>

          {/* Selector de base de cálculo de la Brecha */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono font-semibold text-on-surface-variant">Cálculo de Brecha:</span>
            <div className="inline-flex bg-surface-container-high rounded-full p-0.5 border border-outline-variant/60">
              <button
                onClick={() => setTipoBrechaBase('efectivo')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  tipoBrechaBase === 'efectivo'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Precio Efectivo (Desc / Full)
              </button>
              <button
                onClick={() => setTipoBrechaBase('full')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  tipoBrechaBase === 'full'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Solo Full
              </button>
              <button
                onClick={() => setTipoBrechaBase('desc')}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  tipoBrechaBase === 'desc'
                    ? 'bg-primary text-on-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                Solo Desc
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
              placeholder="Buscar por ID, producto, marca..."
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

          {/* Laboratorio / Fabricante */}
          <div>
            <select
              value={filtroLaboratorio}
              onChange={e => { setFiltroLaboratorio(e.target.value); setCurrentPage(1); }}
              className="m3-select text-xs"
            >
              {laboratorios.map(lab => (
                <option key={lab} value={lab}>
                  {lab === 'todos' ? 'Todos los laboratorios' : lab}
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
              <option value="mas_barato">Competidores más baratos (-)</option>
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
              <span className="font-medium text-on-surface">Incluir productos propios sin enlaces asignados</span>
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
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">ID Propio</th>
                <th className="py-3 px-3.5 font-bold min-w-[200px]">Producto Propio</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">Laboratorio / Fabricante</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">Cadena / Competidor</th>
                <th className="py-3 px-3.5 font-bold min-w-[140px]">Marca / Línea</th>
                <th className="py-3 px-3.5 font-bold whitespace-nowrap">Tipo</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap">PVP Ref (USD)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-surface-container/40">Precio Full (Bs)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap bg-surface-container/40">Precio Desc (Bs)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap">Precio Full ($)</th>
                <th className="py-3 px-3 font-bold text-right whitespace-nowrap">Precio Desc ($)</th>
                <th className="py-3 px-4 font-bold text-center whitespace-nowrap bg-primary-container/20 text-on-primary-container">
                  Brecha vs Propio (%)
                </th>
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
                    <tr key={row.uid} className="hover:bg-surface-container-high/40 transition-colors">
                      {/* ID Producto Propio */}
                      <td className="py-3 px-3.5 font-mono font-bold text-primary whitespace-nowrap">
                        <span className="bg-primary-container/50 px-2 py-0.5 rounded border border-primary/20">
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

                      {/* Laboratorio / Fabricante */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span 
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
                          style={{
                            backgroundColor: getBrandBgTint(labColor),
                            borderColor: `${labColor}40`,
                            color: labColor
                          }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: labColor }}></span>
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
                            <span>Ver producto</span>
                            <span className="material-symbols-outlined text-[11px]">open_in_new</span>
                          </a>
                        )}
                      </td>

                      {/* Tipo */}
                      <td className="py-3 px-3.5 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          row.tipo_raw === 'propio'
                            ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                            : row.tipo_raw === 'sin_mapeo'
                              ? 'bg-surface-container text-on-surface-variant border border-outline-variant'
                              : 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30'
                        }`}>
                          {row.tipo}
                        </span>
                      </td>

                      {/* PVP Ref Propio (USD) */}
                      <td className="py-3 px-3 text-right font-mono font-bold text-on-surface-variant whitespace-nowrap">
                        {row.pvp_propio_usd > 0 ? `$${row.pvp_propio_usd.toFixed(2)}` : '—'}
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
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap">
                        {row.precio_full_usd != null ? `$${row.precio_full_usd.toFixed(2)}` : '—'}
                      </td>

                      {/* Precio Desc (USD) */}
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap">
                        {row.precio_desc_usd != null ? (
                          <span className="font-bold text-emerald-700 dark:text-emerald-400">
                            ${row.precio_desc_usd.toFixed(2)}
                          </span>
                        ) : '—'}
                      </td>

                      {/* Brecha vs Propio (%) */}
                      <td className="py-3 px-4 text-center whitespace-nowrap bg-primary-container/10">
                        {row.tipo_raw === 'propio' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-500/15 px-2.5 py-1 rounded-full border border-emerald-500/30">
                            <span className="material-symbols-outlined text-xs">verified</span>
                            Mi marca
                          </span>
                        ) : row.brecha_activa !== null ? (
                          <div className="flex flex-col items-center">
                            <span className={`inline-flex items-center gap-1 font-mono font-extrabold text-xs px-2.5 py-1 rounded-full border shadow-xs ${
                              row.brecha_activa > 3
                                ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30'
                                : row.brecha_activa < -3
                                  ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30'
                                  : 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-500/30'
                            }`}>
                              <span className="material-symbols-outlined text-xs leading-none">
                                {row.brecha_activa > 0 ? 'arrow_upward' : row.brecha_activa < 0 ? 'arrow_downward' : 'equal'}
                              </span>
                              {row.brecha_activa >= 0 ? '+' : ''}{row.brecha_activa.toFixed(1)}%
                            </span>
                            <span className="text-[9px] text-on-surface-variant font-mono mt-0.5">
                              {row.brecha_activa > 3 ? 'Más caro' : row.brecha_activa < -3 ? 'Más barato' : 'Paridad'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-on-surface-variant/60 font-mono text-[11px]">—</span>
                        )}
                      </td>
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
          <div className="font-bold text-on-surface font-display">Especificación del Reporte Unificado de Brechas:</div>
          <p>
            • Los precios en USD son normalizados en base a la tasa de cambio oficial del BCV vigente (<strong>{currentBcvRate.toFixed(2)} Bs.</strong>).<br />
            • La <strong>Brecha (%)</strong> representa la variación relativa del precio del competidor frente al PVP de tu producto: un valor positivo indica que el competidor está más caro, y un valor negativo indica que está más barato.<br />
            • La descarga en CSV incluye codificación UTF-8 con Byte Order Mark (BOM) para abrirse directamente en Microsoft Excel sin problemas de tildes o caracteres especiales.
          </p>
        </div>
      </div>
    </div>
  );
}
