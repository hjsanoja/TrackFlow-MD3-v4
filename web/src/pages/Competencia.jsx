import { useEffect, useState, useMemo, useRef } from 'react';
import { validarCsv } from '../utils/validarCsv';
import ImportPreview from '../components/ImportPreview';
import { useDimensiones } from '../hooks/useDimensiones';
import { useSearchParams } from 'react-router-dom';
import { supabase, isSupabaseActive } from '../supabase';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import GitHubConfigModal from '../components/GitHubConfigModal';
import FichaEnlace from '../components/FichaEnlace';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import { FormSection, Field, ChoiceChips, ComboField, normalizar } from '../components/formulario';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';
import { parseCSV, getRowValue, leerArchivoCsv } from '../utils/csvParser';
import { DIAS_ENLACE_CAIDO, enlaceCaido, describirPresentacion } from '../utils/presentacion';
import {
  dbUpsertProductoCompetencia,
  dbDeleteProductoCompetencia,
  dbDeleteAllProductosCompetencia,
  dbUpsertCompetenciaBulk,
  dbCambiarActivoEnlaces,
  dbRegistrarPrecioManual,
  publicacionIdDe,
  normalizarUrl,
} from '../utils/dbClient';
import { getGitHubConfig, triggerGitHubScraper } from '../utils/githubClient';

// Un solo formato de CSV de enlaces para exportar, para la plantilla y para
// importar (igual que en Productos). Donde el dato es el mismo que en el CSV
// de productos, la columna se llama igual (id_interno, nombre, activo,
// pvp_propio_usd). El laboratorio es el del competidor, no el tuyo, y por eso
// va aparte. Nombre, PVP, precios y captura son informativos: al importar se
// ignoran.
const COLUMNAS_CSV_ENLACES = [
  'id_interno', 'nombre', 'cadena', 'tipo', 'competidor', 'laboratorio_competidor', 'url', 'activo',
  'pvp_propio_usd', 'precio_usd', 'precio_bs', 'precio_oferta_bs', 'ultima_captura',
].map(key => ({ label: key, key }));
const ARCHIVO_REPORTE = 'competencia_enlaces_reporte';
const ARCHIVO_PLANTILLA = 'competencia_enlaces_plantilla_carga';

const esPropio = (it) => String(it.tipo || '').toLowerCase() === 'propio';

// Valor de la primera de estas columnas que exista, comparando el nombre
// entero (sin mayusculas ni signos), no por partes.
const celdaExacta = (row, ...nombres) => {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const nombre of nombres) {
    const clave = Object.keys(row).find(k => norm(k) === norm(nombre));
    const valor = clave ? String(row[clave] ?? '').trim() : '';
    if (valor) return valor;
  }
  return '';
};

export default function Competencia() {
  const {
    productosCompetencia: items,
    productos,
    cadenas,
    bcvRates,
    loadingInitial: loading,
    refreshData: cargar,
    refreshCompetencia,
    setProductosCompetencia,
  } = useData();
  const { addToast } = useToast();
  useDimensiones(); // precarga de laboratorios para el formulario

  const tasaBcv = useMemo(() => {
    if (!bcvRates || bcvRates.length === 0) return 0;
    const ord = [...bcvRates].sort((a, b) => new Date(a.rawDate || 0) - new Date(b.rawDate || 0));
    return Number(ord[ord.length - 1]?.valor) || 0;
  }, [bcvRates]);

  // ------------------------------------------------------------------ estado
  const [editing, setEditing] = useState(null); // 'new' | id del enlace
  const [fichaId, setFichaId] = useState(null);
  const [manualPriceItem, setManualPriceItem] = useState(null);
  const [search, setSearch] = useState('');
  const [filtroProducto, setFiltroProducto] = useState('todos');
  const [filtroCadena, setFiltroCadena] = useState('todas');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [filtroPrecio, setFiltroPrecio] = useState('todos');
  const [filtroActivo, setFiltroActivo] = useState('todos');
  const [orden, setOrden] = useState({ campo: null, dir: 'asc' });
  // Moneda de la columna Precio. Se recuerda en el navegador.
  const [enBs, setEnBs] = useState(() => {
    try { return localStorage.getItem('competencia.moneda') === 'bs'; } catch { return false; }
  });
  const cambiarMoneda = (bs) => {
    setEnBs(bs);
    try { localStorage.setItem('competencia.moneda', bs ? 'bs' : 'usd'); } catch { /* sin almacenamiento */ }
  };
  const [searchParams, setSearchParams] = useSearchParams();

  const [showCsvModal, setShowCsvModal] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [previewCsv, setPreviewCsv] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [scrapingItems, setScrapingItems] = useState({});
  const [isGlobalScraping, setIsGlobalScraping] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);

  const [seleccion, setSeleccion] = useState(() => new Set());
  const [confirmBorrarSel, setConfirmBorrarSel] = useState(false);
  const [procesandoSel, setProcesandoSel] = useState(null);
  const [ocultos, setOcultos] = useState(() => new Set());
  const borradosPendientes = useRef(new Map());

  const fileInputRef = useRef(null);
  const buscadorRef = useRef(null);
  const menuMasRef = useRef(null);

  // Si llegamos con ?producto=140216 (desde Productos), se filtra por el.
  useEffect(() => {
    const productoParam = searchParams.get('producto');
    if (productoParam) setFiltroProducto(productoParam);
  }, [searchParams]);

  const claveFiltros = [search, filtroProducto, filtroCadena, filtroTipo, filtroPrecio, filtroActivo].join('|');
  useEffect(() => { setSeleccion(new Set()); }, [claveFiltros]);

  // "/" lleva al buscador.
  useEffect(() => {
    const alPulsar = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      e.preventDefault();
      buscadorRef.current?.focus();
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, []);

  // Borrados pendientes de deshacer: avisar antes de cerrar la pestana.
  useEffect(() => {
    const avisar = (e) => {
      if (borradosPendientes.current.size === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, []);

  // --------------------------------------------------------------- derivados
  const productoPorId = useMemo(() => {
    const m = new Map();
    (productos || []).forEach(p => m.set(String(p.id_interno || p.id).trim(), p));
    return m;
  }, [productos]);

  // Los enlaces traen el id de la cadena ('Saas'); la pantalla muestra su
  // nombre ('Farmacias SAAS').
  const cadenaPorClave = useMemo(() => {
    const m = new Map();
    (cadenas || []).forEach(c => {
      m.set(String(c.id).toLowerCase(), c);
      m.set(String(c.nombre).toLowerCase(), c);
    });
    return m;
  }, [cadenas]);
  const nombreCadena = (v) => cadenaPorClave.get(String(v || '').toLowerCase())?.nombre || v || '—';
  const idCadena = (v) => cadenaPorClave.get(String(v || '').toLowerCase())?.id || v;

  // Precio de hoy en USD: el de la vista o, si solo hay Bs, con la tasa BCV.
  const precioUsd = (it) => {
    const directo = Number(it.ultimo_precio_desc_usd) || Number(it.ultimo_precio_full_usd) || 0;
    if (directo) return directo;
    const enBs = Number(it.ultimo_precio_desc_bs) || Number(it.ultimo_precio_full_bs) || 0;
    return enBs && tasaBcv ? enBs / tasaBcv : 0;
  };
  const diferencia = (it) => {
    const pvp = Number(productoPorId.get(String(it.id_producto_propio).trim())?.pvp_propio_usd) || 0;
    const precio = precioUsd(it);
    return pvp > 0 && precio > 0 ? ((pvp - precio) / precio) * 100 : null;
  };

  const ORDENES = {
    producto: it => (productoPorId.get(String(it.id_producto_propio).trim())?.nombre || it.id_producto_propio || '').toLowerCase(),
    competidor: it => (esPropio(it) ? '' : (it.marca || '')).toLowerCase(),
    cadena: it => nombreCadena(it.cadena).toLowerCase(),
    captura: it => (it.ultimo_scrape ? new Date(it.ultimo_scrape).getTime() : 0),
    precio: it => precioUsd(it),
    dif: it => diferencia(it) ?? -Infinity,
    estado: it => (it.activo ? 0 : 1),
  };

  const filtrados = useMemo(() => {
    const term = normalizar(search);
    const lista = items.filter(it => {
      if (ocultos.has(it.id)) return false;
      if (filtroProducto !== 'todos' && String(it.id_producto_propio).trim() !== String(filtroProducto).trim()) return false;
      if (filtroCadena !== 'todas' && idCadena(it.cadena) !== filtroCadena) return false;
      if (filtroTipo === 'competidor' && esPropio(it)) return false;
      if (filtroTipo === 'propio' && !esPropio(it)) return false;
      if (filtroActivo === 'activos' && !it.activo) return false;
      if (filtroActivo === 'inactivos' && it.activo) return false;
      if (filtroPrecio === 'con_precio' && !(precioUsd(it) > 0)) return false;
      if (filtroPrecio === 'sin_captura' && it.ultimo_scrape) return false;
      if (filtroPrecio === 'viejo' && !enlaceCaido(it)) return false;
      if (!term) return true;
      const p = productoPorId.get(String(it.id_producto_propio).trim());
      return [p?.nombre, it.id_producto_propio, it.marca, it.laboratorio, it.url, nombreCadena(it.cadena), it.ultimo_nombre]
        .some(v => normalizar(v).includes(term));
    });
    // Orden base: por ID, y dentro de cada producto tu enlace primero y luego
    // las cadenas. Asi tu producto y sus competidores quedan juntos.
    const porBloque = (a, b, signoId = 1) =>
      signoId * String(a.id_producto_propio || '').localeCompare(String(b.id_producto_propio || ''), undefined, { numeric: true }) ||
      (esPropio(b) ? 1 : 0) - (esPropio(a) ? 1 : 0) ||
      nombreCadena(a.cadena).localeCompare(nombreCadena(b.cadena));
    if (!orden.campo) return [...lista].sort((a, b) => porBloque(a, b));
    const signo = orden.dir === 'asc' ? 1 : -1;
    if (orden.campo === 'id') return [...lista].sort((a, b) => porBloque(a, b, signo));
    const valor = ORDENES[orden.campo];
    return [...lista].sort((a, b) => {
      const va = valor(a); const vb = valor(b);
      if (va < vb) return -signo;
      if (va > vb) return signo;
      return porBloque(a, b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, filtroProducto, filtroCadena, filtroTipo, filtroPrecio, filtroActivo, orden, ocultos, productoPorId, cadenaPorClave, tasaBcv]);

  const hayFiltros = filtroProducto !== 'todos' || filtroCadena !== 'todas' || filtroTipo !== 'todos' || filtroPrecio !== 'todos' || filtroActivo !== 'todos';
  const limpiarFiltros = () => {
    setFiltroProducto('todos'); setFiltroCadena('todas'); setFiltroTipo('todos');
    setFiltroPrecio('todos'); setFiltroActivo('todos');
    if (searchParams.get('producto')) setSearchParams({});
  };

  const caidosActivos = useMemo(() => items.filter(it => it.activo && enlaceCaido(it)).length, [items]);
  const productoFiltradoSinEnlaces = filtroProducto !== 'todos' && !items.some(it => String(it.id_producto_propio).trim() === filtroProducto)
    ? productoPorId.get(filtroProducto) || null
    : null;

  // Paginacion (10 por defecto, se recuerda en el navegador).
  const [paginaActual, setPaginaActual] = useState(1);
  const [itemsPorPagina, setItemsPorPagina] = useState(() => {
    try {
      const g = Number(localStorage.getItem('competencia.filasPorPagina'));
      return [10, 25, 50, 100].includes(g) ? g : 10;
    } catch { return 10; }
  });
  const cambiarFilasPorPagina = (n) => {
    setItemsPorPagina(n); setPaginaActual(1);
    try { localStorage.setItem('competencia.filasPorPagina', String(n)); } catch { /* sin almacenamiento */ }
  };
  useEffect(() => { setPaginaActual(1); }, [claveFiltros, orden]);
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / itemsPorPagina));
  const paginados = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filtrados.slice(inicio, inicio + itemsPorPagina);
  }, [filtrados, paginaActual, itemsPorPagina]);

  // Orden por columna: asc, desc, sin orden.
  const alternarOrden = (campo) => setOrden(o => o.campo !== campo ? { campo, dir: 'asc' } : o.dir === 'asc' ? { campo, dir: 'desc' } : { campo: null, dir: 'asc' });
  const encabezado = (campo, children, className = '') => (
    <th aria-sort={orden.campo === campo ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
      <button type="button" onClick={() => alternarOrden(campo)} className={`m3-sort-btn ${orden.campo === campo ? 'is-active' : ''}`}>
        {children}
        <span className="material-symbols-outlined" aria-hidden="true">
          {orden.campo !== campo ? 'unfold_more' : orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
        </span>
      </button>
    </th>
  );

  // -------------------------------------------------------------- seleccion
  const alternarSeleccion = (id) => setSeleccion(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const seleccionados = useMemo(() => items.filter(it => seleccion.has(it.id)), [items, seleccion]);
  const todosFiltradosSeleccionados = filtrados.length > 0 && filtrados.every(it => seleccion.has(it.id));
  const alternarTodosFiltrados = () => setSeleccion(todosFiltradosSeleccionados ? new Set() : new Set(filtrados.map(it => it.id)));

  // Alta o baja con "Deshacer" en el aviso.
  const cambiarActivo = async (lista, activo, { deshacer = true } = {}) => {
    const cambiados = await dbCambiarActivoEnlaces(lista, activo);
    if (cambiados < lista.length) {
      addToast(`Solo se actualizaron ${cambiados} de ${lista.length} enlaces. Revisa los permisos (RLS) de publicaciones.`, 'error');
    } else {
      const texto = lista.length === 1 ? `Enlace ${activo ? 'reactivado' : 'dado de baja'}.` : `${cambiados} enlaces ${activo ? 'reactivados' : 'dados de baja'}.`;
      addToast(texto, 'success', !activo && deshacer ? {
        accion: {
          texto: 'Deshacer',
          onClick: async () => {
            try { await cambiarActivo(lista, true, { deshacer: false }); } catch (err) { addToast('No se pudo deshacer: ' + err.message, 'error'); }
          },
        },
      } : {});
    }
    await cargar(true);
  };
  const handleToggleActivo = async (it) => {
    try { await cambiarActivo([it], !it.activo); } catch (err) { addToast(err.message, 'error'); }
  };
  const cambiarActivoSeleccion = async (activo) => {
    const lista = seleccionados;
    setProcesandoSel({ hechos: 0, total: lista.length });
    try { await cambiarActivo(lista, activo); setSeleccion(new Set()); } catch (err) { addToast('Error al actualizar: ' + err.message, 'error'); }
    setProcesandoSel(null);
  };

  // Borrado con 8 s para deshacer (se lleva el historial de precios del enlace).
  const programarBorrado = (lista) => {
    const ids = lista.map(it => it.id);
    const clave = ids.join('|');
    setOcultos(prev => new Set([...prev, ...ids]));
    const ejecutar = async () => {
      borradosPendientes.current.delete(clave);
      const errores = [];
      for (const it of lista) {
        try { await dbDeleteProductoCompetencia(it); } catch (err) { errores.push(`${it.marca || it.id}: ${err.message}`); }
      }
      if (errores.length) addToast(`${errores.length} enlaces no se eliminaron. ${errores.slice(0, 3).join(' · ')}`, 'error');
      await cargar(true);
      setOcultos(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
    };
    borradosPendientes.current.set(clave, setTimeout(ejecutar, 8000));
    addToast(lista.length === 1 ? 'Enlace eliminado.' : `${lista.length} enlaces eliminados.`, 'success', {
      duracion: 8000,
      accion: {
        texto: 'Deshacer',
        onClick: () => {
          clearTimeout(borradosPendientes.current.get(clave));
          borradosPendientes.current.delete(clave);
          setOcultos(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
          addToast(lista.length === 1 ? 'Enlace restaurado.' : `${lista.length} enlaces restaurados.`, 'info');
        },
      },
    });
  };

  const handleConfirmDeleteAll = async () => {
    setDeletingAll(true);
    try {
      await dbDeleteAllProductosCompetencia();
      addToast('Se eliminaron todos los enlaces de competencia y su historial de precios.', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al vaciar enlaces: ' + err.message, 'error');
    }
    setDeletingAll(false);
    setConfirmDeleteAll(false);
  };

  // ---------------------------------------------------------------- guardar
  const handleSave = async (data, isNew) => {
    try {
      let cleanUrl = (data.url || '').trim();
      if (cleanUrl && !/^https?:\/\//.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
      if (!cleanUrl) throw new Error('La URL es obligatoria');
      try { new URL(cleanUrl); } catch { throw new Error('La URL no es válida. Formato esperado: https://www.ejemplo.com/...'); }

      const currentItem = !isNew ? items.find(i => i.id === editing) : null;

      // La misma URL en la misma cadena ya es un enlace: se edita ese.
      const repetido = items.find(it =>
        it.id !== currentItem?.id &&
        idCadena(it.cadena) === idCadena(data.cadena) &&
        normalizarUrl(it.url || '') === normalizarUrl(cleanUrl));
      if (repetido) {
        throw new Error(`Esa URL ya está vinculada en ${nombreCadena(repetido.cadena)} (producto ${repetido.id_producto_propio}). Edita ese enlace en vez de crear otro.`);
      }

      const labPart = data.laboratorio?.trim() ? `_${data.laboratorio.trim()}` : '';
      const docId = currentItem
        ? currentItem.id
        : `${data.id_producto_propio}_${data.cadena}_${data.marca || 'comp'}${labPart}`.replace(/[\s/\\]+/g, '_');

      await dbUpsertProductoCompetencia({
        id: docId,
        // Al editar, el enlace se identifica por su publicacion: asi se
        // actualiza el existente en vez de crear otro competidor.
        publicacion_id: currentItem ? publicacionIdDe(currentItem) : null,
        id_producto_propio: data.id_producto_propio,
        cadena: data.cadena,
        tipo: data.tipo,
        marca: (data.marca || '').trim(),
        url: cleanUrl,
        activo: data.activo,
        laboratorio: data.laboratorio?.trim() || '',
      });

      addToast(isNew ? 'Enlace vinculado' : 'Cambios guardados', 'success');
      setEditing(null);
      await cargar(true);
      return { success: true };
    } catch (err) {
      const errMsg = err?.message || 'Error al guardar el enlace';
      addToast(errMsg, 'error');
      return { success: false, error: errMsg };
    }
  };

  // ------------------------------------------------------------------ robot
  const handleDispararScraperGlobal = async () => {
    setIsGlobalScraping(true);
    try {
      const config = await getGitHubConfig();
      if (!config || !config.token || !config.repo_owner || !config.repo_name) {
        addToast('Faltan las credenciales de GitHub Actions. Ingrésalas para continuar.', 'info');
        setShowGithubModal(true);
        return;
      }
      await triggerGitHubScraper({ config });
      addToast('Robot lanzado para todos los enlaces activos (GitHub Actions).', 'success');
    } catch (err) {
      if (err.message === 'CONFIG_MISSING') setShowGithubModal(true);
      else addToast('Error al lanzar el robot: ' + err.message, 'error');
    } finally {
      setIsGlobalScraping(false);
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
      await triggerGitHubScraper({ config, payload: { product_id: item.id_producto_propio, doc_id: item.id } });
      setScrapingItems(prev => ({ ...prev, [item.id]: 'esperando' }));
      addToast(`Robot lanzado para "${item.marca}". Esperando el resultado…`, 'info');

      // Se consulta la vista hasta que aparezca una captura nueva (max. 65 s).
      const inicio = Date.now();
      const sondeo = setInterval(async () => {
        try {
          let actualizado = null;
          if (isSupabaseActive()) {
            const { data } = await supabase.from('productos_competencia').select('*').eq('id', item.id).maybeSingle();
            actualizado = data || null;
          }
          const t = actualizado?.ultimo_scrape ? new Date(actualizado.ultimo_scrape).getTime() : 0;
          if (actualizado && t >= inicio - 4000) {
            clearInterval(sondeo);
            setScrapingItems(prev => ({ ...prev, [item.id]: null }));
            setProductosCompetencia(prev => prev.map(p => p.id === item.id ? { ...p, ...actualizado } : p));
            await cargar(true);
            addToast(`Precio actualizado: ${item.marca}`, 'success');
            return;
          }
          if (Date.now() - inicio > 65000) {
            clearInterval(sondeo);
            setScrapingItems(prev => ({ ...prev, [item.id]: null }));
            addToast('El robot no devolvió un precio nuevo todavía. Revisa la ficha en unos minutos.', 'info');
            await cargar(true);
          }
        } catch (e) {
          console.warn('Error en sondeo del scraper:', e);
        }
      }, 3500);
    } catch (err) {
      setScrapingItems(prev => ({ ...prev, [item.id]: null }));
      if (err.message === 'CONFIG_MISSING') setShowGithubModal(true);
      else addToast('Error al lanzar el robot: ' + err.message, 'error');
    }
  };

  // -------------------------------------------------------------------- CSV
  const filaCsvEnlace = (it) => {
    const p = productoPorId.get(String(it.id_producto_propio).trim());
    const full = Number(it.ultimo_precio_full_bs) || 0;
    const desc = Number(it.ultimo_precio_desc_bs) || 0;
    const usd = precioUsd(it);
    const pvp = Number(p?.pvp_propio_usd) || 0;
    return {
      id_interno: it.id_producto_propio || '',
      nombre: p?.nombre || '',
      cadena: nombreCadena(it.cadena),
      tipo: esPropio(it) ? 'propio' : 'competidor',
      competidor: esPropio(it) ? '' : (it.marca || ''),
      laboratorio_competidor: esPropio(it) ? '' : (it.laboratorio || ''),
      url: it.url || '',
      activo: it.activo === false ? 'no' : 'si',
      pvp_propio_usd: pvp ? pvp.toFixed(2) : '',
      precio_usd: usd ? usd.toFixed(2) : '',
      precio_bs: full ? full.toFixed(2) : '',
      precio_oferta_bs: desc && desc !== full ? desc.toFixed(2) : '',
      ultima_captura: it.ultimo_scrape ? String(it.ultimo_scrape).slice(0, 10) : '',
    };
  };

  const handleExportar = () => {
    exportToCSV(ARCHIVO_REPORTE, COLUMNAS_CSV_ENLACES, filtrados.map(filaCsvEnlace));
    addToast(`Exportados ${filtrados.length} enlaces a CSV.`, 'success');
  };

  const descargarPlantilla = () => {
    const filas = items.length > 0
      ? items.map(filaCsvEnlace)
      : [
          { id_interno: '140216', nombre: 'ACETAMINOFEN', cadena: 'Farmatodo', tipo: 'propio', competidor: '', laboratorio_competidor: '', url: 'https://www.farmatodo.com.ve/producto/111243559-acetaminofen-500-la-sante', activo: 'si' },
          { id_interno: '140216', nombre: 'ACETAMINOFEN', cadena: 'Farmatodo', tipo: 'competidor', competidor: 'Atamel 500 mg x 20', laboratorio_competidor: 'CALOX', url: 'https://www.farmatodo.com.ve/producto/114592534-atamel-500', activo: 'si' },
        ];
    exportToCSV(items.length > 0 ? ARCHIVO_PLANTILLA : `${ARCHIVO_PLANTILLA}_ejemplo`, COLUMNAS_CSV_ENLACES, filas);
  };

  // Paso 1: leer y validar. No se escribe nada todavia.
  const handleCsvUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { texto, codificacion, acentosReparados } = await leerArchivoCsv(file);
      const rows = parseCSV(texto);
      if (rows.length === 0) {
        addToast('El archivo CSV está vacío o no se pudieron reconocer sus columnas.', 'error');
        return;
      }
      const idsExistentes = new Set(productos.map(p => String(p.id_interno || p.id || '').trim()).filter(Boolean));
      const informe = validarCsv(rows, 'competencia', { idsExistentes });

      // Cuantos son nuevos y cuantos ya existen (se actualizan).
      const existentes = new Set(items.map(it => `${String(idCadena(it.cadena)).toLowerCase()}|${normalizarUrl(it.url || '')}`));
      let nuevos = 0;
      let yaEstan = 0;
      informe.filasValidas.forEach(row => {
        const url = getRowValue(row, 'url', 'enlace', 'link').trim();
        const cad = String(idCadena(getRowValue(row, 'cadena', 'farmacia').trim())).toLowerCase();
        if (existentes.has(`${cad}|${normalizarUrl(url)}`)) yaEstan++; else nuevos++;
      });
      const notas = [`${nuevos} ${nuevos === 1 ? 'enlace nuevo' : 'enlaces nuevos'} y ${yaEstan} que ya existían (se actualizan). Una celda vacía no cambia nada.`];
      if (acentosReparados || codificacion !== 'UTF-8') notas.push('El archivo venía de Excel: se corrigieron los acentos al leerlo.');
      setPreviewCsv({ informe, nombre: file.name, nota: notas.join(' ') });
    } catch (err) {
      addToast('No se pudo leer el archivo: ' + (err.message || String(err)), 'error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Paso 2: confirmado. Ahora si se escribe.
  const confirmarImportacion = async () => {
    if (!previewCsv) return;
    setIsUploadingCsv(true);
    try {
      const rows = previewCsv.informe.filasValidas;
      const lista = [];
      const vistas = new Set();
      let duplicados = 0;
      rows.forEach((row) => {
        const id_producto = getRowValue(row, 'id_interno', 'id_producto_propio', 'id_producto', 'sku').trim();
        const url = getRowValue(row, 'url', 'enlace', 'link', 'url_competencia').trim();
        if (!url || !id_producto) return;
        const cadena = idCadena(getRowValue(row, 'cadena', 'cadena_farmacia', 'farmacia').trim());
        const clave = `${String(cadena).toLowerCase()}|${normalizarUrl(url)}`;
        if (vistas.has(clave)) { duplicados++; return; }
        vistas.add(clave);

        const tipoRaw = getRowValue(row, 'tipo', 'tipo_enlace').trim().toLowerCase();
        const propio = ['propio', 'propia', 'mi producto', 'mi marca'].includes(tipoRaw);
        const claveActivo = Object.keys(row).find(k => k.trim().toLowerCase() === 'activo');
        const activoRaw = claveActivo ? String(row[claveActivo] ?? '').trim().toLowerCase() : '';
        const existente = items.find(it => `${String(idCadena(it.cadena)).toLowerCase()}|${normalizarUrl(it.url || '')}` === clave);
        // Por nombre exacto: con getRowValue una celda 'competidor' vacia
        // tomaba el valor de 'laboratorio_competidor', que la contiene.
        const marca = celdaExacta(row, 'competidor', 'marca', 'marca_competencia');
        const laboratorio = getRowValue(row, 'laboratorio_competidor', 'laboratorio', 'fabricante').trim();
        const urlSlug = normalizarUrl(url).replace(/[^a-z0-9]/gi, '_');

        lista.push({
          id: existente?.id || `${id_producto}_${String(cadena).replace(/[^a-z0-9]/gi, '')}_${urlSlug}`.replace(/_+/g, '_').slice(0, 100),
          publicacion_id: existente ? publicacionIdDe(existente) : null,
          id_producto_propio: id_producto,
          cadena,
          tipo: propio ? 'propio' : 'alternativa',
          marca: marca || existente?.marca || (propio ? productoPorId.get(id_producto)?.nombre || '' : 'Competidor'),
          url,
          // Sin la columna o vacia se conserva lo guardado (activo por defecto en uno nuevo).
          activo: activoRaw ? !['no', 'false', '0'].includes(activoRaw) : (existente ? existente.activo !== false : true),
          laboratorio: laboratorio || (existente && !esPropio(existente) ? existente.laboratorio || '' : ''),
        });
      });
      if (lista.length === 0) throw new Error('No hay filas con producto y URL.');
      await dbUpsertCompetenciaBulk(lista);
      if (refreshCompetencia) refreshCompetencia();
      await cargar(true);
      addToast(`Importación terminada: ${lista.length} enlaces${duplicados ? ` (${duplicados} repetidos en el archivo, omitidos)` : ''}.`, 'success');
      setShowCsvModal(false);
    } catch (err) {
      addToast('Error importando: ' + (err.message || String(err)), 'error');
    } finally {
      setIsUploadingCsv(false);
      setPreviewCsv(null);
    }
  };

  // ------------------------------------------------------------------ vista
  const fichaItem = fichaId ? items.find(it => it.id === fichaId) : null;
  const opcionesProducto = useMemo(() => [
    ['todos', 'Producto: todos'],
    ...[...(productos || [])]
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '') || String(a.id_interno).localeCompare(String(b.id_interno)))
      .map(p => [String(p.id_interno), `${p.nombre}${p.concentracion ? ` ${p.concentracion}` : ''} · ${p.id_interno}`]),
  ], [productos]);

  // Un solo precio por celda, en la moneda elegida: con los dos no cabia el
  // de Bs. Si hay oferta, debajo va el precio normal.
  const formatoBs = (v) => v.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const precioEnMoneda = (it) => {
    const fullBs = Number(it.ultimo_precio_full_bs) || 0;
    const descBs = Number(it.ultimo_precio_desc_bs) || 0;
    const hoy = enBs ? (descBs || fullBs) : precioUsd(it);
    const oferta = descBs > 0 && fullBs > descBs;
    const normal = !oferta ? 0 : enBs ? fullBs
      : (Number(it.ultimo_precio_full_usd) || (tasaBcv ? fullBs / tasaBcv : 0));
    const fmt = (v) => (enBs ? formatoBs(v) : `$${v.toFixed(2)}`);
    return { texto: hoy > 0 ? fmt(hoy) : null, normal: normal > 0 ? fmt(normal) : null };
  };
  const celdaPrecio = (it) => {
    const { texto, normal } = precioEnMoneda(it);
    return (
      <>
        <div className="m3-cell-primary tabular-nums">{texto || '—'}</div>
        {normal ? (
          <div className="m3-cell-secondary tabular-nums line-through" title={`En oferta. Precio normal: ${normal}`}>{normal}</div>
        ) : !texto && <div className="m3-cell-secondary">sin precio</div>}
      </>
    );
  };
  const celdaCaptura = (it) => {
    const caido = enlaceCaido(it);
    const fecha = it.ultimo_scrape ? new Date(it.ultimo_scrape) : null;
    const dias = fecha ? Math.floor((Date.now() - fecha.getTime()) / 86400000) : null;
    const texto = !fecha ? 'Sin leer' : dias <= 0 ? 'Hoy' : dias === 1 ? 'Ayer' : `${dias} días`;
    return (
      <>
        <div className={`m3-cell-primary ${caido && it.activo ? 'm3-count-stale' : ''}`}
          title={caido ? `Sin precio hace más de ${DIAS_ENLACE_CAIDO} días` : undefined}>{texto}</div>
        <div className="m3-cell-secondary">
          {fecha ? fecha.toLocaleDateString('es-VE', { day: 'numeric', month: 'short' }) : '—'}
        </div>
      </>
    );
  };
  const celdaDif = (it) => {
    const d = diferencia(it);
    if (d === null) return <span className="m3-cell-secondary">—</span>;
    return (
      <span className={`m3-count ${d > 0 ? 'text-error' : ''}`} title={d > 0 ? 'Tu PVP es más caro que este precio' : 'Tu PVP es más barato que este precio'}>
        {d > 0 ? '+' : ''}{d.toFixed(0)}%
      </span>
    );
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Cabecera: misma estructura que Productos. */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">link</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Enlaces de Competencia
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Las URL de las farmacias que vigila el robot, tuyas y de la competencia, con su último precio.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap lg:flex-nowrap items-center shrink-0">
          <button onClick={handleExportar} className="m3-btn-outline" title="Descargar en CSV lo que se ve en la tabla">
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar</span>
          </button>
          <button onClick={() => setShowCsvModal(true)} className="m3-btn-outline" title="Crear o actualizar muchos enlaces con un CSV">
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Carga masiva</span>
          </button>
          <button onClick={() => setEditing('new')} className="m3-btn-primary">
            <span className="material-symbols-outlined text-base">add_link</span>
            <span>Vincular enlace</span>
          </button>
          <details ref={menuMasRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item" disabled={isGlobalScraping}
                onClick={() => { menuMasRef.current?.removeAttribute('open'); handleDispararScraperGlobal(); }}>
                <span className={`material-symbols-outlined ${isGlobalScraping ? 'animate-spin' : ''}`}>{isGlobalScraping ? 'sync' : 'smart_toy'}</span>
                {isGlobalScraping ? 'Lanzando robot…' : 'Ejecutar robot (todos)'}
              </button>
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger"
                disabled={deletingAll || items.length === 0}
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setConfirmDeleteAll(true); }}>
                <span className="material-symbols-outlined">delete_sweep</span>
                {deletingAll ? 'Vaciando…' : 'Vaciar enlaces'}
              </button>
            </div>
          </details>
        </div>
      </div>

      {productoFiltradoSinEnlaces ? (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">link_off</span>
          <span className="m3-body-medium flex-1">
            <strong>{productoFiltradoSinEnlaces.nombre}</strong> todavía no tiene enlaces: el robot no lo vigila.
          </span>
          <button type="button" onClick={() => setEditing('new')} className="m3-btn-text">Vincular enlace</button>
        </div>
      ) : caidosActivos > 0 && filtroPrecio !== 'viejo' && (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">schedule</span>
          <span className="m3-body-medium flex-1">
            <strong>{caidosActivos} {caidosActivos === 1 ? 'enlace activo no tiene' : 'enlaces activos no tienen'} precio</strong> hace más de {DIAS_ENLACE_CAIDO} días: puede que la tienda haya cambiado la URL.
          </span>
          <button type="button" onClick={() => setFiltroPrecio('viejo')} className="m3-btn-text">Ver cuáles</button>
        </div>
      )}

      <section className="m3-data-table" aria-label="Enlaces de competencia">
        <div className="m3-data-table-toolbar">
          {seleccion.size > 0 ? (
            <div className="m3-selection-bar" role="toolbar" aria-label="Acciones sobre los enlaces seleccionados">
              <button type="button" onClick={() => setSeleccion(new Set())} disabled={!!procesandoSel}
                className="m3-icon-btn" title="Quitar selección" aria-label="Quitar selección">
                <span className="material-symbols-outlined">close</span>
              </button>
              <div className="flex flex-col min-w-0 mr-auto">
                <span className="m3-title-medium">
                  {procesandoSel ? `Procesando ${procesandoSel.hechos} de ${procesandoSel.total}…` : `${seleccion.size} ${seleccion.size === 1 ? 'seleccionado' : 'seleccionados'}`}
                </span>
                {!procesandoSel && !todosFiltradosSeleccionados && (
                  <button type="button" onClick={alternarTodosFiltrados} className="self-start text-primary m3-label-medium hover:underline">
                    Seleccionar los {filtrados.length} de esta lista
                  </button>
                )}
              </div>
              {!procesandoSel && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => cambiarActivoSeleccion(false)} className="m3-btn-primary h-10" title="El robot deja de leerlos. Conserva el historial.">
                    <span className="material-symbols-outlined">archive</span>
                    Dar de baja
                  </button>
                  <button type="button" onClick={() => cambiarActivoSeleccion(true)} className="m3-btn-text">
                    <span className="material-symbols-outlined">unarchive</span>
                    Reactivar
                  </button>
                  <button type="button" onClick={() => setConfirmBorrarSel(true)} className="m3-btn-text m3-btn-text-danger">
                    <span className="material-symbols-outlined">delete</span>
                    Eliminar
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <label className="m3-search-field">
                  <span className="material-symbols-outlined" aria-hidden="true">search</span>
                  <input ref={buscadorRef} type="search" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Buscar por producto, competidor, laboratorio, cadena o URL" aria-label="Buscar enlaces" />
                  {search ? (
                    <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  ) : (
                    <kbd className="m3-kbd hidden md:inline-flex" title="Pulsa / para buscar">/</kbd>
                  )}
                </label>
                <div className="flex items-center gap-4 md:ml-auto">
                  <label className="m3-switch-label whitespace-nowrap" title="Moneda de la columna Precio">
                    <span className={enBs ? 'text-on-surface-variant' : 'font-medium'}>$</span>
                    <input type="checkbox" role="switch" checked={enBs} onChange={e => cambiarMoneda(e.target.checked)}
                      className="m3-switch" aria-label="Ver los precios en bolívares" />
                    <span className={enBs ? 'font-medium' : 'text-on-surface-variant'}>Bs</span>
                  </label>
                  <div className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">
                    {filtrados.length === items.length ? `${items.length} enlaces` : `${filtrados.length} de ${items.length} enlaces`}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <FiltroChip etiqueta="Producto" icono="medication" valor={filtroProducto}
                  onChange={v => { setFiltroProducto(v); if (searchParams.get('producto')) setSearchParams({}); }}
                  opciones={opcionesProducto} />
                <FiltroChip etiqueta="Cadena" icono="storefront" valor={filtroCadena === 'todas' ? 'todos' : filtroCadena}
                  onChange={v => setFiltroCadena(v === 'todos' ? 'todas' : v)}
                  opciones={[['todos', 'Cadena: todas'], ...(cadenas || []).map(c => [c.id, c.nombre])]} />
                <FiltroChip etiqueta="Tipo" icono="sell" valor={filtroTipo} onChange={setFiltroTipo}
                  opciones={[['todos', 'Tipo: todos'], ['competidor', 'Competidores'], ['propio', 'Mis productos']]} />
                <FiltroChip etiqueta="Precio" icono="payments" valor={filtroPrecio} onChange={setFiltroPrecio}
                  opciones={[['todos', 'Precio: todos'], ['con_precio', 'Con precio'], ['sin_captura', 'Sin captura'], ['viejo', `Sin precio hace +${DIAS_ENLACE_CAIDO} días`]]} />
                <FiltroChip etiqueta="Estado" icono="toggle_on" valor={filtroActivo} onChange={setFiltroActivo}
                  opciones={[['todos', 'Estado: todos'], ['activos', 'Activos'], ['inactivos', 'De baja']]} />
                {hayFiltros && <button type="button" onClick={limpiarFiltros} className="m3-btn-text">Limpiar filtros</button>}
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-4 space-y-3" aria-busy="true">
            {[1, 2, 3, 4, 5, 6].map(n => <div key={n} className="h-14 rounded-xl m3-skeleton" />)}
          </div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center justify-center gap-3">
            <div className="w-14 h-14 rounded-full bg-surface-container-high flex items-center justify-center">
              <span className="material-symbols-outlined text-2xl">{hayFiltros || search ? 'search_off' : 'link'}</span>
            </div>
            <div className="m3-title-medium text-on-surface">No se encontraron enlaces</div>
            <div className="m3-body-medium">
              {hayFiltros || search ? 'Prueba con otra búsqueda o quita algún filtro.' : 'Aún no hay enlaces. Súbelos con Carga masiva o crea uno con Vincular enlace.'}
            </div>
            {(hayFiltros || search) && (
              <button type="button" onClick={() => { setSearch(''); limpiarFiltros(); }} className="m3-btn-tonal mt-1">Quitar búsqueda y filtros</button>
            )}
          </div>
        ) : (
          <>
            {/* Celular: tarjetas. */}
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Enlaces">
              {paginados.map(it => {
                const p = productoPorId.get(String(it.id_producto_propio).trim());
                const sel = seleccion.has(it.id);
                return (
                  <li key={it.id} className={`m3-product-card ${sel ? 'is-selected' : ''}`}>
                    <input type="checkbox" checked={sel} onChange={() => alternarSeleccion(it.id)} disabled={!!procesandoSel}
                      aria-label={`Seleccionar ${it.marca}`} className="m3-checkbox mt-1" />
                    <button type="button" onClick={() => setFichaId(it.id)} className="flex-1 min-w-0 text-left">
                      <span className="m3-cell-primary">{p?.nombre || it.id_producto_propio}</span>
                      <div className="m3-cell-secondary"><span className="font-mono">{it.id_producto_propio}</span> · {esPropio(it) ? 'Mi producto' : it.marca} · {nombreCadena(it.cadena)}</div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                        <span className="m3-cell-primary tabular-nums">{precioEnMoneda(it).texto || 'Sin precio'}{enBs && precioEnMoneda(it).texto ? ' Bs' : ''}</span>
                        {celdaDif(it)}
                        <span className={`m3-status ${it.activo ? 'is-on' : ''}`}>{it.activo ? 'Activo' : 'De baja'}</span>
                      </div>
                    </button>
                    <button type="button" onClick={() => setEditing(it.id)} className="m3-icon-btn" aria-label={`Editar ${it.marca}`}>
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Misma geometria de columnas que la tabla de Productos. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="m3-table m3-table-productos">
                <colgroup>
                  <col className="w-12" />
                  <col className="w-[84px]" />
                  <col />
                  <col className="w-[14%]" />
                  <col className="w-[11%]" />
                  <col className="w-[88px]" />
                  <col className="w-[120px]" />
                  <col className="w-[72px]" />
                  <col className="w-[104px]" />
                  <col className="w-[136px]" />
                </colgroup>
                <thead className="m3-sticky-header">
                  <tr>
                    <th>
                      <input type="checkbox" checked={todosFiltradosSeleccionados} onChange={alternarTodosFiltrados}
                        disabled={!!procesandoSel} title={`Seleccionar los ${filtrados.length} enlaces de esta lista`}
                        aria-label="Seleccionar todos los enlaces de esta lista" className="m3-checkbox" />
                    </th>
                    {encabezado('id', 'ID')}
                    {encabezado('producto', 'Producto')}
                    {encabezado('competidor', 'Competidor')}
                    {encabezado('cadena', 'Cadena')}
                    {encabezado('captura', 'Captura')}
                    {encabezado('precio', enBs ? 'Precio Bs' : 'Precio $', 'text-right')}
                    {encabezado('dif', 'Dif.', 'text-center')}
                    {encabezado('estado', 'Estado')}
                    <th className="m3-sticky-actions"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {paginados.map(it => {
                    const p = productoPorId.get(String(it.id_producto_propio).trim());
                    const sel = seleccion.has(it.id);
                    const propio = esPropio(it);
                    return (
                      <tr key={it.id} className={sel ? 'm3-row-selected' : ''}>
                        <td>
                          <input type="checkbox" checked={sel} onChange={() => alternarSeleccion(it.id)} disabled={!!procesandoSel}
                            aria-label={`Seleccionar ${it.marca}`} className="m3-checkbox" />
                        </td>
                        <td><span className="m3-cell-primary font-mono tabular-nums">{it.id_producto_propio}</span></td>
                        <td>
                          <button type="button" onClick={() => setFichaId(it.id)} className="m3-cell-link min-w-0" title="Abrir la ficha del enlace">
                            <span className="m3-cell-primary">{p?.nombre || it.id_producto_propio}</span>
                          </button>
                          <div className="m3-cell-secondary" title={p ? [p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ') : ''}>
                            {p ? [p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ') || '—' : 'no está en el catálogo'}
                          </div>
                        </td>
                        <td>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="m3-cell-primary" title={propio ? 'Tu producto en esta cadena' : it.marca}>{propio ? 'Mi producto' : (it.marca || '—')}</span>
                            <a href={it.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-on-surface-variant hover:text-primary"
                              title="Abrir en la tienda" aria-label={`Abrir ${it.marca} en la tienda`}>
                              <span className="material-symbols-outlined text-[16px] align-middle">open_in_new</span>
                            </a>
                          </div>
                          <div className="m3-cell-secondary">{it.laboratorio || '—'}</div>
                        </td>
                        <td>
                          <div className="m3-cell-primary">{nombreCadena(it.cadena)}</div>
                          <div className="m3-cell-secondary">{propio ? 'Propio' : 'Competidor'}</div>
                        </td>
                        <td>{celdaCaptura(it)}</td>
                        <td className="text-right">{celdaPrecio(it)}</td>
                        <td className="text-center">{celdaDif(it)}</td>
                        <td><span className={`m3-status ${it.activo ? 'is-on' : ''}`}>{it.activo ? 'Activo' : 'De baja'}</span></td>
                        <td className="m3-sticky-actions">
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => setEditing(it.id)} className="m3-icon-btn" title="Editar" aria-label={`Editar ${it.marca}`}>
                              <span className="material-symbols-outlined">edit</span>
                            </button>
                            <button type="button" onClick={() => handleToggleActivo(it)} className="m3-icon-btn"
                              title={it.activo ? 'Dar de baja' : 'Reactivar'} aria-label={`${it.activo ? 'Dar de baja' : 'Reactivar'} ${it.marca}`}>
                              <span className="material-symbols-outlined">{it.activo ? 'archive' : 'unarchive'}</span>
                            </button>
                            <button type="button" onClick={() => setConfirmDelete(it)} className="m3-icon-btn m3-icon-btn-danger" title="Eliminar" aria-label={`Eliminar ${it.marca}`}>
                              <span className="material-symbols-outlined">delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {filtrados.length > 0 && (
          <footer className="m3-data-table-footer">
            <label className="flex items-center gap-2 m3-body-medium text-on-surface-variant">
              Filas por página
              <Select value={itemsPorPagina} onChange={e => cambiarFilasPorPagina(Number(e.target.value))} className="m3-rows-select">
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
            <span className="m3-body-medium text-on-surface-variant sm:ml-auto">
              {Math.min(filtrados.length, (paginaActual - 1) * itemsPorPagina + 1)}–{Math.min(filtrados.length, paginaActual * itemsPorPagina)} de {filtrados.length}
            </span>
            {totalPaginas > 1 && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPaginaActual(p => Math.max(1, p - 1))} disabled={paginaActual === 1} className="m3-icon-btn" aria-label="Página anterior">
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <span className="m3-label-large px-2">Página {paginaActual} de {totalPaginas}</span>
                <button type="button" onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))} disabled={paginaActual === totalPaginas} className="m3-icon-btn" aria-label="Página siguiente">
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
              </div>
            )}
          </footer>
        )}
      </section>

      {fichaItem && (
        <FichaEnlace
          enlace={fichaItem}
          producto={productoPorId.get(String(fichaItem.id_producto_propio).trim())}
          nombreCadena={nombreCadena}
          precioUsd={precioUsd}
          robotOcupado={Boolean(scrapingItems[fichaItem.id])}
          onClose={() => setFichaId(null)}
          onEditar={() => { setFichaId(null); setEditing(fichaItem.id); }}
          onPrecioManual={() => setManualPriceItem(fichaItem)}
          onRobot={() => handleScrapeIndividual(fichaItem)}
          onAlternarActivo={() => handleToggleActivo(fichaItem)}
        />
      )}

      {editing && (
        <EnlaceModal
          item={editing === 'new' ? null : items.find(i => i.id === editing)}
          productoIdPreseleccionado={filtroProducto !== 'todos' ? filtroProducto : ''}
          productos={productos}
          cadenas={cadenas}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {manualPriceItem && (
        <PrecioManualModal
          item={manualPriceItem}
          nombreCadena={nombreCadena}
          onClose={() => setManualPriceItem(null)}
          onGuardar={async (precio, oferta) => {
            await dbRegistrarPrecioManual(manualPriceItem, precio, oferta);
            addToast(`Precio de ${manualPriceItem.marca} registrado: Bs ${(oferta || precio).toFixed(2)}.`, 'success');
            setManualPriceItem(null);
            await cargar(true);
          }}
        />
      )}

      {showCsvModal && (
        <ModalWrapper
          isOpen={showCsvModal}
          onClose={() => !isUploadingCsv && setShowCsvModal(false)}
          title="Carga masiva de enlaces"
          subtitle="Crea o actualiza muchos enlaces con un CSV."
          icon="upload_file"
          maxWidth="max-w-lg"
          footer={<button onClick={() => setShowCsvModal(false)} disabled={isUploadingCsv} className="m3-btn-text">Cerrar</button>}
        >
          <div className="space-y-4 text-sm text-on-surface">
            <div className="m3-card-outlined p-4 space-y-1 font-mono text-xs">
              <div className="font-bold text-primary pb-1 flex items-center gap-1.5 font-sans">
                <span className="material-symbols-outlined text-sm">lists</span>
                Columnas del CSV
              </div>
              <div>id_interno, cadena, url <span className="text-on-surface-variant font-sans font-medium">(obligatorias)</span></div>
              <div>tipo <span className="text-on-surface-variant font-sans font-medium">(propio / competidor)</span>, competidor, laboratorio_competidor</div>
              <div>activo <span className="text-on-surface-variant font-sans font-medium">(si / no)</span></div>
              <div className="font-sans font-medium text-on-surface-variant pt-1">
                nombre, pvp_propio_usd y las columnas de precio y captura son informativas: al importar se ignoran. Una celda vacía no cambia nada.
                Los archivos viejos (id_producto_propio, laboratorio) se siguen aceptando.
              </div>
            </div>
            <button type="button" onClick={descargarPlantilla} className="m3-btn-text px-0">
              <span className="material-symbols-outlined">download</span>
              Descargar plantilla de carga (enlaces actuales)
            </button>
            <div
              className={`border-2 border-dashed border-outline-variant hover:border-primary transition-colors rounded-2xl p-8 text-center cursor-pointer bg-surface-container-low ${isUploadingCsv ? 'opacity-50 pointer-events-none' : ''}`}
              onClick={() => !isUploadingCsv && fileInputRef.current?.click()}
            >
              <span className="material-symbols-outlined text-4xl text-primary">upload_file</span>
              <p className="mt-2 text-sm font-bold text-primary">Haz clic para elegir el archivo CSV</p>
              <p className="text-xs text-on-surface-variant mt-1">Comas, punto y coma o tabulaciones. Vale el que guarda Excel.</p>
              <input type="file" ref={fileInputRef} onChange={handleCsvUpload} accept=".csv" className="hidden" disabled={isUploadingCsv} />
            </div>
          </div>
        </ModalWrapper>
      )}

      {previewCsv && (
        <ImportPreview
          informe={previewCsv.informe}
          nombreArchivo={previewCsv.nombre}
          importando={isUploadingCsv}
          nota={previewCsv.nota}
          onConfirmar={confirmarImportacion}
          onCancelar={() => setPreviewCsv(null)}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar enlace?"
        message={confirmDelete
          ? `Se eliminará el enlace de "${confirmDelete.marca}" en ${nombreCadena(confirmDelete.cadena)} junto con su historial de precios.\n\nTendrás 8 segundos para deshacerlo. Si solo quieres que el robot deje de leerlo, usa "Dar de baja".`
          : ''}
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger
        onConfirm={() => { const it = confirmDelete; setConfirmDelete(null); programarBorrado([it]); }}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmModal
        isOpen={confirmBorrarSel}
        title={`¿Eliminar ${seleccionados.length} enlaces?`}
        message={`Se eliminarán ${seleccionados.length} enlaces junto con su historial de precios.\n\nTendrás 8 segundos para deshacerlo; después no hay vuelta atrás. Si solo quieres que el robot deje de leerlos, usa "Dar de baja".`}
        confirmText={`Eliminar ${seleccionados.length}`}
        cancelText="Cancelar"
        isDanger
        onConfirm={() => { const lista = seleccionados; setConfirmBorrarSel(false); setSeleccion(new Set()); programarBorrado(lista); }}
        onCancel={() => setConfirmBorrarSel(false)}
      />

      <ConfirmModal
        isOpen={confirmDeleteAll}
        title="¿Vaciar todos los enlaces?"
        message="Se eliminarán TODOS los enlaces de competencia y su historial de precios. Esta acción no se puede deshacer."
        confirmText={deletingAll ? 'Vaciando…' : 'Vaciar enlaces'}
        cancelText="Cancelar"
        isDanger
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      <GitHubConfigModal isOpen={showGithubModal} onClose={() => setShowGithubModal(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulario de enlace: misma estructura que el de producto.
// ---------------------------------------------------------------------------
function EnlaceModal({ item, productoIdPreseleccionado, productos, cadenas, onSave, onClose }) {
  const dimensiones = useDimensiones();
  const isNew = !item;
  const cadenasActivas = (cadenas || []).filter(c => c.activo !== false);

  // El producto se elige escribiendo: "140216 · ACETAMINOFEN 500 mg · 20 tabletas".
  const etiquetaProducto = (p) => `${p.id_interno} · ${p.nombre}${p.concentracion ? ` ${p.concentracion}` : ''} · ${describirPresentacion(p)}`;
  const opcionesProducto = useMemo(() => (productos || []).filter(p => p.activo !== false).map(etiquetaProducto), [productos]);
  const productoDesdeTexto = (texto) => {
    const id = String(texto || '').split(' · ')[0].trim();
    return (productos || []).find(p => String(p.id_interno) === id) || null;
  };

  const idInicial = item?.id_producto_propio || productoIdPreseleccionado || '';
  const productoInicial = (productos || []).find(p => String(p.id_interno) === String(idInicial));
  const cadenaInicial = (() => {
    if (!item?.cadena) return '';
    const c = (cadenas || []).find(x => String(x.id).toLowerCase() === String(item.cadena).toLowerCase() || String(x.nombre).toLowerCase() === String(item.cadena).toLowerCase());
    return c?.id || item.cadena;
  })();

  const [productoTexto, setProductoTexto] = useState(productoInicial ? etiquetaProducto(productoInicial) : '');
  const [form, setForm] = useState({
    cadena: cadenaInicial,
    tipo: item ? (String(item.tipo) === 'propio' ? 'propio' : 'alternativa') : 'alternativa',
    marca: item && String(item.tipo) !== 'propio' ? item.marca || '' : '',
    laboratorio: item && String(item.tipo) !== 'propio' ? item.laboratorio || '' : '',
    url: item?.url || '',
    activo: item?.activo ?? true,
  });
  const [errores, setErrores] = useState({});
  const [saving, setSaving] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState(null);

  const cambiar = (k, v) => { setErrorGeneral(null); setErrores(e => ({ ...e, [k]: undefined })); setForm(f => ({ ...f, [k]: v })); };
  const producto = productoDesdeTexto(productoTexto);

  // Aviso si la URL es de otra web que la de la cadena elegida.
  const avisoUrl = useMemo(() => {
    const c = cadenasActivas.find(x => x.id === form.cadena);
    if (!c?.website || !form.url.trim()) return null;
    try {
      const url = new URL(/^https?:\/\//.test(form.url) ? form.url : `https://${form.url}`);
      const web = new URL(/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`);
      const a = url.hostname.replace(/^www\./, '');
      const b = web.hostname.replace(/^www\./, '');
      return a.endsWith(b) || b.endsWith(a) ? null : `Esta URL es de ${a}, pero ${c.nombre} usa ${b}.`;
    } catch {
      return null;
    }
  }, [form.url, form.cadena, cadenasActivas]);

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    const e = {};
    if (!producto) e.producto = 'Elige un producto de la lista';
    if (!form.cadena) e.cadena = 'Elige la cadena';
    if (!form.url.trim()) e.url = 'Obligatoria';
    if (form.tipo !== 'propio' && !form.marca.trim()) e.marca = 'Escribe el nombre del competidor';
    setErrores(e);
    if (Object.keys(e).length > 0) {
      setTimeout(() => {
        const campo = document.querySelector('#enlace-form .m3-field.has-error');
        campo?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        campo?.querySelector('input')?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    setSaving(true);
    const res = await onSave({
      id_producto_propio: producto.id_interno,
      cadena: form.cadena,
      tipo: form.tipo,
      marca: form.tipo === 'propio' ? producto.nombre : form.marca.trim(),
      laboratorio: form.tipo === 'propio' ? producto.laboratorio || '' : form.laboratorio.trim(),
      url: form.url.trim(),
      activo: form.activo,
    }, isNew);
    setSaving(false);
    if (res && !res.success) setErrorGeneral(res.error || 'No se pudo guardar el enlace.');
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={isNew ? 'Vincular enlace' : 'Editar enlace'}
      subtitle={isNew ? 'Los campos con * son obligatorios.' : `${item.marca || ''}`}
      icon={isNew ? 'add_link' : 'edit'}
      maxWidth="max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 w-full">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" checked={form.activo} onChange={e => cambiar('activo', e.target.checked)} className="m3-switch" />
            <span>{form.activo ? 'Activo: el robot lo lee' : 'De baja'}</span>
          </label>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
            <button type="submit" form="enlace-form" disabled={saving} className="m3-btn-primary h-10 px-6">
              {saving ? 'Guardando…' : isNew ? 'Vincular enlace' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      }
    >
      <form id="enlace-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {errorGeneral && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{errorGeneral}</span>
          </div>
        )}

        <FormSection titulo="Producto y cadena" icono="storefront">
          <Field label="Producto" requerido error={errores.producto} hint="Escribe el ID o el nombre y elige de la lista">
            <ComboField value={productoTexto} onChange={v => { setProductoTexto(v); setErrores(e => ({ ...e, producto: undefined })); }}
              opciones={opcionesProducto} placeholder="140216 · ACETAMINOFEN 500 mg" />
          </Field>
          <Field label="Cadena" requerido error={errores.cadena}>
            <ChoiceChips valor={form.cadena} onChange={v => cambiar('cadena', v)}
              opciones={cadenasActivas.map(c => [c.id, c.nombre])} nombre="cadena" />
          </Field>
          <Field label="Tipo de enlace" requerido>
            <ChoiceChips valor={form.tipo} onChange={v => cambiar('tipo', v)}
              opciones={[['alternativa', 'Competidor'], ['propio', 'Mi producto en esta cadena']]} nombre="tipo" />
          </Field>
        </FormSection>

        <FormSection titulo="Enlace" icono="link">
          <Field label="URL del producto en la tienda" requerido error={errores.url} aviso={avisoUrl}
            hint="Copia la dirección de la página del producto">
            <div className="relative">
              <input type="url" inputMode="url" value={form.url} onChange={e => cambiar('url', e.target.value)}
                placeholder="https://www.farmatodo.com.ve/producto/…" className="m3-input pr-12" />
              {form.url.trim() && (
                <a href={/^https?:\/\//.test(form.url) ? form.url : `https://${form.url}`} target="_blank" rel="noopener noreferrer"
                  className="m3-icon-btn m3-icon-btn-sm absolute right-2 top-1/2 -translate-y-1/2" title="Abrir para comprobar" aria-label="Abrir la URL">
                  <span className="material-symbols-outlined">open_in_new</span>
                </a>
              )}
            </div>
          </Field>
        </FormSection>

        {form.tipo !== 'propio' && (
          <FormSection titulo="Competidor" icono="groups">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Nombre del competidor" requerido error={errores.marca} hint="Como lo vende la tienda. Ej: Atamel 500 mg x 20">
                <input type="text" value={form.marca} onChange={e => cambiar('marca', e.target.value)} className="m3-input" />
              </Field>
              <Field label="Laboratorio" hint="Fabricante del competidor">
                <ComboField value={form.laboratorio} onChange={v => cambiar('laboratorio', v)}
                  opciones={dimensiones.laboratorios} cargando={!dimensiones.cargado} permitirNuevo />
              </Field>
            </div>
          </FormSection>
        )}
      </form>
    </ModalWrapper>
  );
}

// Precio cargado a mano cuando el robot falla.
function PrecioManualModal({ item, nombreCadena, onClose, onGuardar }) {
  const [precio, setPrecio] = useState(item.ultimo_precio_full_bs ? String(item.ultimo_precio_full_bs) : '');
  const [oferta, setOferta] = useState(
    item.ultimo_precio_desc_bs && item.ultimo_precio_desc_bs !== item.ultimo_precio_full_bs ? String(item.ultimo_precio_desc_bs) : '');
  const [error, setError] = useState(null);
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    const p = parseFloat(String(precio).replace(',', '.'));
    const o = oferta ? parseFloat(String(oferta).replace(',', '.')) : null;
    if (!(p > 0)) { setError('Escribe un precio mayor que 0'); return; }
    if (o !== null && (!(o > 0) || o > p)) { setError('La oferta tiene que ser mayor que 0 y no mayor que el precio normal'); return; }
    setGuardando(true);
    try { await onGuardar(p, o); } catch (err) { setError(err.message || String(err)); setGuardando(false); }
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title="Precio manual"
      subtitle={`${item.marca} en ${nombreCadena(item.cadena)}`}
      icon="edit_note"
      maxWidth="max-w-md"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
          <button type="button" onClick={guardar} disabled={guardando} className="m3-btn-primary h-10 px-6">{guardando ? 'Guardando…' : 'Guardar precio'}</button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{error}</span>
          </div>
        )}
        <Field label="Precio normal (Bs)" requerido>
          <input type="text" inputMode="decimal" value={precio} onChange={e => { setPrecio(e.target.value); setError(null); }} placeholder="450.50" className="m3-input tabular-nums" autoFocus />
        </Field>
        <Field label="Precio de oferta (Bs)" hint="Vacío si no hay oferta">
          <input type="text" inputMode="decimal" value={oferta} onChange={e => { setOferta(e.target.value); setError(null); }} className="m3-input tabular-nums" />
        </Field>
        <p className="m3-body-small text-on-surface-variant">
          Se guarda como una captura de hoy, con la última tasa BCV, y pasa a ser el precio vigente de este enlace.
        </p>
      </div>
    </ModalWrapper>
  );
}
