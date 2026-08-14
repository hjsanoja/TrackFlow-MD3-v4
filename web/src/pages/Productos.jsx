import { useEffect, useState, useMemo, useRef } from 'react';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { parseCSV, getRowValue } from '../utils/csvParser';
import {
  dbUpsertProducto,
  dbDeleteProducto,
  dbDeleteAllProductos,
  dbUpsertProductoCompetencia,
  dbUpsertProductosBulk,
  dbUpsertCompetenciaBulk
} from '../utils/dbClient';

const CATEGORIAS = [
  'Analgésicos',
  'Antialérgicos',
  'Antibióticos',
  'Antigripales',
  'Cardiovasculares',
  'Dermatológicos',
  'Gastrointestinales',
  'Vitaminas',
  'Otros',
];

export default function Productos() {
  const {
    productos,
    productosCompetencia: competencia,
    cadenas,
    loadingInitial: loading,
    refreshData: cargar,
    refreshProductos,
    refreshCompetencia,
    setProductos,
    setProductosCompetencia
  } = useData();

  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroActivo, setFiltroActivo] = useState('todos');
  const [filtroUrls, setFiltroUrls] = useState('todos'); // todos | con_urls | sin_urls
  const [filtroTipo, setFiltroTipo] = useState('todos'); // todos | generico | marca
  const [filtroUn, setFiltroUn] = useState('todos'); // todos | lasante | pharmetique | otc
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [csvSummary, setCsvSummary] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const { addToast } = useToast();

  const fileInputRef = useRef(null);

  // Cuenta URLs activas por producto
  const urlsPorProducto = useMemo(() => {
    const map = new Map();
    for (const c of competencia) {
      if (c.activo) {
        map.set(c.id_producto_propio, (map.get(c.id_producto_propio) || []).concat(c));
      }
    }
    return map;
  }, [competencia]);

  const filtrados = useMemo(() => {
    const term = search.toLowerCase().trim();
    return productos.filter(p => {
      if (filtroActivo === 'activos' && !p.activo) return false;
      if (filtroActivo === 'inactivos' && p.activo) return false;

      const pTipo = (p.market_type || 'GENERICO').toUpperCase();
      if (filtroTipo === 'generico' && pTipo !== 'GENERICO') return false;
      if (filtroTipo === 'marca' && pTipo !== 'MARCA') return false;

      const pUn = (p.unidad_negocio || 'La Sante').toLowerCase().replace(/\s/g, '');
      if (filtroUn !== 'todos' && pUn !== filtroUn) return false;

      const links = urlsPorProducto.get(p.id_interno) || [];
      if (filtroUrls === 'con_urls' && links.length === 0) return false;
      if (filtroUrls === 'sin_urls' && links.length > 0) return false;
      if (!term) return true;
      return (
        (p.nombre || '').toLowerCase().includes(term) ||
        (p.codigo_barra || '').toLowerCase().includes(term) ||
        (p.laboratorio || '').toLowerCase().includes(term) ||
        (p.principio_activo || '').toLowerCase().includes(term) ||
        (p.categoria || '').toLowerCase().includes(term) ||
        (p.id_interno || '').toLowerCase().includes(term)
      );
    });
  }, [productos, search, filtroActivo, filtroUrls, filtroTipo, filtroUn, urlsPorProducto]);

  const huerfanos = useMemo(() => {
    return productos.filter(p => p.activo && (urlsPorProducto.get(p.id_interno) || []).length === 0).length;
  }, [productos, urlsPorProducto]);

  const [paginaActual, setPaginaActual] = useState(1);
  const itemsPorPagina = 20;

  useEffect(() => {
    setPaginaActual(1);
  }, [search, filtroActivo, filtroUrls, filtroTipo, filtroUn]);

  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / itemsPorPagina));
  const productosPaginados = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filtrados.slice(inicio, inicio + itemsPorPagina);
  }, [filtrados, paginaActual]);

  const handleSave = async (data, isNew) => {
    try {
      const id = data.id_interno.trim();
      if (!id) throw new Error('El ID interno es obligatorio');
      if (isNew && productos.some(p => p.id_interno === id)) {
        throw new Error('Ya existe un producto con ese ID interno');
      }

      const cleanProductData = {
        id,
        id_interno: id,
        nombre: data.nombre.trim(),
        codigo_barra: (data.codigo_barra || '').trim(),
        principio_activo: (data.principio_activo || '').trim(),
        concentracion: (data.concentracion || '').trim(),
        tamano: (data.tamano || '').trim(),
        laboratorio: (data.laboratorio || '').trim() || 'La Sante',
        categoria: data.categoria || 'Otros',
        pvp_propio_usd: parseFloat(data.pvp_propio_usd) || 0,
        unidosis: data.unidosis ? parseInt(data.unidosis, 10) : parseUnidosisCount(data.tamano || ''),
        market_type: data.market_type || 'GENERICO',
        unidad_negocio: data.unidad_negocio || 'La Sante',
        activo: data.activo ?? true,
      };

      await dbUpsertProducto(cleanProductData);

      addToast(isNew ? 'Producto creado con éxito' : 'Producto actualizado con éxito', 'success');
      setEditing(null);
      await cargar(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDelete = (producto) => {
    setConfirmDelete(producto);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const producto = confirmDelete;
    const links = urlsPorProducto.get(producto.id_interno) || [];
    setConfirmDelete(null);

    try {
      await dbDeleteProducto(producto.id, links);
      addToast('Producto y sus enlaces de competencia eliminados con éxito.', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  const handleConfirmDeleteAll = async () => {
    setDeletingAll(true);
    try {
      await dbDeleteAllProductos();
      addToast('Se han eliminado todos los productos, enlaces de competencia e historial de precios con éxito.', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al vaciar catálogo: ' + err.message, 'error');
    }
    setDeletingAll(false);
    setConfirmDeleteAll(false);
  };

  const handleToggleActivo = async (producto) => {
    try {
      await dbUpsertProducto({
        ...producto,
        activo: !producto.activo,
      });
      await cargar(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleCsvUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingCsv(true);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target.result;
        const rows = parseCSV(text);
        if (rows.length === 0) {
          throw new Error('El archivo CSV está vacío o no se pudieron reconocer sus columnas.');
        }

        const prodsToUpsert = [];
        const compToUpsert = [];
        const seenCompDocIds = new Set();
        let skippedCount = 0;

        for (let idx = 0; idx < rows.length; idx++) {
          const row = rows[idx];

          let id = getRowValue(
            row,
            'id_interno', 'id', 'ID Interno', 'ID_INTERNO', 'ID', 'codigo', 'código',
            'cod', 'item', 'ref', 'sku', 'plu', 'clave', 'identificador', 'ID_PRODUCTO', 'PRODUCTO_ID'
          );

          let nombre = getRowValue(
            row,
            'nombre', 'Nombre', 'nombre_producto', 'Nombre Producto', 'producto',
            'descripcion', 'descripción', 'descripcion_producto', 'desc', 'item_name',
            'articulo', 'artículo', 'denominacion', 'denominación', 'PRODUCTO'
          );

          if (!id && nombre) {
            id = `P${String(idx + 1).padStart(3, '0')}`;
          } else if (id && !nombre) {
            nombre = `Producto ${id}`;
          } else if (!id && !nombre) {
            const values = Object.values(row).filter(v => v !== undefined && String(v).trim() !== '');
            if (values.length > 0) {
              id = `P${String(idx + 1).padStart(3, '0')}`;
              nombre = values[0];
            } else {
              skippedCount++;
              continue;
            }
          }

          const codigo_barra = getRowValue(
            row,
            'codigo_barra', 'Código de Barra', 'Codigo de Barra', 'codigo_barras',
            'Código de Barras', 'Codigo de Barras', 'gtin', 'GTIN', 'ean', 'EAN',
            'upc', 'UPC', 'barcode', 'Bar Code', 'barcode_id'
          );

          const principio_activo = getRowValue(row, 'principio_activo', 'Principio Activo', 'molecula', 'molécula', 'Molecula', 'sustancia_activa');
          const concentracion = getRowValue(row, 'concentracion', 'Concentración', 'Concentracion', 'dosis', 'concentracion_mg', 'conc');
          const tamano = getRowValue(row, 'tamano', 'Tamaño', 'Tamano', 'tamano_empaque', 'presentacion', 'Presentación', 'Presentacion', 'empaque');
          const laboratorio = getRowValue(row, 'laboratorio', 'Laboratorio', 'lab', 'Lab', 'fabricante');
          const catRaw = getRowValue(row, 'categoria', 'Categoría', 'Categoria', 'linea', 'grupo');
          const categoria = CATEGORIAS.includes(catRaw) ? catRaw : 'Otros';

          let market_type = getRowValue(row, 'market_type', 'Market Type', 'tipo_mercado', 'tipo', 'Tipo').toUpperCase();
          if (market_type.includes('MARCA')) {
            market_type = 'MARCA';
          } else {
            market_type = 'GENERICO';
          }

          let unRaw = getRowValue(row, 'unidad_negocio', 'Unidad de Negocio', 'Unidad Negocio', 'unidad', 'un', 'UN', 'linea_negocio').toUpperCase();
          let unidad_negocio = 'La Sante';
          if (unRaw.includes('PHARMETIQUE') || unRaw === 'PH') {
            unidad_negocio = 'Pharmetique';
          } else if (unRaw.includes('OTC')) {
            unidad_negocio = 'OTC';
          } else if (unRaw.includes('SANTE') || unRaw.includes('SANTÉ')) {
            unidad_negocio = 'La Sante';
          }

          const pvpRaw = getRowValue(row, 'pvp_propio_usd', 'PVP Propio USD', 'pvp', 'precio', 'pvp usd', 'precio usd', 'mi precio lista (usd)', 'costo');
          const pvp_propio_usd = parseFloat(pvpRaw.replace(',', '.')) || 0;
          const presentacion = `${concentracion || ''} ${tamano || ''}`.trim();
          const unidosis = parseUnidosisCount(tamano || presentacion, nombre);

          const cleanProd = {
            id,
            id_interno: id,
            nombre,
            codigo_barra,
            principio_activo,
            concentracion,
            tamano,
            presentacion,
            laboratorio: laboratorio || 'La Sante',
            categoria,
            pvp_propio_usd,
            unidosis,
            market_type,
            unidad_negocio,
            activo: true,
          };

          prodsToUpsert.push(cleanProd);

          // Capturar también URL/Enlace si viene en la misma fila del CSV
          const url = getRowValue(row, 'url', 'URL', 'enlace', 'Enlace', 'link', 'Link', 'url_scraper', 'link_farmatodo', 'link_locatel', 'url_competencia');
          if (url) {
            let cadena = getRowValue(row, 'cadena', 'Cadena', 'cadena_farmacia', 'farmacia');
            if (!cadena) {
              const urlLower = url.toLowerCase();
              if (urlLower.includes('farmatodo')) cadena = 'Farmatodo';
              else if (urlLower.includes('locatel')) cadena = 'Locatel';
              else if (urlLower.includes('redvital')) cadena = 'Redvital';
              else if (urlLower.includes('meditotal')) cadena = 'Meditotal';
              else if (urlLower.includes('saas')) cadena = 'SAAS';
              else cadena = 'Competencia';
            }
            let marcaComp = getRowValue(row, 'marca_competencia', 'marca', 'Marca') || nombre;
            let tipo = getRowValue(row, 'tipo', 'Tipo', 'tipo_enlace').toLowerCase();
            const cleanUrl = url.toLowerCase().trim();
            const rawDocId = (row.doc_id || row.id_competencia) ? String(row.doc_id || row.id_competencia).trim() : null;
            let docId = rawDocId;

            if (!docId || seenCompDocIds.has(docId)) {
              const urlSlug = cleanUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]/g, '_');
              const baseId = `${id}_${cadena.toLowerCase().replace(/[^a-z0-9]/g, '')}_${urlSlug}`.replace(/_+/g, '_').slice(0, 100);
              docId = baseId;
              let counter = 1;
              while (seenCompDocIds.has(docId)) {
                docId = `${baseId}_${counter}`;
                counter++;
              }
            }

            seenCompDocIds.add(docId);

            compToUpsert.push({
              id: docId,
              id_producto_propio: id,
              cadena,
              tipo: (tipo === 'propio' || tipo === 'propia') ? 'propio' : 'alternativa',
              marca: marcaComp,
              url,
              activo: true,
              laboratorio: laboratorio || '',
              concentracion: concentracion || '',
              tamano: tamano || '',
            });
          }
        }

        if (prodsToUpsert.length > 0) {
          await dbUpsertProductosBulk(prodsToUpsert);

          if (compToUpsert.length > 0) {
            await dbUpsertCompetenciaBulk(compToUpsert);
            refreshCompetencia();
          }

          setProductos(prev => {
            const map = new Map(prev.map(p => [p.id, p]));
            prodsToUpsert.forEach(p => map.set(p.id, p));
            return Array.from(map.values()).sort((a, b) => (a.id_interno || a.id || '').localeCompare(b.id_interno || b.id || ''));
          });

          refreshProductos();

          const msgComp = compToUpsert.length > 0 ? ` y ${compToUpsert.length} enlaces de competencia.` : '.';
          addToast(`Importación exitosa: ${prodsToUpsert.length} productos registrados${msgComp}`, 'success');

          setCsvSummary({
            totalRows: rows.length,
            successCount: prodsToUpsert.length,
            compCount: compToUpsert.length,
            skippedCount
          });
        } else {
          throw new Error('No se encontraron filas con datos de productos procesables en el archivo CSV.');
        }
      } catch (err) {
        addToast('Error procesando CSV: ' + (err.message || String(err)), 'error');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
        setIsUploadingCsv(false);
        setShowCsvModal(false);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const sugerirId = () => {
    const numeros = productos
      .map(p => p.id_interno)
      .filter(id => /^P\d+$/.test(id))
      .map(id => parseInt(id.slice(1), 10));
    const max = numeros.length > 0 ? Math.max(...numeros) : 0;
    return 'P' + String(max + 1).padStart(3, '0');
  };

  const downloadCsvPlantilla = () => {
    const headers = ['id_interno', 'nombre', 'codigo_barra', 'principio_activo', 'concentracion', 'tamano', 'laboratorio', 'categoria', 'market_type', 'unidad_negocio'].join(',') + '\n';

    let content = '\ufeff' + headers; // UTF-8 BOM for Excel compatibility

    if (productos.length > 0) {
      productos.forEach(p => {
        const row = [
          p.id_interno || '',
          p.nombre || '',
          p.codigo_barra || '',
          p.principio_activo || '',
          p.concentracion || '',
          p.tamano || '',
          p.laboratorio || '',
          p.categoria || '',
          p.market_type || 'GENERICO',
          p.unidad_negocio || 'La Sante'
        ].map(val => {
          const str = String(val || '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        }).join(',');

        content += row + '\n';
      });
    } else {
      // Fallback example rows if database is empty
      const row1 = 'P001,Atamel,7592450001234,Acetaminofén,500 mg,10 tabletas,La Santé,Analgésicos,MARCA,La Sante\n';
      const row2 = 'P002,Calox,,Ibuprofeno,400 mg,20 capsulas,Calox,Analgésicos,GENERICO,OTC\n';
      content += row1 + row2;
    }

    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Plantilla_Catalogo_Productos_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addToast(productos.length > 0 ? `Plantilla con tus ${productos.length} productos cargados descargada con éxito.` : 'Plantilla de ejemplo descargada.', 'success');
  };

  const handleExportarCatalogo = () => {
    const headers = [
      { label: 'ID Interno', key: 'id_interno' },
      { label: 'Nombre', key: 'nombre' },
      { label: 'Código de Barra', key: 'codigo_barra' },
      { label: 'Principio Activo', key: 'principio_activo' },
      { label: 'Concentración', key: 'concentracion' },
      { label: 'Presentación/Tamaño', key: 'tamano_empaque' },
      { label: 'Tipo', key: 'market_type' },
      { label: 'Unidad de Negocio', key: 'unidad_negocio' },
      { label: 'Laboratorio', key: 'laboratorio' },
      { label: 'Categoría', key: 'categoria' },
      { label: 'Estado', key: 'estado_str' }
    ];

    const dataRows = filtrados.map(p => ({
      ...p,
      market_type: p.market_type || 'GENERICO',
      unidad_negocio: p.unidad_negocio || 'Sin UN',
      laboratorio: p.laboratorio || '—',
      categoria: p.categoria || 'Sin Categ',
      estado_str: p.activo ? 'ACTIVO' : 'INACTIVO'
    }));

    exportToCSV('Catalogo_Productos_Farmaceuticos', headers, dataRows);
    addToast(`Exportados ${dataRows.length} productos a CSV.`, 'success');
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Editorial Title Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">medication</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Catálogo de Productos
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Gestiona el catálogo de medicamentos registrados y asocia sus enlaces de competencia.
          </p>
        </div>
        <div className="flex gap-2.5 flex-wrap items-center">
          <button
            onClick={() => setConfirmDeleteAll(true)}
            disabled={deletingAll || productos.length === 0}
            className="touch-target px-4 py-2 bg-surface-low hover:bg-rose-50 text-rose-700 font-mono font-bold text-xs rounded-full border border-rose-200 transition-all flex items-center gap-1.5 shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
            title="Eliminar todos los productos, enlaces de competencia e historial"
          >
            <span className="material-symbols-outlined text-base">delete_sweep</span>
            <span>{deletingAll ? 'Vaciando...' : 'Vaciar Catálogo'}</span>
          </button>
          <button
            onClick={handleExportarCatalogo}
            className="m3-btn-outline"
            title="Exportar vista actual a archivo CSV"
          >
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar CSV</span>
          </button>
          <button
            onClick={() => setShowCsvModal(true)}
            className="m3-btn-outline"
          >
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Carga Masiva (CSV)</span>
          </button>
          <button
            onClick={() => setEditing('new')}
            className="m3-btn-primary"
          >
            <span className="material-symbols-outlined text-base">add</span>
            <span>Nuevo Producto</span>
          </button>
        </div>
      </div>

      {huerfanos > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-5 py-3.5 rounded-2xl flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-xl text-amber-700">warning</span>
            <span className="text-xs font-medium">
              Hay <strong>{huerfanos} producto{huerfanos > 1 ? 's activos' : ' activo'} sin enlaces</strong> de competencia registrados para el scraper.
            </span>
          </div>
          <button
            onClick={() => setFiltroUrls('sin_urls')}
            className="text-xs px-3.5 py-1.5 bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 rounded-full font-bold shadow-xs transition-all"
          >
            Ver Cuáles
          </button>
        </div>
      )}

      {/* Structured Grid & Filters Area */}
      <div className="neural-card p-4 space-y-3">
        <div className="flex flex-col lg:flex-row gap-3 items-center justify-between">
          <div className="flex-1 w-full relative">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px] pointer-events-none select-none">search</span>
            <input
              type="text"
              placeholder="Buscar por nombre, molécula, ID o laboratorio..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="m3-input m3-input-search pr-8"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-container-high">×</button>
            )}
          </div>
          
          <div className="flex gap-2 flex-wrap items-center">
            <div className="m3-segmented">
              <button onClick={() => setFiltroActivo('todos')}
                className={`m3-segmented-item ${filtroActivo === 'todos' ? 'active' : ''}`}>TODOS</button>
              <button onClick={() => setFiltroActivo('activos')}
                className={`m3-segmented-item ${filtroActivo === 'activos' ? 'active' : ''}`}>ACTIVOS</button>
              <button onClick={() => setFiltroActivo('inactivos')}
                className={`m3-segmented-item ${filtroActivo === 'inactivos' ? 'active' : ''}`}>INACTIVOS</button>
            </div>

            <div className="m3-segmented">
              <button onClick={() => setFiltroUrls('todos')}
                className={`m3-segmented-item ${filtroUrls === 'todos' ? 'active' : ''}`}>TODOS</button>
              <button onClick={() => setFiltroUrls('con_urls')}
                className={`m3-segmented-item ${filtroUrls === 'con_urls' ? 'active' : ''}`}>CON ENLACES</button>
              <button onClick={() => setFiltroUrls('sin_urls')}
                className={`m3-segmented-item ${filtroUrls === 'sin_urls' ? 'active' : ''}`}>SIN ENLACES</button>
            </div>

            <div className="m3-segmented">
              <button onClick={() => setFiltroTipo('todos')}
                className={`m3-segmented-item ${filtroTipo === 'todos' ? 'active' : ''}`}>TODOS TIPO</button>
              <button onClick={() => setFiltroTipo('generico')}
                className={`m3-segmented-item ${filtroTipo === 'generico' ? 'active' : ''}`}>GENÉRICOS</button>
              <button onClick={() => setFiltroTipo('marca')}
                className={`m3-segmented-item ${filtroTipo === 'marca' ? 'active' : ''}`}>MARCA</button>
            </div>

            <div className="m3-segmented">
              <button onClick={() => setFiltroUn('todos')}
                className={`m3-segmented-item ${filtroUn === 'todos' ? 'active' : ''}`}>TODAS UN</button>
              <button onClick={() => setFiltroUn('lasante')}
                className={`m3-segmented-item ${filtroUn === 'lasante' ? 'active' : ''}`}>LA SANTÉ</button>
              <button onClick={() => setFiltroUn('pharmetique')}
                className={`m3-segmented-item ${filtroUn === 'pharmetique' ? 'active' : ''}`}>PHARMETIQUE</button>
              <button onClick={() => setFiltroUn('otc')}
                className={`m3-segmented-item ${filtroUn === 'otc' ? 'active' : ''}`}>OTC</button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Table View */}
      <div className="neural-card overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto animate-pulse">
            <table className="m3-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Nombre / Molécula</th>
                  <th>Concentración / Tamaño</th>
                  <th>Tipo</th>
                  <th>Laboratorio</th>
                  <th>Categoría</th>
                  <th className="text-center">Enlaces Activos</th>
                  <th className="text-center">Estado</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {[1, 2, 3, 4, 5].map((n) => (
                  <tr key={n}>
                    <td><div className="h-4 bg-gray-200 rounded w-16"></div></td>
                    <td>
                      <div className="h-4 bg-gray-200 rounded w-48 mb-1.5"></div>
                      <div className="h-3 bg-gray-100 rounded w-32"></div>
                    </td>
                    <td><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                    <td><div className="h-4 bg-gray-200 rounded w-12"></div></td>
                    <td><div className="h-4 bg-gray-200 rounded w-28"></div></td>
                    <td><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                    <td className="text-center"><div className="h-4 bg-gray-200 rounded w-8 mx-auto"></div></td>
                    <td><div className="h-6 bg-gray-200 rounded-full w-14 mx-auto"></div></td>
                    <td className="text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant">
              <span className="material-symbols-outlined text-2xl">medication</span>
            </div>
            <div>
              <div className="font-bold text-on-surface font-display text-base">No se encontraron productos</div>
              <div className="text-xs text-on-surface-variant mt-0.5">
                {search || filtroActivo !== 'todos' || filtroUrls !== 'todos' || filtroTipo !== 'todos' || filtroUn !== 'todos'
                  ? 'Prueba ajustando los términos de búsqueda o los filtros activos.'
                  : 'Aún no hay productos registrados. Sube un CSV o haz click en "+ Nuevo Producto".'}
              </div>
            </div>
            {(search || filtroActivo !== 'todos' || filtroUrls !== 'todos' || filtroTipo !== 'todos' || filtroUn !== 'todos') && (
              <button
                onClick={() => {
                  setSearch('');
                  setFiltroActivo('todos');
                  setFiltroUrls('todos');
                  setFiltroTipo('todos');
                  setFiltroUn('todos');
                }}
                className="m3-btn-outline h-8 px-4 text-xs mt-1"
              >
                Limpiar todos los filtros
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[750px] relative">
            <table className="m3-table">
              <thead className="m3-sticky-header">
                <tr>
                  <th className="rounded-tl-2xl">ID</th>
                  <th>Nombre / Molécula</th>
                  <th>Concentración / Tamaño</th>
                  <th>Tipo</th>
                  <th>UN</th>
                  <th>Laboratorio</th>
                  <th>Categoría</th>
                  <th className="text-center">Enlaces Activos</th>
                  <th className="text-center">Estado</th>
                  <th className="text-right rounded-tr-2xl">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {productosPaginados.map(p => {
                  const links = urlsPorProducto.get(p.id_interno) || [];
                  const count = links.length;
                  return (
                    <tr key={p.id} className="hover:bg-surface-low transition-colors">
                      <td className="px-6 py-4 font-mono text-xs text-primary font-bold">{p.id_interno}</td>
                      <td className="px-6 py-4">
                        <div className="font-bold text-on-surface text-base font-display flex items-center gap-2 flex-wrap">
                          <span>{p.nombre}</span>
                          {p.codigo_barra && (
                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-low border border-outline-variant text-on-surface-variant font-medium shrink-0" title="Código de barras / EAN">
                              EAN: {p.codigo_barra}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-on-surface-variant font-mono mt-0.5">{p.principio_activo || 'Sin molécula'}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-on-surface font-semibold">{p.concentracion || '—'}</div>
                        <div className="text-xs text-on-surface-variant font-mono mt-0.5 flex items-center gap-1.5">
                          <span>{p.tamano || '—'}</span>
                          {parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis) > 1 && (
                            <span className="px-1.5 py-0.2 text-[10px] bg-sky-50 text-sky-700 border border-sky-200 rounded font-bold" title="Unidades/Tabletas por empaque para cálculo unidosis">
                              {parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis)}u
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2.5 py-0.5 text-[10px] rounded font-mono font-bold tracking-wider ${
                          (p.market_type || 'GENERICO').toUpperCase() === 'MARCA'
                            ? 'bg-purple-100 text-purple-800 border border-purple-200'
                            : 'bg-green-100 text-green-800 border border-green-200'
                        }`}>
                          {p.market_type || 'GENERICO'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-mono font-bold border ${
                          (p.unidad_negocio || 'La Sante') === 'OTC'
                            ? 'bg-amber-100 text-amber-800 border-amber-200'
                            : (p.unidad_negocio || 'La Sante') === 'Pharmetique'
                            ? 'bg-blue-100 text-blue-800 border-blue-200'
                            : 'bg-teal-100 text-teal-800 border-teal-200'
                        }`}>
                          {p.unidad_negocio || 'La Sante'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-on-surface">{p.laboratorio || '—'}</td>
                      <td className="px-6 py-4">
                        <span className="px-3 py-1 text-xs rounded-full bg-surface-low text-on-surface font-medium border border-outline-variant">
                          {p.categoria || 'Otros'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full font-mono text-xs font-bold ${
                          count === 0
                            ? 'bg-error-container text-error border border-error/20'
                            : 'bg-primary-container text-on-primary-container border border-outline-variant/30'
                        }`}>
                          <span className="material-symbols-outlined text-sm leading-none">{count === 0 ? 'link_off' : 'link'}</span>
                          {count === 0 ? 'Sin Enlaces' : `${count} Enlace${count > 1 ? 's' : ''}`}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button onClick={() => handleToggleActivo(p)}
                          className={`text-xs px-3 py-1 rounded-full font-bold uppercase tracking-wider transition-all ${
                            p.activo ? 'bg-secondary/15 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                          }`}>
                          {p.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <button onClick={() => setEditing(p.id)}
                          className="text-xs text-primary hover:text-primary/85 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          Editar
                        </button>
                        <button onClick={() => handleDelete(p)}
                          className="text-xs text-error hover:text-error/85 font-bold inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">delete</span>
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {filtrados.length > 0 && (
          <div className="px-6 py-4 bg-surface-low border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-on-surface-variant font-mono">
              Mostrando <span className="font-bold text-primary">{Math.min(filtrados.length, (paginaActual - 1) * itemsPorPagina + 1)}</span> - <span className="font-bold text-primary">{Math.min(filtrados.length, paginaActual * itemsPorPagina)}</span> de <span className="font-bold text-primary">{filtrados.length}</span> productos
            </div>
            {totalPaginas > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPaginaActual(p => Math.max(1, p - 1))}
                  disabled={paginaActual === 1}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-white text-xs font-bold text-primary disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-all flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                  Anterior
                </button>
                <span className="text-xs font-mono font-bold px-3 py-1 bg-white border border-outline-variant rounded-lg text-primary">
                  {paginaActual} / {totalPaginas}
                </span>
                <button
                  onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))}
                  disabled={paginaActual === totalPaginas}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-white text-xs font-bold text-primary disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-all flex items-center gap-1"
                >
                  Siguiente
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create/Edit Product Modal */}
      {editing && (
        <ProductoModal
          producto={editing === 'new' ? null : productos.find(p => p.id === editing)}
          sugerirId={sugerirId}
          onSave={handleSave}
          cadenas={cadenas}
          competenciaActual={competencia}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Producto?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar "${confirmDelete.nombre}"?${
                (urlsPorProducto.get(confirmDelete.id_interno) || []).length > 0 
                  ? `\n\nATENCIÓN: este producto tiene ${(urlsPorProducto.get(confirmDelete.id_interno) || []).length} URL(s) de competencia activa(s) que también se eliminarán.`
                  : ''
              }\n\nEsta acción no se puede deshacer.`
            : ''
        }
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Confirm Modal to Delete All Products and History */}
      <ConfirmModal
        isOpen={confirmDeleteAll}
        title="¿Vaciar Catálogo de Productos Completo?"
        message="¿Estás seguro de que deseas eliminar TODOS los productos de tu catálogo, junto con todos sus enlaces de competencia y todo el historial de precios acumulado?\n\nEsta acción eliminará de forma permanente toda la base de datos de productos y competidores, y NO se puede deshacer."
        confirmText={deletingAll ? "Eliminando..." : "Sí, Vaciar Todo"}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      {/* CSV Import Modal */}
      {showCsvModal && (
        <ModalWrapper
          isOpen={showCsvModal}
          onClose={() => !isUploadingCsv && setShowCsvModal(false)}
          title="Importación Masiva (CSV)"
          subtitle="Sube tu catálogo de productos de forma masiva en cualquier formato CSV."
          icon="upload_file"
          maxWidth="max-w-lg"
          footer={
            <button
              onClick={() => setShowCsvModal(false)}
              disabled={isUploadingCsv}
              className="m3-btn-outline h-9 px-4 text-xs disabled:opacity-50"
            >
              Cerrar
            </button>
          }
        >
          <div className="space-y-4 text-sm text-on-surface">
            <p className="text-xs text-on-surface-variant font-sans">
              El archivo puede estar delimitado por comas, punto y coma o tabulaciones.
            </p>
            <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/60 space-y-1.5 font-mono text-xs">
              <div className="font-bold text-primary border-b border-outline-variant/60 pb-1 mb-1 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">lists</span>
                Columnas del CSV:
              </div>
              <div>id_interno <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
              <div>nombre <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
              <div>codigo_barra <span className="text-on-surface-variant font-sans font-medium">(Opcional / EAN / GTIN)</span></div>
              <div>principio_activo <span className="text-on-surface-variant font-sans font-medium">(Molécula)</span></div>
              <div>concentracion, tamano, laboratorio, categoria</div>
              <div>market_type, unidad_negocio</div>
            </div>
            <div className="flex justify-between items-center pt-1">
              <button type="button" onClick={downloadCsvPlantilla}
                className="text-xs text-primary font-bold hover:underline inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">download</span>
                Descargar Plantilla / Catálogo Actual (CSV)
              </button>
            </div>

            {/* Drag and Drop Zone */}
            <div
              className={`border-2 border-dashed border-outline-variant hover:border-primary transition-colors rounded-2xl p-8 text-center cursor-pointer bg-surface-container-low ${isUploadingCsv ? 'opacity-50 pointer-events-none' : ''}`}
              onClick={() => !isUploadingCsv && fileInputRef.current.click()}
            >
              {isUploadingCsv ? (
                <div className="flex flex-col items-center justify-center py-2">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                  <p className="mt-3 text-sm font-bold text-primary">Procesando e importando catálogo...</p>
                  <p className="text-xs text-on-surface-variant mt-1">Por favor espera un momento</p>
                </div>
              ) : (
                <>
                  <span className="material-symbols-outlined text-4xl text-primary">upload_file</span>
                  <p className="mt-2 text-sm font-bold text-primary">Haz click o arrastra tu archivo CSV aquí</p>
                  <p className="text-xs text-on-surface-variant mt-1">Soporta cualquier formato CSV (comas, punto y coma, tabulaciones)</p>
                </>
              )}
              <input type="file" ref={fileInputRef} onChange={handleCsvUpload} accept=".csv" className="hidden" disabled={isUploadingCsv} />
            </div>
          </div>
        </ModalWrapper>
      )}

      {/* CSV Result Summary Modal */}
      {csvSummary && (
        <ModalWrapper
          isOpen={Boolean(csvSummary)}
          onClose={() => setCsvSummary(null)}
          title="¡Carga Masiva Finalizada!"
          subtitle="El catálogo se ha actualizado inmediatamente en pantalla."
          icon="check_circle"
          maxWidth="max-w-md"
          footer={
            <button
              onClick={() => setCsvSummary(null)}
              className="m3-btn-primary h-9 w-full text-xs"
            >
              Aceptar
            </button>
          }
        >
          <div className="bg-surface-container-low rounded-2xl p-4 border border-outline-variant/60 space-y-2 text-sm text-on-surface">
            <div className="flex justify-between py-1 border-b border-outline-variant/40">
              <span className="text-on-surface-variant text-xs">Total de Filas Procesadas:</span>
              <span className="font-bold font-mono text-xs">{csvSummary.totalRows}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-outline-variant/40">
              <span className="text-on-surface-variant text-xs">Productos Importados / Actualizados:</span>
              <span className="font-bold font-mono text-xs text-secondary">{csvSummary.successCount}</span>
            </div>
            {csvSummary.compCount > 0 && (
              <div className="flex justify-between py-1 border-b border-outline-variant/40">
                <span className="text-on-surface-variant text-xs">Enlaces de Competencia Creados:</span>
                <span className="font-bold font-mono text-xs text-primary">{csvSummary.compCount}</span>
              </div>
            )}
            <div className="flex justify-between py-1">
              <span className="text-on-surface-variant text-xs">Filas Omitidas (Sin Datos):</span>
              <span className="font-bold font-mono text-xs text-outline">{csvSummary.skippedCount}</span>
            </div>
          </div>
        </ModalWrapper>
      )}
    </div>
  );
}

function ProductoModal({ producto, sugerirId, onSave, onClose }) {
  const isNew = !producto;
  const [form, setForm] = useState({
    id_interno: producto?.id_interno || sugerirId(),
    nombre: producto?.nombre || '',
    codigo_barra: producto?.codigo_barra || '',
    laboratorio: producto?.laboratorio || '',
    principio_activo: producto?.principio_activo || '',
    concentracion: producto?.concentracion || '',
    tamano: producto?.tamano || '',
    unidosis: producto?.unidosis || '',
    presentacion: producto?.presentacion || '',
    categoria: producto?.categoria || '',
    market_type: producto?.market_type || 'GENERICO',
    unidad_negocio: producto?.unidad_negocio || 'La Sante',
    activo: producto?.activo ?? true,
  });

  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form, isNew);
    setSaving(false);
  };

  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));

  return (
    <ModalWrapper
      isOpen={true}
      onClose={onClose}
      title={isNew ? 'Registrar Nuevo Producto' : 'Editar Propiedades'}
      subtitle={isNew ? 'Ingresa los datos para registrar un nuevo producto en el catálogo' : `Editando ${form.nombre || form.id_interno}`}
      icon="inventory_2"
      maxWidth="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="ID Interno *" hint="Código único (ej: P001)">
            <input type="text" required value={form.id_interno}
              onChange={e => handleChange('id_interno', e.target.value)}
              disabled={!isNew}
              className="m3-input font-mono disabled:opacity-60" />
          </Field>
          
          <Field label="Nombre Comercial *" hint="Ej. Atamel">
            <input type="text" required value={form.nombre}
              onChange={e => handleChange('nombre', e.target.value)}
              placeholder="Nombre comercial"
              className="m3-input font-sans" />
          </Field>

          <Field label="Código de Barra" hint="EAN / GTIN (ej: 759245000123)">
            <input type="text" value={form.codigo_barra}
              onChange={e => handleChange('codigo_barra', e.target.value)}
              placeholder="EAN / GTIN"
              className="m3-input font-mono" />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Molécula / Principio">
            <input type="text" value={form.principio_activo}
              onChange={e => handleChange('principio_activo', e.target.value)}
              placeholder="Acetaminofén"
              className="m3-input" />
          </Field>

          <Field label="Concentración" hint="Ej: 500 mg, 10%">
            <input type="text" value={form.concentracion}
              onChange={e => handleChange('concentracion', e.target.value)}
              placeholder="500 mg"
              className="m3-input" />
          </Field>

          <Field label="Tamaño / Unidades" hint="Ej: 10 tabletas">
            <input type="text" value={form.tamano}
              onChange={e => handleChange('tamano', e.target.value)}
              placeholder="10 tabletas"
              className="m3-input" />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Laboratorio">
            <input type="text" value={form.laboratorio}
              onChange={e => handleChange('laboratorio', e.target.value)}
              placeholder="La Santé"
              className="m3-input" />
          </Field>

          <Field label="Categoría">
            <select value={form.categoria} onChange={e => handleChange('categoria', e.target.value)}
              className="m3-input bg-surface-container-lowest">
              <option value="">— Selecciona —</option>
              {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          <Field label="Market Type (Tipo)">
            <select value={form.market_type} onChange={e => handleChange('market_type', e.target.value)}
              className="m3-input bg-surface-container-lowest font-bold text-primary">
              <option value="GENERICO">GENÉRICO</option>
              <option value="MARCA">MARCA</option>
            </select>
          </Field>

          <Field label="Unidad de Negocio (UN)">
            <select value={form.unidad_negocio} onChange={e => handleChange('unidad_negocio', e.target.value)}
              className="m3-input bg-surface-container-lowest font-bold text-secondary">
              <option value="La Sante">La Santé</option>
              <option value="Pharmetique">Pharmetique</option>
              <option value="OTC">OTC</option>
            </select>
          </Field>
        </div>

        <div className="flex justify-between items-center pt-4 border-t border-outline-variant/60">
          <label className="flex items-center gap-2 cursor-pointer font-bold text-xs text-primary select-none">
            <input type="checkbox" checked={form.activo}
              onChange={e => handleChange('activo', e.target.checked)}
              className="rounded text-primary focus:ring-primary h-4 w-4" />
            <span>PRODUCTO ACTIVO</span>
          </label>
          
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="m3-btn-outline h-9 px-4 text-xs">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="m3-btn-primary h-9 px-5 text-xs">
              {saving ? 'Guardando...' : isNew ? 'Registrar' : 'Guardar Cambios'}
            </button>
          </div>
        </div>
      </form>
    </ModalWrapper>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-on-surface-variant font-mono">{hint}</p>}
    </div>
  );
}
