import { useEffect, useState, useMemo, useRef } from 'react';
import { doc, getDoc, collection, onSnapshot } from 'firebase/firestore';
import { useSearchParams } from 'react-router-dom';
import { db } from '../firebase';
import { supabase, isSupabaseActive } from '../supabase';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import GitHubConfigModal from '../components/GitHubConfigModal';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';
import { executeLiveBatchScrape, scrapeSingleUrl } from '../utils/liveScraper';
import { parseCSV, getRowValue } from '../utils/csvParser';
import {
  dbUpsertProductoCompetencia,
  dbDeleteProductoCompetencia,
  dbDeleteAllProductosCompetencia,
  dbAddHistoricoPrecio,
  dbUpsertCompetenciaBulk,
  dbUpsertProductosBulk
} from '../utils/dbClient';
import { getGitHubConfig, triggerGitHubScraper } from '../utils/githubClient';

const TIPOS = [
  { value: 'propio', label: 'Mi marca' },
  { value: 'alternativa', label: 'Alternativa (competencia)' },
];

export default function Competencia({ user, userDoc }) {
  const isAdmin = userDoc ? userDoc.rol === 'administrador' : true;
  const {
    productosCompetencia: items,
    productos,
    cadenas,
    bcvRates,
    loadingInitial: loading,
    refreshData: cargar,
    refreshCompetencia,
    refreshProductos,
    setProductosCompetencia
  } = useData();

  const currentBcvRate = useMemo(() => {
    if (!bcvRates || bcvRates.length === 0) return 0;
    const sorted = [...bcvRates].sort((a, b) => {
      const dA = a.rawDate ? new Date(a.rawDate) : new Date(0);
      const dB = b.rawDate ? new Date(b.rawDate) : new Date(0);
      return dA - dB;
    });
    return sorted[sorted.length - 1]?.valor || 0;
  }, [bcvRates]);

  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroCadena, setFiltroCadena] = useState('todas');
  const [filtroProducto, setFiltroProducto] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [csvSummary, setCsvSummary] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [scrapingItems, setScrapingItems] = useState({});
  const [manualPriceItem, setManualPriceItem] = useState(null);
  const [isGlobalScraping, setIsGlobalScraping] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);

  const { addToast } = useToast();

  const fileInputRef = useRef(null);

  // Si llegamos con ?producto=P001, aplicamos ese filtro al cargar
  useEffect(() => {
    const productoParam = searchParams.get('producto');
    if (productoParam) {
      setFiltroProducto(productoParam);
    }
  }, [searchParams]);

  const prodMap = useMemo(() => {
    const map = new Map();
    (productos || []).forEach(p => {
      const key = String(p.id_interno || p.id || '').trim();
      if (key) map.set(key, p.nombre || key);
    });
    return map;
  }, [productos]);

  const filtrados = useMemo(() => {
    const term = search.toLowerCase().trim();
    return items.filter(it => {
      if (filtroCadena !== 'todas' && it.cadena !== filtroCadena) return false;
      if (filtroProducto !== 'todos' && String(it.id_producto_propio).trim() !== String(filtroProducto).trim()) return false;
      if (filtroTipo !== 'todos' && it.tipo !== filtroTipo) return false;
      if (!term) return true;
      const pNombre = (prodMap.get(String(it.id_producto_propio).trim()) || '').toLowerCase();
      const pId = String(it.id_producto_propio || '').toLowerCase();
      return (
        (it.marca || '').toLowerCase().includes(term) ||
        (it.url || '').toLowerCase().includes(term) ||
        (it.laboratorio || '').toLowerCase().includes(term) ||
        pNombre.includes(term) ||
        pId.includes(term)
      );
    });
  }, [items, search, filtroCadena, filtroProducto, filtroTipo, prodMap]);

  const ordenados = useMemo(() => {
    return [...filtrados].sort((a, b) => {
      return (a.id_producto_propio || '').localeCompare(b.id_producto_propio || '') ||
        (a.cadena || '').localeCompare(b.cadena || '') ||
        (a.marca || '').localeCompare(b.marca || '');
    });
  }, [filtrados]);

  const [paginaActual, setPaginaActual] = useState(1);
  const itemsPorPagina = 20;

  useEffect(() => {
    setPaginaActual(1);
  }, [search, filtroCadena, filtroProducto, filtroTipo]);

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / itemsPorPagina));
  const itemsPaginados = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return ordenados.slice(inicio, inicio + itemsPorPagina);
  }, [ordenados, paginaActual]);

  // Si estamos viendo solo un producto y no tiene URLs, mostramos hint
  const productoFiltradoSinUrls = useMemo(() => {
    if (filtroProducto === 'todos') return null;
    if (ordenados.length > 0) return null;
    return productos.find(p => p.id_interno === filtroProducto) || null;
  }, [filtroProducto, ordenados, productos]);

  const handleSave = async (data, isNew) => {
    try {
      let cleanUrl = (data.url || '').trim();
      if (cleanUrl && !cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
        cleanUrl = 'https://' + cleanUrl;
      }

      if (!cleanUrl) {
        throw new Error('La dirección URL es obligatoria');
      }

      const editingId = typeof editing === 'string' ? editing : editing?.id;
      const currentItem = (!isNew && editingId) ? items.find(i => i.id === editingId) : null;

      const labPart = data.laboratorio?.trim() ? `_${data.laboratorio.trim()}` : '';
      const existing = isNew ? (
        items.find(it =>
          it.id_producto_propio === data.id_producto_propio &&
          it.cadena.toLowerCase().trim() === data.cadena.toLowerCase().trim() &&
          (data.marca ? (it.marca || '').toLowerCase().trim() === data.marca.toLowerCase().trim() : true)
        ) || items.find(it =>
          it.id_producto_propio === data.id_producto_propio &&
          it.cadena.toLowerCase().trim() === data.cadena.toLowerCase().trim()
        )
      ) : null;

      const docId = !isNew
        ? (data.id || editingId || currentItem?.id || `${data.id_producto_propio}_${data.cadena}_${data.marca || 'comp'}${labPart}`.replace(/[\s/\\]+/g, '_'))
        : existing
          ? existing.id
          : `${data.id_producto_propio}_${data.cadena}_${data.marca || 'comp'}${labPart}`.replace(/[\s/\\]+/g, '_');

      if (!docId) {
        throw new Error('No se pudo determinar el identificador único del enlace');
      }

      const cadenaObj = cadenas.find(c => c.nombre.toLowerCase().trim() === data.cadena.toLowerCase().trim());
      if (cadenaObj && cadenaObj.website && cleanUrl) {
        try {
          const urlHost = new URL(cleanUrl).hostname.replace(/^www\./, '');
          const websiteWithProto = cadenaObj.website.startsWith('http') ? cadenaObj.website : `https://${cadenaObj.website}`;
          const cadenaHost = new URL(websiteWithProto).hostname.replace(/^www\./, '');
          if (!urlHost.endsWith(cadenaHost) && !cadenaHost.endsWith(urlHost)) {
            console.warn(`La URL parece ser de "${urlHost}" pero la cadena "${data.cadena}" usa "${cadenaHost}".`);
          }
        } catch {
          // Do not fail if cadena website has strange format, just ensure cleanUrl is valid
          try {
            new URL(cleanUrl);
          } catch {
            throw new Error('La dirección URL ingresada no es válida. Formato esperado: https://www.ejemplo.com/...');
          }
        }
      }

      await dbUpsertProductoCompetencia({
        id: docId,
        id_producto_propio: data.id_producto_propio,
        cadena: data.cadena,
        tipo: data.tipo,
        marca: (data.marca || '').trim(),
        url: cleanUrl,
        activo: data.activo,
        laboratorio: data.laboratorio?.trim() || '',
        concentracion: data.concentracion?.trim() || '',
        tamano: data.tamano?.trim() || '',
        // Conservar estado previo si estamos editando
        ...(currentItem ? {
          ultimo_precio_full_bs: currentItem.ultimo_precio_full_bs ?? null,
          ultimo_precio_desc_bs: currentItem.ultimo_precio_desc_bs ?? null,
          ultimo_nombre: currentItem.ultimo_nombre ?? null,
          ultimo_scrape: currentItem.ultimo_scrape ?? null,
          estado: currentItem.estado ?? 'ok',
          ultimo_error: currentItem.ultimo_error ?? null
        } : {})
      });

      addToast(isNew ? (existing ? 'URL de competencia actualizada con éxito' : 'URL de competencia creada con éxito') : 'Cambios guardados con éxito', 'success');
      setEditing(null);
      await cargar(true);
      return { success: true };
    } catch (err) {
      const errMsg = err?.message || 'Error al guardar cambios en el enlace';
      addToast(errMsg, 'error');
      return { success: false, error: errMsg };
    }
  };

  const handleDelete = (item) => {
    setConfirmDelete(item);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const item = confirmDelete;
    setConfirmDelete(null);
    try {
      await dbDeleteProductoCompetencia(item.id);
      addToast('Enlace eliminado del scraper', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  const handleConfirmDeleteAll = async () => {
    setDeletingAll(true);
    try {
      await dbDeleteAllProductosCompetencia();
      addToast('Se han eliminado todos los enlaces de competencia e historial de precios.', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al vaciar enlaces: ' + err.message, 'error');
    }
    setDeletingAll(false);
    setConfirmDeleteAll(false);
  };

  const handleDispararScraperGlobal = async () => {
    setIsGlobalScraping(true);
    try {
      const config = await getGitHubConfig();

      if (!config || !config.token || !config.repo_owner || !config.repo_name) {
        addToast('No se encontraron credenciales de GitHub Actions. Ingresa tus datos de conexión.', 'info');
        setShowGithubModal(true);
        setIsGlobalScraping(false);
        return;
      }

      await triggerGitHubScraper({ config });
      addToast('¡Robot scraper global disparado con éxito vía GitHub Actions!', 'success');
    } catch (err) {
      if (err.message === 'CONFIG_MISSING') {
        setShowGithubModal(true);
      } else {
        addToast('Error al disparar GitHub Actions: ' + err.message, 'error');
      }
    } finally {
      setIsGlobalScraping(false);
    }
  };

  const handleToggleActivo = async (item) => {
    try {
      await dbUpsertProductoCompetencia({
        ...item,
        activo: !item.activo,
      });
      await cargar(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleScrapeIndividual = async (item) => {
    setScrapingItems(prev => ({ ...prev, [item.id]: 'disparando' }));
    try {
      const config = await getGitHubConfig();

      if (!config || !config.token || !config.repo_owner || !config.repo_name) {
        addToast('Ingresa tus credenciales de GitHub Actions para continuar.', 'info');
        setShowGithubModal(true);
        setScrapingItems(prev => ({ ...prev, [item.id]: null }));
        return;
      }

      await triggerGitHubScraper({
        config,
        payload: {
          product_id: item.id_producto_propio,
          doc_id: item.id
        }
      });

      setScrapingItems(prev => ({ ...prev, [item.id]: 'esperando' }));
      addToast(`Robot extractor lanzado para "${item.marca}". Monitoreando resultado...`, 'info');

      // Sondeo reactivo en segundo plano para reflejar el nuevo precio en cuanto GitHub Actions termine de escribir en la DB
      const startTime = Date.now();
      const pollInterval = setInterval(async () => {
        try {
          let updatedItem = null;
          if (isSupabaseActive()) {
            const { data, error } = await supabase
              .from('productos_competencia')
              .select('*')
              .eq('id', item.id)
              .maybeSingle();
            if (!error && data) {
              updatedItem = data;
            }
          }
          if (!updatedItem && db) {
            const docSnap = await getDoc(doc(db, 'productos_competencia', item.id));
            if (docSnap.exists()) {
              updatedItem = { id: docSnap.id, ...docSnap.data() };
            }
          }

          const scrapeTime = updatedItem?.ultimo_scrape
            ? (updatedItem.ultimo_scrape.toDate?.()?.getTime() || new Date(updatedItem.ultimo_scrape).getTime())
            : 0;

          // Si el registro se actualizó después del inicio de la ejecución del robot
          if (updatedItem && (scrapeTime >= startTime - 4000 || (updatedItem.ultimo_precio_full_bs && updatedItem.ultimo_precio_full_bs !== item.ultimo_precio_full_bs))) {
            clearInterval(pollInterval);
            setScrapingItems(prev => ({ ...prev, [item.id]: null }));
            // Actualizar tabla en tiempo real
            setProductosCompetencia(prev => prev.map(p => p.id === item.id ? { ...p, ...updatedItem } : p));
            await cargar(true);
            const precioFormatted = updatedItem.ultimo_precio_full_bs
              ? `Bs ${Number(updatedItem.ultimo_precio_full_bs).toLocaleString('es-VE', { minimumFractionDigits: 2 })}`
              : 'Actualizado';
            addToast(`✅ ¡Precio actualizado con éxito! ${item.marca}: ${precioFormatted}`, 'success');
            return;
          }

          // Si transcurren más de 65 segundos sin respuesta, finalizar sondeo
          if (Date.now() - startTime > 65000) {
            clearInterval(pollInterval);
            setScrapingItems(prev => ({ ...prev, [item.id]: null }));
            await cargar(true);
          }
        } catch (e) {
          console.warn('Error en sondeo del scraper:', e);
        }
      }, 3500);

      return;
    } catch (err) {
      setScrapingItems(prev => ({ ...prev, [item.id]: null }));
      if (err.message === 'CONFIG_MISSING') {
        setShowGithubModal(true);
      } else {
        addToast('Error al disparar scraper: ' + err.message, 'error');
      }
    }
  };

  // Cálculos para KPIs de Competencia
  const kpis = useMemo(() => {
    const activos = items.filter(it => it.activo);
    const exitosos = activos.filter(it => it.estado === 'ok');
    const conError = activos.filter(it => it.estado === 'error');
    
    // 1. Tasa de Salud Técnica
    const tasaSalud = activos.length > 0 ? Math.round((exitosos.length / activos.length) * 100) : 100;
    
    // 2. Enlaces Desactualizados (> 24 horas)
    const desactualizados = activos.filter(it => {
      if (!it.ultimo_scrape) return true;
      const scrapeTime = it.ultimo_scrape.toDate?.()?.getTime() || new Date(it.ultimo_scrape).getTime();
      const diffHrs = (Date.now() - scrapeTime) / (1000 * 60 * 60);
      return diffHrs > 24;
    }).length;

    // 3. Comparativa de precios vs competencia
    const prodGrupos = {};
    activos.forEach(it => {
      const pId = it.id_producto_propio;
      if (!prodGrupos[pId]) prodGrupos[pId] = [];
      prodGrupos[pId].push(it);
    });

    let propiosMasBaratos = 0;
    let totalComparables = 0;

    Object.keys(prodGrupos).forEach(pId => {
      const g = prodGrupos[pId];
      const propio = g.find(it => it.tipo === 'propio');
      const alternativas = g.filter(it => it.tipo === 'alternativa');
      
      if (propio && alternativas.length > 0) {
        const precioPropio = propio.ultimo_precio_desc_bs || propio.ultimo_precio_full_bs;
        if (precioPropio) {
          totalComparables++;
          const preciosAlt = alternativas
            .map(a => a.ultimo_precio_desc_bs || a.ultimo_precio_full_bs)
            .filter(Boolean);
          
          if (preciosAlt.length > 0) {
            const minAlt = Math.min(...preciosAlt);
            if (precioPropio < minAlt) {
              propiosMasBaratos++;
            }
          }
        }
      }
    });

    return {
      totalEnlaces: items.length,
      activosCount: activos.length,
      exitososCount: exitosos.length,
      erroresCount: conError.length,
      tasaSalud,
      desactualizados,
      propiosMasBaratos,
      totalComparables
    };
  }, [items]);

  const limpiarFiltros = () => {
    setSearch('');
    setFiltroCadena('todas');
    setFiltroProducto('todos');
    setFiltroTipo('todos');
    setSearchParams({});
  };

  const productoNombre = (id) => productos.find(p => p.id_interno === id)?.nombre || id;
  const formatPrice = (priceBs) => {
    if (priceBs == null) return '—';
    return 'Bs ' + priceBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // CSV Parsing for Bulk Competitor upload
  const handleCsvUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingCsv(true);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target.result;
        const rows = parseCSV(text);
        if (rows.length === 0) throw new Error('El archivo CSV está vacío o no se pudieron reconocer sus columnas.');

        const compToUpsert = [];
        const prodsToAutoCreate = new Map();
        const seenDocIds = new Set();
        let skippedCount = 0;

        for (let idx = 0; idx < rows.length; idx++) {
          const row = rows[idx];
          let id_producto = getRowValue(
            row,
            'id_producto_propio', 'ID_Producto', 'id_producto', 'id_interno',
            'id', 'id producto', 'producto_id', 'sku', 'codigo', 'código', 'id_producto'
          );
          let cadena = getRowValue(row, 'cadena', 'Cadena', 'cadena_farmacia', 'farmacia');
          let marca = getRowValue(row, 'marca', 'Marca', 'nombre', 'producto', 'item');
          let url = getRowValue(row, 'url', 'URL', 'enlace', 'Enlace', 'link', 'Link', 'url_scraper', 'link_farmatodo', 'link_locatel', 'url_competencia');
          let tipo = getRowValue(row, 'tipo', 'Tipo', 'tipo_enlace').toLowerCase();
          let laboratorio = getRowValue(row, 'laboratorio', 'Laboratorio', 'lab', 'fabricante');
          let concentracion = getRowValue(row, 'concentracion', 'Concentración', 'Concentracion', 'dosis');
          let tamano = getRowValue(row, 'tamano', 'Tamaño', 'Tamano', 'presentacion', 'Presentación');

          if (!url) {
            skippedCount++;
            continue;
          }

          if (cadena) {
            const matchCadena = cadenas?.find(c => c.nombre.toLowerCase().trim() === cadena.toLowerCase().trim());
            if (matchCadena) {
              cadena = matchCadena.nombre;
            } else {
              cadena = cadena.charAt(0).toUpperCase() + cadena.slice(1).toLowerCase();
            }
          } else {
            const urlLower = url.toLowerCase();
            if (urlLower.includes('farmatodo')) cadena = 'Farmatodo';
            else if (urlLower.includes('locatel')) cadena = 'Locatel';
            else if (urlLower.includes('farmadon')) cadena = 'FarmaDON';
            else if (urlLower.includes('sanignacio') || urlLower.includes('san_ignacio')) cadena = 'Grupo San Ignacio';
            else if (urlLower.includes('redvital')) cadena = 'Redvital';
            else if (urlLower.includes('meditotal')) cadena = 'Meditotal';
            else if (urlLower.includes('saas')) cadena = 'SAAS';
            else if (urlLower.includes('farmago')) cadena = 'FarmaGo';
            else if (urlLower.includes('xana')) cadena = 'Farmacias Xana';
            else cadena = 'Competencia';
          }

          if (!id_producto && marca) {
            const matchedProd = productos.find(p => p.nombre?.toLowerCase().trim() === marca.toLowerCase().trim());
            if (matchedProd) {
              id_producto = matchedProd.id_interno || matchedProd.id;
            }
          }

          if (!id_producto) {
            id_producto = `P_${String(idx + 1).padStart(4, '0')}`;
          }

          const id_str = String(id_producto).trim();

          // Registrar auto-creación de producto si no existe en el catálogo
          const prodExists = productos.some(p => String(p.id_interno || p.id).trim() === id_str);
          if (!prodExists && !prodsToAutoCreate.has(id_str)) {
            prodsToAutoCreate.set(id_str, {
              id: id_str,
              id_interno: id_str,
              nombre: marca || `Producto ${id_str}`,
              laboratorio: laboratorio || 'La Sante',
              concentracion: concentracion || '',
              tamano: tamano || '',
              categoria: 'Otros',
              activo: true,
              market_type: (laboratorio && laboratorio.toLowerCase().includes('sante')) ? 'GENERICO' : 'MARCA',
              unidad_negocio: 'La Sante'
            });
          }

          const cleanUrl = url.toLowerCase().trim();
          const existingComp = items.find(c =>
            (row.doc_id && c.id === String(row.doc_id).trim()) ||
            (row.id && c.id === String(row.id).trim()) ||
            (c.url && c.url.toLowerCase().trim() === cleanUrl)
          );

          const rawDocId = (row.doc_id || row.id) ? String(row.doc_id || row.id).trim() : null;
          let docId = rawDocId;

          if (!docId || seenDocIds.has(docId)) {
            if (existingComp && !seenDocIds.has(existingComp.id)) {
              docId = existingComp.id;
            } else {
              const urlSlug = cleanUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]/g, '_');
              const baseId = `${id_str}_${cadena.toLowerCase().replace(/[^a-z0-9]/g, '')}_${urlSlug}`.replace(/_+/g, '_').slice(0, 100);
              docId = baseId;
              let counter = 1;
              while (seenDocIds.has(docId)) {
                docId = `${baseId}_${counter}`;
                counter++;
              }
            }
          }

          seenDocIds.add(docId);

          const activoVal = getRowValue(row, 'activo', 'Activo');
          const isPropio = tipo === 'propio' || tipo === 'propia' || tipo === 'la sante' || tipo === 'lasante' || tipo === 'pharmetique';

          compToUpsert.push({
            id: docId,
            id_producto_propio: id_str,
            cadena,
            tipo: isPropio ? 'propio' : 'alternativa',
            marca: marca || existingComp?.marca || 'Competencia',
            url,
            activo: activoVal ? (activoVal.toLowerCase() === 'true' || activoVal === '1') : true,
            laboratorio: laboratorio || existingComp?.laboratorio || '',
            concentracion: concentracion || existingComp?.concentracion || '',
            tamano: tamano || existingComp?.tamano || '',
          });
        }

        if (prodsToAutoCreate.size > 0) {
          await dbUpsertProductosBulk(Array.from(prodsToAutoCreate.values()));
          if (refreshProductos) refreshProductos();
        }

        if (compToUpsert.length > 0) {
          await dbUpsertCompetenciaBulk(compToUpsert);

          setProductosCompetencia(prev => {
            const map = new Map(prev.map(c => [c.id, c]));
            compToUpsert.forEach(c => map.set(c.id, c));
            return Array.from(map.values());
          });

          if (refreshCompetencia) refreshCompetencia();
          if (cargar) cargar(true);

          addToast(`Importación exitosa: ${compToUpsert.length} enlaces cargados.`, 'success');

          setCsvSummary({
            totalRows: rows.length,
            successCount: compToUpsert.length,
            skippedCount
          });
        } else {
          throw new Error('No se encontraron filas válidas con al menos una URL.');
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

  const downloadExampleCsv = () => {
    const headers = 'id_producto_propio,cadena,tipo,marca,url,activo,laboratorio,concentracion,tamano\n';
    const row1 = 'P001,Farmatodo,alternativa,Acetaminofén,https://www.farmatodo.com.ve/producto/atamel-500mg,true,Genven,500mg,10tab\n';
    const row2 = 'P001,Locatel,alternativa,Acetaminofén,https://www.locatel.com.ve/calox-500mg,true,Calox,500mg,10tab\n';
    const blob = new Blob([headers + row1 + row2], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'plantilla_competencia.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportarEnlaces = () => {
    const headers = [
      { label: 'ID Producto Propio', key: 'id_producto_propio' },
      { label: 'Producto Propio', key: 'producto_propio' },
      { label: 'Cadena/Competidor', key: 'cadena' },
      { label: 'Marca/Línea', key: 'marca' },
      { label: 'Tipo', key: 'tipo_str' },
      { label: 'Precio Full (Bs)', key: 'ultimo_precio_full_bs' },
      { label: 'Precio Desc (Bs)', key: 'ultimo_precio_desc_bs' },
      { label: 'Precio Full (USD)', key: 'ultimo_precio_full_usd' },
      { label: 'Precio Desc (USD)', key: 'ultimo_precio_desc_usd' },
      { label: 'URL Monitoreada', key: 'url' }
    ];

    const dataRows = ordenados.map(it => {
      const fullBs = (it.ultimo_precio_full_bs !== null && it.ultimo_precio_full_bs !== undefined && it.ultimo_precio_full_bs !== '')
        ? Number(it.ultimo_precio_full_bs)
        : null;
      const descBs = (it.ultimo_precio_desc_bs !== null && it.ultimo_precio_desc_bs !== undefined && it.ultimo_precio_desc_bs !== '')
        ? Number(it.ultimo_precio_desc_bs)
        : null;

      const fullUsd = (fullBs && currentBcvRate > 0)
        ? (fullBs / currentBcvRate).toFixed(2)
        : (it.ultimo_precio_full_usd !== null && it.ultimo_precio_full_usd !== undefined && it.ultimo_precio_full_usd !== '' ? Number(it.ultimo_precio_full_usd).toFixed(2) : '');

      const descUsd = (descBs && currentBcvRate > 0)
        ? (descBs / currentBcvRate).toFixed(2)
        : (it.ultimo_precio_desc_usd !== null && it.ultimo_precio_desc_usd !== undefined && it.ultimo_precio_desc_usd !== '' ? Number(it.ultimo_precio_desc_usd).toFixed(2) : '');

      return {
        ...it,
        id_producto_propio: it.id_producto_propio || '',
        producto_propio: productoNombre(it.id_producto_propio),
        cadena: it.cadena || '',
        marca: it.marca || '',
        tipo_str: it.tipo === 'propio' ? 'MI MARCA' : 'COMPETENCIA',
        ultimo_precio_full_bs: fullBs !== null ? fullBs : '',
        ultimo_precio_desc_bs: descBs !== null ? descBs : '',
        ultimo_precio_full_usd: fullUsd,
        ultimo_precio_desc_usd: descUsd,
        url: it.url || ''
      };
    });

    exportToCSV('Enlaces_Competencia_Monitoreados', headers, dataRows);
    addToast(`Exportados ${dataRows.length} enlaces a CSV.`, 'success');
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Title Header Block */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">link</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Enlaces de Competencia
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Vincula productos locales con URLs externas para el monitoreo automático de precios.
          </p>
        </div>
        <div className="flex gap-2.5 flex-wrap items-center">
          <button
            onClick={() => setConfirmDeleteAll(true)}
            disabled={deletingAll || items.length === 0}
            className="m3-btn-danger-outline"
            title="Eliminar todos los enlaces de competencia e historial"
          >
            <span className="material-symbols-outlined text-base">delete_sweep</span>
            <span>{deletingAll ? 'Vaciando...' : 'Vaciar Enlaces'}</span>
          </button>
          <button
            onClick={handleExportarEnlaces}
            className="m3-btn-outline"
            title="Exportar enlaces filtrados a archivo CSV"
          >
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar CSV</span>
          </button>
          <button
            onClick={() => setShowCsvModal(true)}
            className="m3-btn-outline"
          >
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Importar CSV</span>
          </button>
          <button
            onClick={handleDispararScraperGlobal}
            disabled={isGlobalScraping}
            className="m3-btn-primary"
            title="Lanzar el robot extractor de precios para todos los enlaces activos"
          >
            <span className={`material-symbols-outlined text-base ${isGlobalScraping ? 'animate-spin' : ''}`}>
              {isGlobalScraping ? 'sync' : 'smart_toy'}
            </span>
            <span>{isGlobalScraping ? 'Ejecutando...' : 'Ejecutar Scraper Robot'}</span>
          </button>
          <button
            onClick={() => setEditing('new')}
            className="m3-btn-outline bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
          >
            <span className="material-symbols-outlined text-base">add</span>
            <span>Vincular Enlace</span>
          </button>
        </div>
      </div>

      {productoFiltradoSinUrls && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 px-5 py-3.5 rounded-2xl flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-xl text-amber-700">warning</span>
            <span className="text-xs font-medium">
              El producto <strong>"{productoFiltradoSinUrls.nombre}"</strong> todavía no tiene ningún enlace competidor asignado.
            </span>
          </div>
          <button
            onClick={() => setEditing('new')}
            className="text-xs px-3.5 py-1.5 bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 rounded-full font-bold shadow-xs transition-all"
          >
            Vincular Enlace Ahora
          </button>
        </div>
      )}

      {/* KPIs de Competencia Bento Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* KPI 1: Tasa de Salud Técnica */}
        <div className="neural-card p-5 flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase tracking-wider block">Salud del Catálogo</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-display font-extrabold text-primary">{kpis.tasaSalud}%</span>
              <span className="text-[10px] font-semibold text-on-surface-variant">Enlaces OK</span>
            </div>
            <p className="text-[11px] text-on-surface-variant font-sans">
              {kpis.exitososCount} de {kpis.activosCount} activos sin fallos de lectura.
            </p>
          </div>
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${kpis.tasaSalud > 90 ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-rose-50 border border-rose-200 text-rose-700'}`}>
            <span className="material-symbols-outlined text-2xl">{kpis.tasaSalud > 90 ? 'health_and_safety' : 'sync_problem'}</span>
          </div>
        </div>

        {/* KPI 2: Frescura de Datos */}
        <div className="neural-card p-5 flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase tracking-wider block">Frescura de Precios</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-display font-extrabold text-primary">
                {kpis.desactualizados}
              </span>
              <span className="text-[10px] font-semibold text-on-surface-variant">Vencidos</span>
            </div>
            <p className="text-[11px] text-on-surface-variant font-sans">
              Enlaces que requieren actualización (&gt; 24h).
            </p>
          </div>
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${kpis.desactualizados === 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
            <span className="material-symbols-outlined text-2xl">{kpis.desactualizados === 0 ? 'schedule' : 'history_toggle_off'}</span>
          </div>
        </div>

        {/* KPI 3: Liderazgo de Mercado */}
        <div className="neural-card p-5 flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase tracking-wider block">Liderazgo en Precios</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-display font-extrabold text-primary">
                {kpis.totalComparables > 0 ? `${Math.round((kpis.propiosMasBaratos / kpis.totalComparables) * 100)}%` : '—'}
              </span>
              <span className="text-[10px] font-semibold text-on-surface-variant">Líder</span>
            </div>
            <p className="text-[11px] text-on-surface-variant font-sans">
              {kpis.propiosMasBaratos} de {kpis.totalComparables} comparables más económicos.
            </p>
          </div>
          <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-2xl">leaderboard</span>
          </div>
        </div>
      </div>

      {/* Filter and Query Section */}
      <div className="neural-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] relative">
          <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px] pointer-events-none select-none">search</span>
          <input
            type="text"
            placeholder="Buscar por variante, marca o dirección URL..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="m3-input m3-input-search pr-8"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface text-sm font-bold w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-container-high">×</button>
          )}
        </div>
        
        <select
          value={filtroProducto}
          onChange={(e) => setFiltroProducto(e.target.value)}
          className="m3-select max-w-[220px]"
        >
          <option value="todos">Todos los productos</option>
          {productos.map(p => <option key={p.id} value={p.id_interno}>{p.nombre}</option>)}
        </select>

        <select
          value={filtroCadena}
          onChange={(e) => setFiltroCadena(e.target.value)}
          className="m3-select max-w-[180px]"
        >
          <option value="todas">Todas las cadenas</option>
          {cadenas.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
        </select>

        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value)}
          className="m3-select max-w-[160px]"
        >
          <option value="todos">Todos los tipos</option>
          {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>

        {(search || filtroCadena !== 'todas' || filtroProducto !== 'todos' || filtroTipo !== 'todos') && (
          <button onClick={limpiarFiltros} className="text-xs font-bold text-rose-600 hover:underline uppercase font-mono px-2">
            Limpiar Filtros
          </button>
        )}
      </div>

      {/* Main Grid View */}
      <div className="neural-card overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto animate-pulse">
            <table className="m3-table">
              <thead>
                <tr>
                  <th>Mi Producto Local</th>
                  <th>Cadena Farmacia</th>
                  <th>Variante Competidor</th>
                  <th>Tipo Asociación</th>
                  <th className="text-right">Último Precio Detectado</th>
                  <th className="text-center">Status Scrape</th>
                  <th className="text-center">Scraper Activo</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {[1, 2, 3, 4, 5].map((n) => (
                  <tr key={n}>
                    <td>
                      <div className="h-4 bg-gray-200 rounded w-48 mb-1.5"></div>
                      <div className="h-3 bg-gray-100 rounded w-24"></div>
                    </td>
                    <td><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                    <td>
                      <div className="h-4 bg-gray-200 rounded w-40 mb-1"></div>
                      <div className="h-3 bg-gray-100 rounded w-60"></div>
                    </td>
                    <td><div className="h-6 bg-gray-200 rounded-full w-20"></div></td>
                    <td className="text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                    <td className="text-center"><div className="h-6 bg-gray-200 rounded-full w-24 mx-auto"></div></td>
                    <td className="text-center"><div className="h-6 bg-gray-200 rounded-full w-12 mx-auto"></div></td>
                    <td className="text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : ordenados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant">
              <span className="material-symbols-outlined text-2xl">link_off</span>
            </div>
            <div>
              <div className="font-bold text-on-surface font-display text-base">No se encontraron enlaces de competencia</div>
              <div className="text-xs text-on-surface-variant mt-0.5">
                {search || filtroCadena !== 'todas' || filtroProducto !== 'todos' || filtroTipo !== 'todos'
                  ? 'Prueba ajustando los filtros de producto, cadena o búsqueda.'
                  : 'Aún no hay enlaces vinculados en el catálogo de competencia.'}
              </div>
            </div>
            {(search || filtroCadena !== 'todas' || filtroProducto !== 'todos' || filtroTipo !== 'todos') && (
              <button
                onClick={limpiarFiltros}
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
                  <th>Mi Producto Local</th>
                  <th>Cadena Farmacia</th>
                  <th>Variante Competidor</th>
                  <th>Tipo Asociación</th>
                  <th className="text-right">Último Precio Detectado</th>
                  <th className="text-center">Status Scrape</th>
                  <th className="text-center">Scraper Activo</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {itemsPaginados.map(it => (
                  <tr key={it.id} className="hover:bg-surface-low transition-colors">
                    <td>
                      <div className="font-bold text-on-surface font-display text-sm truncate max-w-xs" title={productoNombre(it.id_producto_propio)}>
                        {productoNombre(it.id_producto_propio)}
                      </div>
                      <div className="text-xs text-on-surface-variant font-mono mt-0.5">{it.id_producto_propio}</div>
                    </td>
                    <td className="font-bold text-primary font-display text-sm">{it.cadena}</td>
                    <td>
                      <div className="font-bold text-on-surface text-sm">
                        {it.marca} {it.concentracion || ''} {it.tamano || ''}
                      </div>
                      {it.laboratorio && (
                        <div className="text-xs text-on-surface-variant font-mono mt-0.5">Lab: {it.laboratorio}</div>
                      )}
                      <a href={it.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline truncate max-w-xs font-mono mt-0.5 flex items-center gap-0.5" title={it.url}>
                        <span>Ver Enlace Destino</span>
                        <span className="material-symbols-outlined text-[11px] leading-none">open_in_new</span>
                      </a>
                      {it.estado === 'error' && it.ultimo_error && (
                        <div className="text-[10px] text-error bg-error/5 border border-error/15 px-2 py-1 rounded-xl mt-1.5 font-medium max-w-xs leading-normal flex items-start gap-1 shadow-xs">
                          <span className="material-symbols-outlined text-[12px] mt-0.5 flex-shrink-0 text-error leading-none">warning</span>
                          <span><strong>Error lectura:</strong> {it.ultimo_error}</span>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`text-[10px] uppercase font-mono font-bold px-2.5 py-1 rounded-full border ${
                        it.tipo === 'propio' ? 'bg-secondary/10 text-secondary border-secondary/20' : 'bg-surface-low text-on-surface-variant border-outline-variant'
                      }`}>
                        {it.tipo === 'propio' ? 'Mi Marca' : 'Competencia'}
                      </span>
                    </td>
                    <td className="text-right font-mono font-bold text-primary">
                      {it.ultimo_precio_desc_bs ? (
                        <div>
                          <div className="text-on-surface font-extrabold flex items-center justify-end gap-1">
                            {it.actualizado_manualmente && (
                              <span className="material-symbols-outlined text-xs text-amber-500 font-sans" title="Precio actualizado manualmente por el usuario">edit_note</span>
                            )}
                            {formatPrice(it.ultimo_precio_desc_bs)}
                          </div>
                          {it.ultimo_precio_full_bs && it.ultimo_precio_full_bs !== it.ultimo_precio_desc_bs && (
                            <div className="text-[10px] text-on-surface-variant line-through font-normal">{formatPrice(it.ultimo_precio_full_bs)}</div>
                          )}
                        </div>
                      ) : it.ultimo_precio_full_bs ? (
                        <div className="flex items-center justify-end gap-1">
                          {it.actualizado_manualmente && (
                            <span className="material-symbols-outlined text-xs text-amber-500 font-sans" title="Precio actualizado manualmente por el usuario">edit_note</span>
                          )}
                          <span className="font-extrabold">{formatPrice(it.ultimo_precio_full_bs)}</span>
                        </div>
                      ) : (
                        <span className="text-on-surface-variant/40 font-mono select-none">—</span>
                      )}
                    </td>
                    <td className="text-center">
                      {scrapingItems[it.id] ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 animate-pulse">
                          <span className="material-symbols-outlined animate-spin text-[11px] leading-none">autorenew</span>
                          {scrapingItems[it.id] === 'disparando' ? 'Gatillando...' : 'En cola...'}
                        </span>
                      ) : (
                        <>
                          {it.estado === 'ok' && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-secondary/10 text-secondary border border-secondary/30">
                              <span className="material-symbols-outlined text-[10px] leading-none">check_circle</span>
                              OK
                            </span>
                          )}
                          {it.estado === 'error' && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold font-mono px-2.5 py-1 rounded-full bg-error-container text-error border border-error/20" title={it.ultimo_error}>
                              <span className="material-symbols-outlined text-[10px] leading-none">error</span>
                              Error
                            </span>
                          )}
                          {!it.estado && <span className="text-[10px] font-bold font-mono px-2.5 py-1 bg-surface-low text-on-surface-variant border border-outline-variant rounded-full">Sin Datos</span>}
                        </>
                      )}
                    </td>
                    <td className="text-center">
                      <button onClick={() => handleToggleActivo(it)}
                        className={`text-[10px] uppercase font-mono font-bold px-3 py-1 rounded-full transition-all ${
                          it.activo ? 'bg-secondary/15 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant/40'
                        }`}>
                        {it.activo ? 'Monitorear' : 'Pausado'}
                      </button>
                    </td>
                    <td className="text-right whitespace-nowrap space-x-2.5">
                      <button onClick={() => handleScrapeIndividual(it)}
                        disabled={!!scrapingItems[it.id] || !it.activo}
                        className={`text-xs font-bold inline-flex items-center gap-0.5 ${
                          scrapingItems[it.id] || !it.activo ? 'text-gray-300 cursor-not-allowed' : 'text-secondary hover:text-secondary/80'
                        }`}
                        title={!it.activo ? "Activa la monitorización para poder usar el robot" : "Lanzar robot extractor para esta variante en tiempo real"}>
                        <span className="material-symbols-outlined text-xs">bolt</span>
                        Robot
                      </button>
                      <button onClick={() => setManualPriceItem(it)}
                        className="text-xs text-amber-600 hover:text-amber-700 font-bold inline-flex items-center gap-0.5"
                        title="Corregir precio manualmente si el robot falló">
                        <span className="material-symbols-outlined text-xs">edit_note</span>
                        Precio
                      </button>
                      <button onClick={() => setEditing(it.id)}
                        className="text-xs text-primary hover:text-primary/80 font-bold inline-flex items-center gap-0.5">
                        <span className="material-symbols-outlined text-xs">edit</span>
                        Editar
                      </button>
                      <button onClick={() => handleDelete(it)}
                        className="text-xs text-error hover:text-error/80 font-bold inline-flex items-center gap-0.5">
                        <span className="material-symbols-outlined text-xs">delete</span>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {ordenados.length > 0 && (
          <div className="px-6 py-4 bg-surface-low border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-on-surface-variant font-mono">
              Mostrando <span className="font-bold text-primary">{Math.min(ordenados.length, (paginaActual - 1) * itemsPorPagina + 1)}</span> - <span className="font-bold text-primary">{Math.min(ordenados.length, paginaActual * itemsPorPagina)}</span> de <span className="font-bold text-primary">{ordenados.length}</span> enlaces
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

      {!loading && ordenados.length > 0 && (
        <p className="text-xs text-on-surface-variant font-mono text-center">
          Mostrando {ordenados.length} de {items.length} Enlaces Registrados.
        </p>
      )}

      {editing && (
        <CompetenciaModal
          item={editing === 'new' ? null : items.find(i => i.id === editing)}
          productoIdPreseleccionado={editing === 'new' && filtroProducto !== 'todos' ? filtroProducto : null}
          productos={productos}
          cadenas={cadenas}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Enlace de Competencia?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar "${confirmDelete.marca}" en la cadena "${confirmDelete.cadena}"?\n\nProducto Asociado: ${productos.find(p => p.id_interno === confirmDelete.id_producto_propio)?.nombre || confirmDelete.id_producto_propio}\nURL: ${confirmDelete.url}\n\nLos registros históricos de precios se conservarán.`
            : ''
        }
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Confirm Modal to Delete All Competitor Links and History */}
      <ConfirmModal
        isOpen={confirmDeleteAll}
        title="¿Vaciar Todos los Enlaces de Competencia?"
        message="¿Estás seguro de que deseas eliminar TODOS los enlaces de competencia vinculados, así como todo el historial de precios acumulado?\n\nEsta acción NO se puede deshacer."
        confirmText={deletingAll ? "Eliminando..." : "Sí, Vaciar Enlaces"}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      {/* CSV Mass Upload Competitors Modal */}
      {showCsvModal && (
        <ModalWrapper
          isOpen={showCsvModal}
          onClose={() => !isUploadingCsv && setShowCsvModal(false)}
          title="Importar Enlaces CSV"
          subtitle="Asocia enlaces de forma masiva a tus productos registrados."
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
            <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/60 space-y-1.5 font-mono text-xs">
              <div className="font-bold text-primary border-b border-outline-variant/60 pb-1 mb-1 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">lists</span>
                Columnas Obligatorias del CSV:
              </div>
              <div>id_producto_propio <span className="text-on-surface-variant font-sans font-medium">(ID del Producto, ej. P001)</span></div>
              <div>cadena <span className="text-on-surface-variant font-sans font-medium">(Nombre de la Cadena, ej. Farmatodo)</span></div>
              <div>marca <span className="text-on-surface-variant font-sans font-medium">(Variante/Nombre en competidor)</span></div>
              <div>url <span className="text-on-surface-variant font-sans font-medium">(Enlace completo)</span></div>
              <div>tipo <span className="text-on-surface-variant font-sans font-medium">(Opcional: propio / alternativa)</span></div>
              <div>activo <span className="text-on-surface-variant font-sans font-medium">(Opcional: true / false)</span></div>
              <div>laboratorio <span className="text-on-surface-variant font-sans font-medium">(Opcional: Laboratorio fabricante)</span></div>
              <div>concentracion <span className="text-on-surface-variant font-sans font-medium">(Opcional: Concentración, ej. 500mg)</span></div>
              <div>tamano <span className="text-on-surface-variant font-sans font-medium">(Opcional: Presentación, ej. 10tab)</span></div>
            </div>
            <div className="flex justify-between items-center pt-1">
              <button type="button" onClick={downloadExampleCsv}
                className="text-xs text-primary font-bold hover:underline inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">download</span>
                Descargar Plantilla Ejemplo CSV
              </button>
            </div>

            {/* File drop area */}
            <div
              className={`border-2 border-dashed border-outline-variant hover:border-primary transition-colors rounded-2xl p-8 text-center cursor-pointer bg-surface-container-low ${isUploadingCsv ? 'opacity-50 pointer-events-none' : ''}`}
              onClick={() => !isUploadingCsv && fileInputRef.current.click()}
            >
              {isUploadingCsv ? (
                <div className="flex flex-col items-center justify-center py-2">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                  <p className="mt-3 text-sm font-bold text-primary">Procesando e importando enlaces...</p>
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
          subtitle="Los enlaces de competencia se han actualizado inmediatamente en pantalla."
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
              <span className="text-on-surface-variant text-xs">Enlaces Importados / Actualizados:</span>
              <span className="font-bold font-mono text-xs text-secondary">{csvSummary.successCount}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-on-surface-variant text-xs">Filas Omitidas (Sin Enlace o ID):</span>
              <span className="font-bold font-mono text-xs text-outline">{csvSummary.skippedCount}</span>
            </div>
          </div>
        </ModalWrapper>
      )}

      {/* Manual Price Override Dialog */}
      {manualPriceItem && (
        <ModalWrapper
          isOpen={Boolean(manualPriceItem)}
          onClose={() => setManualPriceItem(null)}
          title="Ingresar Precio Manual"
          subtitle={`Anula los errores del scraper para ${manualPriceItem.marca} en ${manualPriceItem.cadena}.`}
          icon="edit_note"
          maxWidth="max-w-md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <button onClick={() => setManualPriceItem(null)} className="m3-btn-outline h-9 px-4 text-xs">
                Cancelar
              </button>
              <button
                onClick={async () => {
                  const inputVal = document.getElementById('manualPriceInput').value;
                  const price = parseFloat(inputVal);
                  if (isNaN(price) || price <= 0) {
                    addToast('Por favor ingresa un precio válido mayor a 0', 'error');
                    return;
                  }
                  try {
                    const docId = manualPriceItem.id;
                    const ahora = new Date();
                    const runId = 'MANUAL_' + ahora.toISOString().slice(0, 10).replace(/-/g, '') + '_' + ahora.toTimeString().slice(0, 8).replace(/:/g, '');
                    
                    await dbUpsertProductoCompetencia({
                      ...manualPriceItem,
                      ultimo_precio_full_bs: price,
                      ultimo_precio_desc_bs: price,
                      ultimo_scrape: ahora,
                      estado: 'ok',
                      ultimo_error: null,
                    });

                    await dbAddHistoricoPrecio({
                      prod_comp_id: docId,
                      id_producto_propio: manualPriceItem.id_producto_propio,
                      cadena: manualPriceItem.cadena,
                      marca: manualPriceItem.marca,
                      nombre: manualPriceItem.marca + ' (Manual)',
                      precio_full_bs: price,
                      precio_desc_bs: price,
                      tiene_descuento: false,
                      scraped_at: ahora,
                      run_id: runId,
                    });

                    addToast(`Precio de ${manualPriceItem.marca} actualizado manualmente a Bs ${price.toFixed(2)}.`, 'success');
                    setManualPriceItem(null);
                    await cargar(true);
                  } catch (err) {
                    addToast('Error: ' + err.message, 'error');
                  }
                }}
                className="m3-btn-primary h-9 px-5 text-xs"
              >
                Guardar Precio
              </button>
            </div>
          }
        >
          <div className="space-y-4 text-sm text-on-surface">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-primary font-mono">Precio en Bolívares (Bs. *):</label>
              <input
                type="number"
                step="0.01"
                placeholder="Ej: 450.50"
                id="manualPriceInput"
                defaultValue={manualPriceItem.ultimo_precio_desc_bs || manualPriceItem.ultimo_precio_full_bs || ''}
                className="m3-input font-mono"
              />
            </div>
            <p className="text-[11px] text-on-surface-variant italic">
              * Esto establecerá el estado de la URL como "OK" y registrará el precio ingresado en el historial de precios y en el panel.
            </p>
          </div>
        </ModalWrapper>
      )}

      <GitHubConfigModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
      />
    </div>
  );
}

function CompetenciaModal({ item, productoIdPreseleccionado, productos, cadenas, onSave, onClose }) {
  const isNew = !item;
  const productosActivos = productos.filter(p => p.activo);
  const cadenasActivas = cadenas.filter(c => c.activo);

  const initialProdId = item?.id_producto_propio || productoIdPreseleccionado || '';
  const initialProd = productos.find(p => p.id_interno === initialProdId);

  const [form, setForm] = useState({
    id: item?.id || '',
    id_producto_propio: initialProdId,
    cadena: item?.cadena || '',
    tipo: item?.tipo || 'alternativa',
    marca: item?.marca || (initialProd ? initialProd.nombre : ''),
    url: item?.url || '',
    activo: item?.activo ?? true,
    laboratorio: item?.laboratorio || (initialProd ? initialProd.laboratorio || '' : ''),
    concentracion: item?.concentracion || (initialProd ? initialProd.concentracion || '' : ''),
    tamano: item?.tamano || (initialProd ? initialProd.tamano || '' : ''),
  });
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  const selectedProduct = useMemo(() => {
    return productos.find(p => p.id_interno === form.id_producto_propio);
  }, [productos, form.id_producto_propio]);

  const handleProductSelect = (prodId) => {
    setErrorMessage(null);
    const p = productos.find(x => x.id_interno === prodId);
    setForm(f => ({
      ...f,
      id_producto_propio: prodId,
      marca: f.tipo === 'propio' || !f.marca ? (p?.nombre || '') : f.marca,
      laboratorio: f.tipo === 'propio' || !f.laboratorio ? (p?.laboratorio || '') : f.laboratorio,
      concentracion: f.tipo === 'propio' || !f.concentracion ? (p?.concentracion || '') : f.concentracion,
      tamano: f.tipo === 'propio' || !f.tamano ? (p?.tamano || '') : f.tamano,
    }));
  };

  const handleTipoSelect = (tipoVal) => {
    setErrorMessage(null);
    setForm(f => {
      const p = productos.find(x => x.id_interno === f.id_producto_propio);
      return {
        ...f,
        tipo: tipoVal,
        marca: tipoVal === 'propio' && p ? p.nombre : f.marca,
        laboratorio: tipoVal === 'propio' && p ? (p.laboratorio || '') : f.laboratorio,
        concentracion: tipoVal === 'propio' && p ? (p.concentracion || '') : f.concentracion,
        tamano: tipoVal === 'propio' && p ? (p.tamano || '') : f.tamano,
      };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!form.id_producto_propio || !form.cadena || !form.marca || !form.url) {
      setErrorMessage('Por favor completa todos los campos requeridos (*).');
      return;
    }
    setSaving(true);
    const res = await onSave(form, isNew);
    setSaving(false);
    if (res && !res.success) {
      setErrorMessage(res.error || 'Ocurrió un error al intentar guardar los cambios.');
    }
  };

  const handleChange = (key, value) => {
    setErrorMessage(null);
    setForm(f => ({ ...f, [key]: value }));
  };

  const probarUrl = () => {
    if (!form.url) return;
    let u = form.url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = 'https://' + u;
    }
    window.open(u, '_blank', 'noopener,noreferrer');
  };

  return (
    <ModalWrapper
      isOpen={true}
      onClose={onClose}
      title={isNew ? 'Vincular Enlace Competidor' : 'Propiedades de Enlace'}
      subtitle={isNew ? 'Asocia una URL de farmacia externa a tu catálogo' : `Editando ${form.marca} (${form.cadena})`}
      icon="link"
      maxWidth="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {errorMessage && (
          <div className="p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-2xl flex items-start gap-3 text-red-900 dark:text-red-200 text-xs font-semibold animate-fade-in shadow-xs">
            <span className="material-symbols-outlined text-red-600 text-xl shrink-0 select-none">error</span>
            <div className="flex-1 min-w-0">
              <div className="font-bold">No se pudieron guardar los cambios</div>
              <div className="text-[11.5px] font-normal text-red-700 dark:text-red-300 mt-0.5 leading-relaxed break-words">{errorMessage}</div>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-red-500 hover:text-red-800 transition-colors p-0.5"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        )}

        <Field label="Producto en Catálogo Interno *">
          <select required value={form.id_producto_propio}
            onChange={e => handleProductSelect(e.target.value)}
            disabled={!isNew}
            className="m3-input bg-surface-container-lowest text-on-surface">
            <option value="">— Seleccionar —</option>
            {productosActivos.map(p => (
              <option key={p.id} value={p.id_interno}>{p.id_interno} · {p.nombre}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Cadena de Farmacia *">
            <select required value={form.cadena}
              onChange={e => handleChange('cadena', e.target.value)}
              disabled={!isNew}
              className="m3-input bg-surface-container-lowest text-on-surface">
              <option value="">— Seleccionar —</option>
              {cadenasActivas.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
            </select>
          </Field>
          
          <Field label="Tipo de Relación *">
            <select required value={form.tipo} onChange={e => handleTipoSelect(e.target.value)}
              className="m3-input bg-surface-container-lowest text-on-surface">
              {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>

        {form.tipo === 'propio' && selectedProduct && (
          <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 rounded-2xl p-3 text-xs space-y-1">
            <div className="font-bold flex items-center gap-1.5 text-emerald-900 dark:text-emerald-200">
              <span className="material-symbols-outlined text-base">check_circle</span>
              <span>Datos autocompletados desde tu catálogo</span>
            </div>
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-sans">
              Se usará el nombre <strong>"{selectedProduct.nombre}"</strong> y especificaciones registradas. Solo selecciona la cadena e ingresa la URL.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Nombre Comercial / Marca *" hint={form.tipo === 'propio' ? 'Heredado de catálogo' : 'Ej. Acetaminofén, Atamel'}>
            <input type="text" required value={form.marca}
              onChange={e => handleChange('marca', e.target.value)}
              disabled={!isNew}
              placeholder="Ej. Atamel"
              className="m3-input text-on-surface" />
          </Field>

          <Field label="Laboratorio / Fabricante" hint={form.tipo === 'propio' ? 'Heredado de catálogo' : 'Ej. Genven, La Santé'}>
            <input type="text" value={form.laboratorio}
              onChange={e => handleChange('laboratorio', e.target.value)}
              placeholder="Ej. Genven"
              className="m3-input text-on-surface" />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Concentración" hint={form.tipo === 'propio' ? 'Heredado de catálogo' : 'Ej. 650mg, 500mg'}>
            <input type="text" value={form.concentracion}
              onChange={e => handleChange('concentracion', e.target.value)}
              placeholder="Ej. 650mg"
              className="m3-input text-on-surface" />
          </Field>

          <Field label="Tamaño / Presentación" hint={form.tipo === 'propio' ? 'Heredado de catálogo' : 'Ej. 10tab, 20tab, 120ml'}>
            <input type="text" value={form.tamano}
              onChange={e => handleChange('tamano', e.target.value)}
              placeholder="Ej. 10tab"
              className="m3-input text-on-surface" />
          </Field>
        </div>

        <Field label="Dirección URL del Producto *" hint="Dirección exacta para el robot de extracción">
          <div className="flex gap-2">
            <input type="url" required value={form.url}
              onChange={e => handleChange('url', e.target.value)}
              placeholder="https://www.farmatodo.com.ve/producto/..."
              className="flex-1 m3-input text-xs text-on-surface font-mono" />
            <button type="button" onClick={probarUrl} disabled={!form.url}
              className="m3-btn-outline h-9 px-3 text-xs disabled:opacity-50 text-primary whitespace-nowrap">Probar URL ↗</button>
          </div>
        </Field>

        <Field label="Monitoreo Continuo">
          <label className="flex items-center gap-2 px-4 py-3 border border-outline-variant/60 rounded-xl cursor-pointer font-bold text-xs text-primary bg-surface-container-low select-none">
            <input type="checkbox" checked={form.activo}
              onChange={e => handleChange('activo', e.target.checked)}
              className="rounded text-primary focus:ring-primary h-4 w-4" />
            <span>ACTIVAR EXTRACCIÓN DIARIA PARA ESTE ENLACE</span>
          </label>
        </Field>

        {!isNew && (
          <div className="bg-surface-container-low rounded-2xl p-3 text-xs text-on-surface-variant font-mono border border-outline-variant/60">
            Nota: El producto, la cadena y la marca variante no se pueden reasignar para mantener la coherencia histórica.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-outline-variant/60">
          <button type="button" onClick={onClose}
            className="m3-btn-outline h-9 px-4 text-xs">Cancelar</button>
          <button type="submit" disabled={saving}
            className="m3-btn-primary h-9 px-5 text-xs">
            {saving ? 'Guardando...' : isNew ? 'Vincular' : 'Guardar Cambios'}
          </button>
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
