import { useEffect, useState, useMemo, useRef } from 'react';
import { validarCsv, resolverUnidadNegocio } from '../utils/validarCsv';
import ImportPreview from '../components/ImportPreview';
import FichaProducto, { competidorMasBarato, precioEnlaceUsd } from '../components/FichaProducto';
import ProductDetailModal from '../components/ProductDetailModal';
import { useBcvRate } from '../hooks/useBcvRate';
import { useDimensiones, invalidarDimensiones } from '../hooks/useDimensiones';
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
  dbUpsertCompetenciaBulk,
  dbNombresDimensionesCerradas,
  dbCambiarActivoProductos
} from '../utils/dbClient';

// Un solo formato de CSV de productos para exportar, para la plantilla y para
// importar: mismos encabezados, mismo orden, en minusculas y sin acentos, que
// son los nombres que lee el importador. Asi cualquier archivo que sale del
// panel se puede editar y volver a subir tal cual.
//
// tipo_mercado es MARCA o GENERICO (dim_productos.tipo_mercado, fase 18).
// Lleva `activo` para que reimportar no reactive productos dados de baja.
// En los dos, una columna ausente conserva lo guardado.
const COLUMNAS_CSV_PRODUCTOS = [
  'id_interno', 'nombre', 'codigo_barra', 'principio_activo', 'concentracion',
  'tamano', 'forma_farmaceutica', 'laboratorio', 'categoria', 'unidad_negocio', 'tipo_mercado', 'activo',
].map(key => ({ label: key, key }));

const filaCsvProducto = p => ({
  id_interno: p.id_interno || '',
  nombre: p.nombre || '',
  codigo_barra: p.codigo_barra || '',
  principio_activo: p.principio_activo || '',
  concentracion: p.concentracion || '',
  tamano: p.tamano || '',
  forma_farmaceutica: p.forma_farmaceutica || '',
  laboratorio: p.laboratorio || '',
  categoria: p.categoria || '',
  unidad_negocio: p.unidad_negocio || '',
  tipo_mercado: (p.market_type || 'GENERICO').toUpperCase(),
  activo: p.activo === false ? 'no' : 'si',
});

// Filtro como chip con menu: ocupa el ancho de su texto y no cuatro grupos de
// botones. Con un valor distinto de 'todos' se marca como activo (check).
function FiltroChip({ etiqueta, icono, valor, onChange, opciones }) {
  const activo = valor !== 'todos';
  return (
    <label className={`m3-filter-chip ${activo ? 'is-active' : ''}`}>
      <span className="material-symbols-outlined" aria-hidden="true">{activo ? 'check' : icono}</span>
      <select value={valor} onChange={e => onChange(e.target.value)} aria-label={etiqueta}>
        {opciones.map(([v, texto]) => <option key={v} value={v}>{texto}</option>)}
      </select>
      <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
    </label>
  );
}

// "20 tabletas", "120 ml · Jarabe", "30 g · Crema". Antes salia "20 unidad"
// mas una etiqueta "20u", y en los jarabes "120u", que se leia como 120
// unidades. El volumen y el peso se dicen en ml y g; las unidades se nombran
// con la forma farmaceutica cuando la hay.
const NOMBRES_POR_FORMA = [
  [/tableta/i, 'tableta', 'tabletas'],
  [/c[aá]psula/i, 'cápsula', 'cápsulas'],
  [/comprimido/i, 'comprimido', 'comprimidos'],
  [/sobre/i, 'sobre', 'sobres'],
  [/ampolla/i, 'ampolla', 'ampollas'],
  [/[oó]vulo/i, 'óvulo', 'óvulos'],
];

function describirPresentacion(p) {
  const forma = p.forma_farmaceutica || '';
  const m = String(p.tamano || '').match(/^\s*([\d.,]+)\s*(ml|g|unidad(?:es)?)?/i);
  if (!m) return forma || '—';
  const n = Number(m[1].replace(',', '.'));
  const cantidad = Number.isFinite(n) ? n.toLocaleString('es-VE') : m[1];
  const unidad = (m[2] || 'unidad').toLowerCase();
  if (unidad === 'ml' || unidad === 'g') return forma ? `${cantidad} ${unidad} · ${forma}` : `${cantidad} ${unidad}`;
  const nombres = NOMBRES_POR_FORMA.find(([re]) => re.test(forma));
  if (nombres) return `${cantidad} ${n === 1 ? nombres[1] : nombres[2]}`;
  const texto = `${cantidad} ${n === 1 ? 'unidad' : 'unidades'}`;
  return forma ? `${texto} · ${forma}` : texto;
}

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
  // Se piden al entrar en la pantalla y no al abrir el formulario: asi las
  // listas ya estan cargadas cuando se necesitan.
  useDimensiones();
  const [fichaId, setFichaId] = useState(null);
  const [analisis, setAnalisis] = useState(null); // { producto, competencia }
  const bcv = useBcvRate();
  const [search, setSearch] = useState('');
  const [filtroActivo, setFiltroActivo] = useState('todos');
  const [filtroUrls, setFiltroUrls] = useState('todos'); // todos | con_urls | sin_urls
  const [filtroTipo, setFiltroTipo] = useState('todos'); // todos | generico | marca
  const [filtroUn, setFiltroUn] = useState('todos'); // todos | lasante | pharmetique | otc

  // Seleccion multiple (por id). Se vacia al cambiar la busqueda o los
  // filtros, para no borrar o dar de baja productos que ya no se ven.
  const [seleccion, setSeleccion] = useState(() => new Set());
  const [confirmBorrarSel, setConfirmBorrarSel] = useState(false);
  const [procesandoSel, setProcesandoSel] = useState(null); // { hechos, total }
  useEffect(() => { setSeleccion(new Set()); }, [search, filtroActivo, filtroUrls, filtroTipo, filtroUn]);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [progresoCsv, setProgresoCsv] = useState(null);
  const [csvSummary, setCsvSummary] = useState(null);
  // Informe de validación pendiente de confirmación
  const [previewCsv, setPreviewCsv] = useState(null);
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

  const hayFiltros = filtroActivo !== 'todos' || filtroUrls !== 'todos' || filtroTipo !== 'todos' || filtroUn !== 'todos';
  const limpiarFiltros = () => {
    setFiltroActivo('todos');
    setFiltroUrls('todos');
    setFiltroTipo('todos');
    setFiltroUn('todos');
  };

  // Las unidades de negocio salen del catalogo, no de una lista fija: una
  // unidad nueva aparece sola en el filtro.
  const unidadesDisponibles = useMemo(() => {
    const vistas = new Map();
    productos.forEach(p => {
      const nombre = p.unidad_negocio || 'La Sante';
      vistas.set(nombre.toLowerCase().replace(/\s/g, ''), nombre);
    });
    return [...vistas.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [productos]);

  // "/" lleva al buscador, como en Gmail o GitHub.
  const buscadorRef = useRef(null);
  const menuMasRef = useRef(null);
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

  const huerfanos = useMemo(() => {
    return productos.filter(p => p.activo && (urlsPorProducto.get(p.id_interno) || []).length === 0).length;
  }, [productos, urlsPorProducto]);

  const [paginaActual, setPaginaActual] = useState(1);
  // Se recuerda en este navegador. 10 por defecto.
  const [itemsPorPagina, setItemsPorPagina] = useState(() => {
    try {
      const guardado = Number(localStorage.getItem('productos.filasPorPagina'));
      return [10, 25, 50, 100].includes(guardado) ? guardado : 10;
    } catch {
      return 10;
    }
  });
  const cambiarFilasPorPagina = (n) => {
    setItemsPorPagina(n);
    setPaginaActual(1);
    try { localStorage.setItem('productos.filasPorPagina', String(n)); } catch { /* sin almacenamiento */ }
  };

  useEffect(() => {
    setPaginaActual(1);
  }, [search, filtroActivo, filtroUrls, filtroTipo, filtroUn]);

  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / itemsPorPagina));
  const productosPaginados = useMemo(() => {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    return filtrados.slice(inicio, inicio + itemsPorPagina);
  }, [filtrados, paginaActual, itemsPorPagina]);

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
        forma_farmaceutica: (data.forma_farmaceutica || '').trim(),
        tamano: (data.tamano || '').trim(),
        laboratorio: (data.laboratorio || '').trim() || 'LA SANTE',
        categoria: data.categoria || 'Otros',
        pvp_propio_usd: parseFloat(data.pvp_propio_usd) || 0,
        unidosis: data.unidosis ? parseInt(data.unidosis, 10) : parseUnidosisCount(data.tamano || ''),
        market_type: data.market_type || 'GENERICO',
        unidad_negocio: data.unidad_negocio || 'La Sante',
        activo: data.activo ?? true,
      };

      await dbUpsertProducto(cleanProductData);
      // Un laboratorio, forma o molecula nuevos deben aparecer ya en las listas.
      invalidarDimensiones();

      addToast(isNew ? 'Producto creado con éxito' : 'Producto actualizado con éxito', 'success');
      setEditing(null);
      await cargar(true);
      return { success: true };
    } catch (err) {
      const errMsg = err?.message || 'Error al guardar el producto';
      addToast(errMsg, 'error');
      return { success: false, error: errMsg };
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

  const alternarSeleccion = (id) => {
    setSeleccion(prev => {
      const nueva = new Set(prev);
      if (nueva.has(id)) nueva.delete(id); else nueva.add(id);
      return nueva;
    });
  };

  const seleccionados = useMemo(
    () => productos.filter(p => seleccion.has(p.id)),
    [productos, seleccion]
  );
  const todosFiltradosSeleccionados = filtrados.length > 0 && filtrados.every(p => seleccion.has(p.id));
  const urlsSeleccionadas = seleccionados.reduce((n, p) => n + (urlsPorProducto.get(p.id_interno) || []).length, 0);

  const alternarTodosFiltrados = () => {
    setSeleccion(todosFiltradosSeleccionados ? new Set() : new Set(filtrados.map(p => p.id)));
  };

  // Baja masiva: conserva historial y enlaces. Es lo recomendado.
  const cambiarActivoSeleccion = async (activo) => {
    const ids = seleccionados.map(p => p.id_interno);
    setProcesandoSel({ hechos: 0, total: ids.length });
    try {
      const cambiados = await dbCambiarActivoProductos(ids, activo);
      if (cambiados < ids.length) {
        addToast(`Solo se actualizaron ${cambiados} de ${ids.length} productos. Revisa los permisos (RLS) de dim_productos.`, 'error');
      } else {
        addToast(`${cambiados} productos ${activo ? 'reactivados' : 'dados de baja'}.`, 'success');
      }
      setSeleccion(new Set());
      await cargar(true);
    } catch (err) {
      addToast('Error al actualizar: ' + (err.message || String(err)), 'error');
    }
    setProcesandoSel(null);
  };

  // Borrado masivo: uno por uno, porque cada producto arrastra sus
  // publicaciones, capturas y equivalencias en un orden fijo (FK RESTRICT).
  const handleConfirmBorrarSeleccion = async () => {
    const lista = seleccionados;
    setConfirmBorrarSel(false);
    setProcesandoSel({ hechos: 0, total: lista.length });
    const errores = [];
    for (let i = 0; i < lista.length; i++) {
      const p = lista[i];
      try {
        await dbDeleteProducto(p.id, urlsPorProducto.get(p.id_interno) || []);
      } catch (err) {
        errores.push(`${p.id_interno}: ${err.message || String(err)}`);
      }
      setProcesandoSel({ hechos: i + 1, total: lista.length });
    }
    if (errores.length > 0) {
      addToast(`${errores.length} productos no se eliminaron. ${errores.slice(0, 3).join(' · ')}`, 'error');
    }
    if (errores.length < lista.length) {
      addToast(`${lista.length - errores.length} productos eliminados.`, 'success');
    }
    setSeleccion(new Set());
    setProcesandoSel(null);
    await cargar(true);
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

  // Paso 1: leer y validar. NO se escribe nada todavía.
  const handleCsvUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const rows = parseCSV(evt.target.result);
        if (rows.length === 0) {
          addToast('El archivo CSV está vacío o no se pudieron reconocer sus columnas.', 'error');
          return;
        }
        // Si no se pueden leer las dimensiones se valida igual, sin ese aviso.
        let dimensiones = null;
        try {
          dimensiones = await dbNombresDimensionesCerradas();
        } catch (eDim) {
          console.warn('[CSV] No se pudieron leer categorías y unidades de negocio:', eDim?.message || String(eDim));
        }
        setPreviewCsv({ informe: validarCsv(rows, 'productos', dimensiones || {}), nombre: file.name });
      } catch (err) {
        addToast('No se pudo leer el archivo: ' + (err.message || String(err)), 'error');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  // Paso 2: el usuario vio el informe y confirmó. Ahora sí se escribe.
  const confirmarImportacion = async () => {
    if (!previewCsv) return;
    setIsUploadingCsv(true);

    const procesar = async () => {
      try {
        const rows = previewCsv.informe.filasValidas;

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
          const forma_farmaceutica = getRowValue(row, 'forma_farmaceutica', 'Forma Farmacéutica', 'Forma Farmaceutica', 'forma', 'Forma');
          const laboratorio = getRowValue(row, 'laboratorio', 'Laboratorio', 'lab', 'Lab', 'fabricante');
          const catRaw = getRowValue(row, 'categoria', 'Categoría', 'Categoria', 'linea', 'grupo');
          // Se respeta el nombre tal cual y lo resuelve dim_categorias. Antes se
          // filtraba contra CATEGORIAS, que no coincide con la base
          // ('Cardiovasculares' vs 'Cardiovascular', 'Analgésicos' vs
          // 'Analgesicos'), y una recarga mandaba casi todo a 'Otros'.
          const categoria = catRaw.trim() || 'Otros';

          // Sin la columna (o vacia) no se toca lo guardado; antes todo lo que
          // no decia MARCA se guardaba como GENERICO.
          const tipoRaw = getRowValue(row, 'tipo_mercado', 'market_type', 'Market Type', 'Tipo').toUpperCase();
          const market_type = tipoRaw ? (tipoRaw.includes('MARCA') ? 'MARCA' : 'GENERICO') : undefined;

          const unOriginal = getRowValue(row, 'unidad_negocio', 'Unidad de Negocio', 'Unidad Negocio', 'unidad', 'un', 'UN', 'linea_negocio').trim();
          // Cualquier otra unidad ('Genéricos', 'Prescripción'...) se conserva
          // tal cual; antes caía en 'La Sante' sin avisar.
          const unidad_negocio = resolverUnidadNegocio(unOriginal);

          // Sin columna `activo` no se toca el estado guardado: la recarga del
          // catalogo reactivaba los productos dados de baja.
          // Busqueda exacta: getRowValue tambien acepta subcadenas y con
          // 'activo' se quedaria con la columna principio_activo.
          const claveActivo = Object.keys(row).find(k => k.trim().toLowerCase() === 'activo');
          const activoRaw = claveActivo ? String(row[claveActivo] ?? '').trim().toLowerCase() : '';
          const activo = activoRaw ? !['no', 'false', '0'].includes(activoRaw) : undefined;

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
            forma_farmaceutica,
            tamano,
            presentacion,
            laboratorio: laboratorio || 'La Sante',
            categoria,
            pvp_propio_usd,
            unidosis,
            market_type,
            unidad_negocio,
            activo,
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
          setProgresoCsv({ hechos: 0, total: prodsToUpsert.length });
          const resultado = await dbUpsertProductosBulk(
            prodsToUpsert,
            (hechos, total) => setProgresoCsv({ hechos, total })
          );

          if (compToUpsert.length > 0) {
            await dbUpsertCompetenciaBulk(compToUpsert);
            refreshCompetencia();
          }

          setProductos(prev => {
            const map = new Map(prev.map(p => [p.id, p]));
            prodsToUpsert.forEach(p => map.set(p.id, {
              ...p,
              activo: p.activo ?? map.get(p.id)?.activo ?? true,
              market_type: p.market_type ?? map.get(p.id)?.market_type ?? 'GENERICO',
            }));
            return Array.from(map.values()).sort((a, b) => (a.id_interno || a.id || '').localeCompare(b.id_interno || b.id || ''));
          });

          refreshProductos();

          const msgComp = compToUpsert.length > 0 ? ` y ${compToUpsert.length} enlaces de competencia.` : '.';
          if (resultado.errores.length > 0) {
            const detalle = resultado.errores.slice(0, 5).map(e => `${e.id}: ${e.mensaje}`).join(' · ');
            addToast(`${resultado.errores.length} productos no se guardaron. ${detalle}`, 'error');
          }
          if (resultado.ok > 0) {
            addToast(`Importación exitosa: ${resultado.ok} productos registrados${msgComp}`, 'success');
          }

          setCsvSummary({
            totalRows: rows.length,
            successCount: resultado.ok,
            compCount: compToUpsert.length,
            skippedCount
          });
        } else {
          throw new Error('No se encontraron filas con datos de productos procesables en el archivo CSV.');
        }
      } catch (err) {
        addToast('Error procesando CSV: ' + (err.message || String(err)), 'error');
      } finally {
        setIsUploadingCsv(false);
        setProgresoCsv(null);
        setPreviewCsv(null);
      }
    };

    await procesar();
  };

  const idsExistentes = useMemo(() => new Set(productos.map(p => p.id_interno)), [productos]);

  // Los SKU propios son numeros de 6 digitos (140216): se sugiere el
  // siguiente. 'P001' solo si el catalogo todavia usa ese formato.
  const sugerirId = () => {
    const numericos = productos.map(p => p.id_interno).filter(id => /^\d+$/.test(id)).map(Number);
    if (numericos.length > 0) return String(Math.max(...numericos) + 1);
    const conP = productos.map(p => p.id_interno).filter(id => /^P\d+$/.test(id)).map(id => parseInt(id.slice(1), 10));
    const max = conP.length > 0 ? Math.max(...conP) : 0;
    return 'P' + String(max + 1).padStart(3, '0');
  };

  // Todo el catalogo, pensado para editarlo y volver a subirlo.
  const downloadCsvPlantilla = () => {
    const filas = productos.length > 0
      ? productos.map(filaCsvProducto)
      : [
          filaCsvProducto({ id_interno: 'P001', nombre: 'ATAMEL', codigo_barra: '7592450001234', principio_activo: 'Acetaminofén', concentracion: '500 mg', tamano: '10 unidades', forma_farmaceutica: 'Tabletas', laboratorio: 'LA SANTE', categoria: 'Otros', unidad_negocio: 'La Sante' }),
          filaCsvProducto({ id_interno: 'P002', nombre: 'LOSARTAN + HCTZ', principio_activo: 'Losartán + Hidroclorotiazida', concentracion: '50 mg + 12.5 mg', tamano: '30 unidades', forma_farmaceutica: 'Tabletas', laboratorio: 'LA SANTE', categoria: 'Otros', unidad_negocio: 'La Sante' }),
        ];

    exportToCSV(productos.length > 0 ? 'productos_plantilla_carga' : 'productos_plantilla_carga_ejemplo', COLUMNAS_CSV_PRODUCTOS, filas);
    addToast(productos.length > 0 ? `Plantilla con tus ${productos.length} productos descargada.` : 'Plantilla de ejemplo descargada.', 'success');
  };


  // Lo que se ve en pantalla, con los filtros aplicados. Mismo formato que la
  // plantilla: tambien se puede volver a subir.
  const handleExportarCatalogo = () => {
    const filas = filtrados.map(filaCsvProducto);
    exportToCSV('productos_reporte', COLUMNAS_CSV_PRODUCTOS, filas);
    addToast(`Exportados ${filas.length} productos a CSV.`, 'success');
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
        <div className="flex gap-2 flex-wrap lg:flex-nowrap items-center shrink-0">
          <button onClick={handleExportarCatalogo} className="m3-btn-outline" title="Descargar en CSV lo que se ve en la tabla">
            <span className="material-symbols-outlined text-base">download</span>
            <span>Exportar</span>
          </button>
          <button onClick={() => setShowCsvModal(true)} className="m3-btn-outline" title="Crear o actualizar muchos productos con un CSV">
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Carga masiva</span>
          </button>
          <button onClick={() => setEditing('new')} className="m3-btn-primary">
            <span className="material-symbols-outlined text-base">add</span>
            <span>Nuevo producto</span>
          </button>
          {/* Lo destructivo y poco frecuente va en un menu, no junto a las
              acciones del dia a dia. */}
          <details ref={menuMasRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger"
                disabled={deletingAll || productos.length === 0}
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setConfirmDeleteAll(true); }}>
                <span className="material-symbols-outlined">delete_sweep</span>
                {deletingAll ? 'Vaciando…' : 'Vaciar catálogo'}
              </button>
            </div>
          </details>
        </div>
      </div>

      {huerfanos > 0 && filtroUrls !== 'sin_urls' && (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">link_off</span>
          <span className="m3-body-medium flex-1">
            <strong>{huerfanos} {huerfanos === 1 ? 'producto activo no tiene' : 'productos activos no tienen'} enlaces</strong> de competencia: el scraper no los vigila.
          </span>
          <button type="button" onClick={() => setFiltroUrls('sin_urls')} className="m3-btn-text">Ver cuáles</button>
        </div>
      )}

      {/* Tabla de datos: barra de herramientas + tabla + paginacion en una
          sola superficie. Sin el efecto de "levantar" al pasar el raton: una
          tabla que se mueve bajo el cursor cansa y descolocaba lo fijado. */}
      <section className="m3-data-table" aria-label="Catálogo de productos">
        {/* Barra superior contextual: con productos seleccionados muestra sus
            acciones en el mismo sitio que la busqueda (patron de Gmail o
            Drive), pegada arriba al desplazarse. */}
        <div className="m3-data-table-toolbar">
          {seleccion.size > 0 ? (
            <div className="m3-selection-bar" role="toolbar" aria-label="Acciones sobre los productos seleccionados">
              <button type="button" onClick={() => setSeleccion(new Set())} disabled={!!procesandoSel}
                className="m3-icon-btn" title="Quitar selección" aria-label="Quitar selección">
                <span className="material-symbols-outlined">close</span>
              </button>
              <div className="flex flex-col min-w-0 mr-auto">
                <span className="m3-title-medium">
                  {procesandoSel
                    ? `Procesando ${procesandoSel.hechos} de ${procesandoSel.total}…`
                    : `${seleccion.size} ${seleccion.size === 1 ? 'seleccionado' : 'seleccionados'}`}
                </span>
                {!procesandoSel && !todosFiltradosSeleccionados && (
                  <button type="button" onClick={alternarTodosFiltrados}
                    className="self-start text-primary m3-label-medium hover:underline">
                    Seleccionar los {filtrados.length} de esta lista
                  </button>
                )}
              </div>
              {!procesandoSel && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => cambiarActivoSeleccion(false)} className="m3-btn-primary h-10"
                    title="Deja de mostrarse y de vigilarse. Conserva el historial.">
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
              {procesandoSel && (
                <div className="m3-linear-progress" aria-hidden="true">
                  <div style={{ width: `${procesandoSel.total ? (procesandoSel.hechos / procesandoSel.total) * 100 : 0}%` }} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <label className="m3-search-field">
                  <span className="material-symbols-outlined" aria-hidden="true">search</span>
                  <input
                    ref={buscadorRef}
                    type="search"
                    placeholder="Buscar por nombre, ID, molécula, código de barras o laboratorio"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Buscar productos"
                  />
                  {search ? (
                    <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  ) : (
                    <kbd className="m3-kbd" title="Pulsa / para buscar">/</kbd>
                  )}
                </label>
                <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
                  {filtrados.length === productos.length
                    ? `${productos.length} productos`
                    : `${filtrados.length} de ${productos.length} productos`}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <FiltroChip etiqueta="Estado" icono="toggle_on" valor={filtroActivo} onChange={setFiltroActivo}
                  opciones={[['todos', 'Estado: todos'], ['activos', 'Activos'], ['inactivos', 'Inactivos']]} />
                <FiltroChip etiqueta="Enlaces" icono="link" valor={filtroUrls} onChange={setFiltroUrls}
                  opciones={[['todos', 'Enlaces: todos'], ['con_urls', 'Con enlaces'], ['sin_urls', 'Sin enlaces']]} />
                <FiltroChip etiqueta="Tipo" icono="sell" valor={filtroTipo} onChange={setFiltroTipo}
                  opciones={[['todos', 'Tipo: todos'], ['generico', 'Genéricos'], ['marca', 'Marca']]} />
                <FiltroChip etiqueta="Unidad de negocio" icono="corporate_fare" valor={filtroUn} onChange={setFiltroUn}
                  opciones={[['todos', 'Unidad: todas'], ...unidadesDisponibles]} />
                {hayFiltros && (
                  <button type="button" onClick={limpiarFiltros} className="m3-btn-text">
                    Limpiar filtros
                  </button>
                )}
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
              <span className="material-symbols-outlined text-2xl">{hayFiltros || search ? 'search_off' : 'medication'}</span>
            </div>
            <div className="m3-title-medium text-on-surface">No se encontraron productos</div>
            <div className="m3-body-medium">
              {hayFiltros || search
                ? 'Prueba con otra búsqueda o quita algún filtro.'
                : 'Aún no hay productos. Súbelos con Carga masiva o crea uno con Nuevo producto.'}
            </div>
            {(hayFiltros || search) && (
              <button type="button" onClick={() => { setSearch(''); limpiarFiltros(); }} className="m3-btn-tonal mt-1">
                Quitar búsqueda y filtros
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-productos">
              <colgroup>
                <col className="w-12" />
                <col />
                <col className="w-[17%]" />
                <col className="w-[12%]" />
                <col className="w-[15%]" />
                <col className="w-[112px]" />
                <col className="w-[88px]" />
                <col className="w-[104px]" />
                <col className="w-[136px]" />
              </colgroup>
              <thead className="m3-sticky-header">
                <tr>
                  <th>
                    <input type="checkbox" checked={todosFiltradosSeleccionados} onChange={alternarTodosFiltrados}
                      disabled={!!procesandoSel}
                      title={`Seleccionar los ${filtrados.length} productos de esta lista`}
                      aria-label="Seleccionar todos los productos de esta lista" className="m3-checkbox" />
                  </th>
                  <th>Producto</th>
                  <th>Presentación</th>
                  <th>Línea</th>
                  <th>Laboratorio</th>
                  <th className="text-right" title="PVP propio y precio más bajo de la competencia">PVP</th>
                  <th className="text-center">Enlaces</th>
                  <th>Estado</th>
                  <th className="m3-sticky-actions"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {productosPaginados.map(p => {
                  const enlacesProducto = urlsPorProducto.get(p.id_interno) || [];
                  const enlaces = enlacesProducto.length;
                  const masBarato = competidorMasBarato(enlacesProducto);
                  const pvp = Number(p.pvp_propio_usd) || 0;
                  const seleccionado = seleccion.has(p.id);
                  return (
                    <tr key={p.id} className={seleccionado ? 'm3-row-selected' : ''}>
                      <td>
                        <input type="checkbox" checked={seleccionado} onChange={() => alternarSeleccion(p.id)}
                          disabled={!!procesandoSel}
                          aria-label={`Seleccionar ${p.nombre}`} className="m3-checkbox" />
                      </td>
                      <td>
                        <button type="button" onClick={() => setFichaId(p.id)} className="m3-cell-link" title="Abrir la ficha del producto">
                          <span className="m3-cell-primary">{p.nombre}</span>
                        </button>
                        <div className="m3-cell-secondary" title={`${p.id_interno} · ${p.principio_activo || 'sin molécula'}`}>
                          <span className="font-mono">{p.id_interno}</span>
                          {p.principio_activo ? <> · {p.principio_activo}</> : <> · <span className="italic">sin molécula</span></>}
                        </div>
                      </td>
                      <td>
                        <div className="m3-cell-primary">{p.concentracion || '—'}</div>
                        <div className="m3-cell-secondary">{describirPresentacion(p)}</div>
                      </td>
                      <td>
                        <div className="m3-cell-primary">{p.unidad_negocio || '—'}</div>
                        <div className="m3-cell-secondary">{(p.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico'}</div>
                      </td>
                      <td>
                        <div className="m3-cell-primary">{p.laboratorio || '—'}</div>
                        <div className="m3-cell-secondary">{p.categoria || 'Sin categoría'}</div>
                      </td>
                      <td className="text-right">
                        <div className="m3-cell-primary tabular-nums">{pvp > 0 ? `$${pvp.toFixed(2)}` : '—'}</div>
                        <div className={`m3-cell-secondary tabular-nums ${masBarato && pvp > precioEnlaceUsd(masBarato) ? 'text-error' : ''}`}
                          title={masBarato ? `Competencia más baja: ${masBarato.cadena}` : 'Sin precios de la competencia'}>
                          {masBarato ? `comp. $${precioEnlaceUsd(masBarato).toFixed(2)}` : 'sin comp.'}
                        </div>
                      </td>
                      <td className="text-center">
                        {enlaces === 0 ? (
                          <span className="m3-count m3-count-warning" title="Sin enlaces: el scraper no vigila este producto">
                            <span className="material-symbols-outlined" aria-hidden="true">link_off</span>0
                          </span>
                        ) : (
                          <span className="m3-count" title={`${enlaces} enlaces de competencia`}>{enlaces}</span>
                        )}
                      </td>
                      <td>
                        <span className={`m3-status ${p.activo ? 'is-on' : ''}`}>{p.activo ? 'Activo' : 'De baja'}</span>
                      </td>
                      <td className="m3-sticky-actions">
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => setEditing(p.id)} className="m3-icon-btn"
                            title="Editar" aria-label={`Editar ${p.nombre}`}>
                            <span className="material-symbols-outlined">edit</span>
                          </button>
                          <button type="button" onClick={() => handleToggleActivo(p)} className="m3-icon-btn"
                            title={p.activo ? 'Dar de baja' : 'Reactivar'}
                            aria-label={`${p.activo ? 'Dar de baja' : 'Reactivar'} ${p.nombre}`}>
                            <span className="material-symbols-outlined">{p.activo ? 'archive' : 'unarchive'}</span>
                          </button>
                          <button type="button" onClick={() => handleDelete(p)} className="m3-icon-btn m3-icon-btn-danger"
                            title="Eliminar" aria-label={`Eliminar ${p.nombre}`}>
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
        )}

        {filtrados.length > 0 && (
          <footer className="m3-data-table-footer">
            <label className="flex items-center gap-2 m3-body-medium text-on-surface-variant">
              Filas por página
              <select value={itemsPorPagina} onChange={e => cambiarFilasPorPagina(Number(e.target.value))} className="m3-rows-select">
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="m3-body-medium text-on-surface-variant sm:ml-auto">
              {Math.min(filtrados.length, (paginaActual - 1) * itemsPorPagina + 1)}–{Math.min(filtrados.length, paginaActual * itemsPorPagina)} de {filtrados.length}
            </span>
            {totalPaginas > 1 && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPaginaActual(p => Math.max(1, p - 1))} disabled={paginaActual === 1}
                  className="m3-icon-btn" aria-label="Página anterior">
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <span className="m3-label-large px-2">Página {paginaActual} de {totalPaginas}</span>
                <button type="button" onClick={() => setPaginaActual(p => Math.min(totalPaginas, p + 1))} disabled={paginaActual === totalPaginas}
                  className="m3-icon-btn" aria-label="Página siguiente">
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
              </div>
            )}
          </footer>
        )}
      </section>

      {fichaId && (() => {
        const producto = productos.find(p => p.id === fichaId);
        if (!producto) return null;
        const enlaces = urlsPorProducto.get(producto.id_interno) || [];
        return (
          <FichaProducto
            producto={producto}
            enlaces={enlaces}
            presentacion={describirPresentacion(producto)}
            onClose={() => setFichaId(null)}
            onEditar={() => { setFichaId(null); setEditing(producto.id); }}
            onAnalisis={() => { setFichaId(null); setAnalisis({ producto, competencia: enlaces }); }}
            onAlternarActivo={() => handleToggleActivo(producto)}
          />
        );
      })()}

      {analisis && (
        <ProductDetailModal
          producto={analisis.producto}
          competencia={analisis.competencia}
          currency="usd"
          bcvRate={bcv.rate}
          onClose={() => setAnalisis(null)}
        />
      )}

      {/* Create/Edit Product Modal */}
      {editing && (
        <ProductoModal
          producto={editing === 'new' ? null : productos.find(p => p.id === editing)}
          sugerirId={sugerirId}
          idsExistentes={idsExistentes}
          onSave={handleSave}
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

      <ConfirmModal
        isOpen={confirmBorrarSel}
        title={`¿Eliminar ${seleccionados.length} productos?`}
        message={`Se eliminarán ${seleccionados.length} productos junto con TODO su historial de precios${
          urlsSeleccionadas > 0 ? ` y ${urlsSeleccionadas} URL(s) de competencia` : ''
        }.\n\nEsta acción no se puede deshacer. Si solo quieres dejar de verlos o de vigilarlos, usa "Dar de baja": conserva el historial y se pueden reactivar.`}
        confirmText={`Eliminar ${seleccionados.length}`}
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmBorrarSeleccion}
        onCancel={() => setConfirmBorrarSel(false)}
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
            <div className="m3-card-outlined p-4 space-y-1.5 font-mono text-xs">
              <div className="font-bold text-primary border-b border-outline-variant/60 pb-1 mb-1 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">lists</span>
                Columnas del CSV:
              </div>
              <div>id_interno <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
              <div>nombre <span className="text-on-surface-variant font-sans font-medium">(Obligatorio)</span></div>
              <div>codigo_barra <span className="text-on-surface-variant font-sans font-medium">(Opcional / EAN / GTIN)</span></div>
              <div>principio_activo <span className="text-on-surface-variant font-sans font-medium">(Molécula)</span></div>
              <div>concentracion, tamano, forma_farmaceutica, laboratorio, categoria</div>
              <div>unidad_negocio, tipo_mercado <span className="text-on-surface-variant font-sans font-medium">(MARCA / GENERICO)</span></div>
              <div>activo <span className="text-on-surface-variant font-sans font-medium">(si / no)</span></div>
            </div>
            <div className="flex justify-between items-center pt-1">
              <button type="button" onClick={downloadCsvPlantilla}
                className="text-xs text-primary font-bold hover:underline inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">download</span>
                Descargar plantilla de carga (catálogo actual)
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
      {previewCsv && (
        <ImportPreview
          informe={previewCsv.informe}
          nombreArchivo={previewCsv.nombre}
          importando={isUploadingCsv}
          progreso={progresoCsv}
          onConfirmar={confirmarImportacion}
          onCancelar={() => setPreviewCsv(null)}
        />
      )}

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

// Normaliza para comparar sin mayusculas ni tildes.
const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Una dosis metida en el nombre ("ACETAMINOFEN 500 MG") rompe la comparacion
// con los titulos de las tiendas (ver ESTADO_DEL_PROYECTO.md).
const RE_DOSIS_EN_NOMBRE = /\d+([.,]\d+)?\s*(mg|mcg|g|gr|ml|%|ui)\b/i;

function ProductoModal({ producto, sugerirId, idsExistentes, onSave, onClose }) {
  const dimensiones = useDimensiones();
  const isNew = !producto;
  const [form, setForm] = useState({
    id_interno: producto?.id_interno || sugerirId(),
    nombre: producto?.nombre || '',
    codigo_barra: producto?.codigo_barra || '',
    principio_activo: producto?.principio_activo || '',
    concentracion: producto?.concentracion || '',
    tamano: producto?.tamano || '',
    forma_farmaceutica: producto?.forma_farmaceutica || '',
    // Los productos son propios: La Sante es el fabricante por defecto.
    laboratorio: producto?.laboratorio || 'LA SANTE',
    categoria: producto?.categoria && producto.categoria !== 'Otros' ? producto.categoria : '',
    // Unidad y tipo en blanco en un alta: hay que elegirlos a conciencia.
    unidad_negocio: producto?.unidad_negocio || '',
    market_type: producto?.market_type || '',
    pvp_propio_usd: producto?.pvp_propio_usd ? String(producto.pvp_propio_usd) : '',
    activo: producto?.activo ?? true,
  });
  const [errores, setErrores] = useState({});
  const [saving, setSaving] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState(null);

  const unidades = dimensiones.unidadesNegocio.length ? dimensiones.unidadesNegocio : ['La Sante', 'Pharmetique', 'OTC'];

  const handleChange = (key, value) => {
    setErrorGeneral(null);
    setErrores(e => ({ ...e, [key]: undefined }));
    setForm(f => {
      const nuevo = { ...f, [key]: value };
      // Sugerencia, no imposicion: al elegir la unidad se propone el tipo
      // habitual solo si todavia no se habia elegido.
      if (key === 'unidad_negocio' && !f.market_type) {
        const un = normalizar(value);
        if (un.includes('pharmetique')) nuevo.market_type = 'MARCA';
        else if (un === 'la sante') nuevo.market_type = 'GENERICO';
      }
      return nuevo;
    });
  };

  const validar = () => {
    const e = {};
    const id = form.id_interno.trim();
    if (!id) e.id_interno = 'Obligatorio';
    else if (isNew && idsExistentes.has(id)) e.id_interno = 'Ya existe un producto con este ID';
    if (!form.nombre.trim()) e.nombre = 'Obligatorio';
    if (!form.unidad_negocio) e.unidad_negocio = 'Elige una unidad de negocio';
    if (!form.market_type) e.market_type = 'Elige el tipo';
    if (form.pvp_propio_usd && !(Number(String(form.pvp_propio_usd).replace(',', '.')) >= 0)) e.pvp_propio_usd = 'Escribe un número, ej: 2.50';
    return e;
  };

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    const e = validar();
    setErrores(e);
    if (Object.keys(e).length > 0) {
      // Llevar la vista al primer campo con error.
      setTimeout(() => {
        const campo = document.querySelector('#producto-form .m3-field.has-error');
        campo?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        campo?.querySelector('input:not([type=radio]), input[type=radio]')?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    setSaving(true);
    const res = await onSave({
      ...form,
      categoria: form.categoria || 'Otros',
      pvp_propio_usd: String(form.pvp_propio_usd).replace(',', '.'),
    }, isNew);
    setSaving(false);
    if (res && !res.success) setErrorGeneral(res.error || 'No se pudo guardar el producto.');
  };

  const nombreConDosis = RE_DOSIS_EN_NOMBRE.test(form.nombre);
  const vistaPrevia = [form.nombre.trim(), form.concentracion.trim(),
    describirPresentacion({ tamano: form.tamano, forma_farmaceutica: form.forma_farmaceutica }).replace(/^—$/, '')]
    .filter(Boolean).join(' · ');

  return (
    <ModalWrapper
      isOpen={true}
      onClose={onClose}
      title={isNew ? 'Nuevo producto' : 'Editar producto'}
      subtitle={isNew ? 'Los campos con * son obligatorios.' : `${form.id_interno} · ${producto?.nombre || ''}`}
      icon={isNew ? 'add_box' : 'edit'}
      maxWidth="max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 w-full">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" checked={form.activo}
              onChange={e => handleChange('activo', e.target.checked)} className="m3-switch" />
            <span>{form.activo ? 'Activo' : 'De baja'}</span>
          </label>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
            <button type="submit" form="producto-form" disabled={saving} className="m3-btn-primary h-10 px-6">
              {saving ? 'Guardando…' : isNew ? 'Crear producto' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      }
    >
      <form id="producto-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {errorGeneral && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{errorGeneral}</span>
          </div>
        )}

        <FormSection titulo="Identificación" icono="badge">
          <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_200px] gap-4">
            <Field label="ID interno" requerido error={errores.id_interno} hint={isNew ? 'Siguiente disponible' : 'No se puede cambiar'}>
              <input type="text" value={form.id_interno} disabled={!isNew} inputMode="numeric"
                onChange={e => handleChange('id_interno', e.target.value)} className="m3-input font-mono" />
            </Field>
            <Field label="Nombre comercial" requerido error={errores.nombre}
              aviso={nombreConDosis ? 'El nombre no debe llevar la dosis: va en Concentración.' : null}
              hint="Solo la marca o la molécula, sin dosis ni empaque. Ej: ESOZ, ACETAMINOFEN">
              <input type="text" value={form.nombre} autoFocus={isNew}
                onChange={e => handleChange('nombre', e.target.value)} className="m3-input" />
            </Field>
            <Field label="Código de barras" hint="Opcional. EAN / GTIN">
              <input type="text" value={form.codigo_barra} inputMode="numeric"
                onChange={e => handleChange('codigo_barra', e.target.value)} className="m3-input font-mono" />
            </Field>
          </div>
        </FormSection>

        <FormSection titulo="Composición y presentación" icono="science">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Principio activo" hint="Varias moléculas: Losartán + Hidroclorotiazida">
              <ComboField value={form.principio_activo} onChange={v => handleChange('principio_activo', v)}
                opciones={dimensiones.principiosActivos} cargando={!dimensiones.cargado} permitirNuevo />
            </Field>
            <Field label="Concentración" hint="Ej: 500 mg · 250 mg/5 ml · 50 mg + 12.5 mg">
              <input type="text" value={form.concentracion}
                onChange={e => handleChange('concentracion', e.target.value)} className="m3-input" />
            </Field>
            <Field label="Forma farmacéutica">
              <ComboField value={form.forma_farmaceutica} onChange={v => handleChange('forma_farmaceutica', v)}
                opciones={dimensiones.formasFarmaceuticas} cargando={!dimensiones.cargado} permitirNuevo />
            </Field>
            <Field label="Empaque" hint="Ej: 20 tabletas · 120 ml · 30 g">
              <input type="text" value={form.tamano}
                onChange={e => handleChange('tamano', e.target.value)} className="m3-input" />
            </Field>
          </div>
          {vistaPrevia && (
            <div className="m3-form-preview">
              <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
              <span>Se verá así: <strong>{vistaPrevia}</strong></span>
            </div>
          )}
        </FormSection>

        <FormSection titulo="Clasificación y precio" icono="category">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
            <Field label="Unidad de negocio" requerido error={errores.unidad_negocio}>
              <ChoiceChips valor={form.unidad_negocio} onChange={v => handleChange('unidad_negocio', v)}
                opciones={unidades.map(u => [u, u])} nombre="unidad_negocio" />
            </Field>
            <Field label="Tipo" requerido error={errores.market_type}>
              <ChoiceChips valor={form.market_type} onChange={v => handleChange('market_type', v)}
                opciones={[['GENERICO', 'Genérico'], ['MARCA', 'Marca']]} nombre="market_type" />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_160px] gap-4">
            <Field label="Laboratorio" hint="Fabricante. Por defecto La Sante">
              <ComboField value={form.laboratorio} onChange={v => handleChange('laboratorio', v)}
                opciones={dimensiones.laboratorios} cargando={!dimensiones.cargado} permitirNuevo />
            </Field>
            <Field label="Categoría" hint="Opcional. Se crean en Dimensiones">
              <ComboField value={form.categoria} onChange={v => handleChange('categoria', v)}
                opciones={dimensiones.categorias.filter(c => c !== 'Otros')} cargando={!dimensiones.cargado}
                placeholder="Sin categoría" />
            </Field>
            <Field label="PVP (USD)" error={errores.pvp_propio_usd}
              hint={isNew ? 'Opcional' : 'El anterior queda en el historial'}>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant" aria-hidden="true">$</span>
                <input type="text" inputMode="decimal" value={form.pvp_propio_usd} placeholder="0.00"
                  onChange={e => handleChange('pvp_propio_usd', e.target.value)} className="m3-input pl-8 tabular-nums" />
              </div>
            </Field>
          </div>
        </FormSection>

      </form>
    </ModalWrapper>
  );
}

function FormSection({ titulo, icono, children }) {
  return (
    <fieldset className="m3-form-section">
      <legend className="m3-form-section-title">
        <span className="material-symbols-outlined" aria-hidden="true">{icono}</span>
        {titulo}
      </legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

function Field({ label, hint, error, aviso, requerido, children }) {
  return (
    <div className={`m3-field ${error ? 'has-error' : ''}`}>
      <label className="m3-field-label">
        {label}{requerido && <span className="text-error" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="m3-field-support text-error" role="alert">{error}</p>
      ) : aviso ? (
        <p className="m3-field-support m3-field-warning">{aviso}</p>
      ) : hint ? (
        <p className="m3-field-support">{hint}</p>
      ) : null}
    </div>
  );
}

// Opciones cerradas y pocas (unidad de negocio, tipo): todas a la vista, un
// clic. Sin nada elegido por defecto.
function ChoiceChips({ valor, onChange, opciones, nombre }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {opciones.map(([v, texto]) => {
        const activo = normalizar(valor) === normalizar(v);
        return (
          <label key={v} className={`m3-choice-chip ${activo ? 'is-selected' : ''}`}>
            <input type="radio" name={nombre} value={v} checked={activo} onChange={() => onChange(v)} className="sr-only" />
            {activo && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
            {texto}
          </label>
        );
      })}
    </div>
  );
}

// Campo con lista desplegable propia. El <datalist> del navegador filtra por
// lo ya escrito: con "La Sante" puesto solo ofrecia "La Sante" y parecia que
// no se podia elegir otra cosa. Aqui, al abrir, se ven todas las opciones; se
// filtra solo cuando el usuario escribe algo distinto.
function ComboField({ value, onChange, opciones = [], cargando = false, permitirNuevo = false, placeholder = '' }) {
  const [abierto, setAbierto] = useState(false);
  const [escrito, setEscrito] = useState(false);
  const [activo, setActivo] = useState(-1);
  const listaId = useMemo(() => `combo-${Math.random().toString(36).slice(2, 9)}`, []);

  const filtradas = useMemo(() => {
    const q = normalizar(value);
    const lista = escrito && q ? opciones.filter(o => normalizar(o).includes(q)) : opciones;
    return lista.slice(0, 80);
  }, [opciones, value, escrito]);

  const existe = opciones.some(o => normalizar(o) === normalizar(value));

  const elegir = (v) => {
    onChange(v);
    setAbierto(false);
    setEscrito(false);
    setActivo(-1);
  };

  const alPulsar = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAbierto(true); setActivo(i => Math.min(i + 1, filtradas.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActivo(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && abierto && activo >= 0 && filtradas[activo]) { e.preventDefault(); elegir(filtradas[activo]); }
    else if (e.key === 'Escape' && abierto) { e.stopPropagation(); setAbierto(false); }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={abierto}
        aria-controls={listaId}
        aria-autocomplete="list"
        onChange={e => { onChange(e.target.value); setEscrito(true); setAbierto(true); setActivo(-1); }}
        onFocus={() => { setAbierto(true); setEscrito(false); }}
        onClick={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 120)}
        onKeyDown={alPulsar}
        className="m3-input pr-10"
        autoComplete="off"
      />
      <span className="material-symbols-outlined m3-combo-arrow" aria-hidden="true">arrow_drop_down</span>
      {abierto && (
        <ul id={listaId} role="listbox" className="m3-combo-list">
          {cargando && opciones.length === 0 && <li className="m3-combo-empty">Cargando opciones…</li>}
          {filtradas.map((o, i) => (
            <li key={o} role="option" aria-selected={normalizar(o) === normalizar(value)}
              onMouseDown={e => { e.preventDefault(); elegir(o); }}
              className={`m3-combo-option ${i === activo ? 'is-active' : ''} ${normalizar(o) === normalizar(value) ? 'is-selected' : ''}`}>
              {o}
              {normalizar(o) === normalizar(value) && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
            </li>
          ))}
          {!cargando && filtradas.length === 0 && !permitirNuevo && <li className="m3-combo-empty">Sin coincidencias</li>}
          {permitirNuevo && value.trim() && !existe && (
            <li className="m3-combo-empty">Se creará «{value.trim()}» al guardar</li>
          )}
        </ul>
      )}
    </div>
  );
}
