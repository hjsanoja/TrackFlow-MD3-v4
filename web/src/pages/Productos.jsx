import { useEffect, useState, useMemo, useRef } from 'react';
import { validarCsv, resolverUnidadNegocio } from '../utils/validarCsv';
import ImportPreview from '../components/ImportPreview';
import FichaProducto, { competidorMasBarato, precioEnlaceUsd } from '../components/FichaProducto';
import ProductDetailModal from '../components/ProductDetailModal';
import { useBcvRate } from '../hooks/useBcvRate';
import { useDimensiones } from '../hooks/useDimensiones';
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

  const sugerirId = () => {
    const numeros = productos
      .map(p => p.id_interno)
      .filter(id => /^P\d+$/.test(id))
      .map(id => parseInt(id.slice(1), 10));
    const max = numeros.length > 0 ? Math.max(...numeros) : 0;
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

function ProductoModal({ producto, sugerirId, onSave, onClose }) {
  // Catálogos reales para sugerir en los campos y evitar duplicados por tipeo
  // ("Calox" / "CALOX" / "Calox " acababan como tres laboratorios distintos).
  const dimensiones = useDimensiones();
  const isNew = !producto;
  const [form, setForm] = useState({
    id_interno: producto?.id_interno || sugerirId(),
    nombre: producto?.nombre || '',
    codigo_barra: producto?.codigo_barra || '',
    laboratorio: producto?.laboratorio || '',
    principio_activo: producto?.principio_activo || '',
    concentracion: producto?.concentracion || '',
    tamano: producto?.tamano || '',
    forma_farmaceutica: producto?.forma_farmaceutica || '',
    unidosis: producto?.unidosis || '',
    presentacion: producto?.presentacion || '',
    categoria: producto?.categoria || '',
    market_type: producto?.market_type || 'GENERICO',
    unidad_negocio: producto?.unidad_negocio || 'La Sante',
    activo: producto?.activo ?? true,
  });

  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!form.id_interno || !form.nombre) {
      setErrorMessage('Por favor completa los campos obligatorios (*).');
      return;
    }
    setSaving(true);
    const res = await onSave(form, isNew);
    setSaving(false);
    if (res && !res.success) {
      setErrorMessage(res.error || 'Ocurrió un error al intentar guardar el producto.');
    }
  };

  const handleChange = (key, value) => {
    setErrorMessage(null);
    setForm(f => ({ ...f, [key]: value }));
  };

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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="ID Interno *" hint="Código único (ej: P001)">
            <input type="text" required value={form.id_interno}
              onChange={e => handleChange('id_interno', e.target.value)}
              disabled={!isNew}
              className="m3-input font-mono disabled:opacity-60" />
          </Field>
          
          <Field label="Nombre del Producto *" hint="Ej. Atamel">
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
          <Field label="Principio Activo">
            <input type="text" value={form.principio_activo}
              onChange={e => handleChange('principio_activo', e.target.value)}
              placeholder="Acetaminofén"
              list="dim-principios" className="m3-input" />
            <datalist id="dim-principios">
              {dimensiones.principiosActivos.map(n => <option key={n} value={n} />)}
            </datalist>
          </Field>

          <Field label="Concentración" hint="Ej: 500 mg, 10%">
            <input type="text" value={form.concentracion}
              onChange={e => handleChange('concentracion', e.target.value)}
              placeholder="500 mg"
              className="m3-input" />
          </Field>

          <Field label="Presentación" hint="Ej: 10 tabletas">
            <input type="text" value={form.tamano}
              onChange={e => handleChange('tamano', e.target.value)}
              placeholder="10 tabletas"
              className="m3-input" />
          </Field>

          <Field label="Forma Farmacéutica" hint="Ej: Tabletas, Jarabe">
            <input type="text" list="dim-formas" value={form.forma_farmaceutica}
              onChange={e => handleChange('forma_farmaceutica', e.target.value)}
              placeholder="Tabletas"
              className="m3-input" />
            <datalist id="dim-formas">
              {dimensiones.formasFarmaceuticas.map(n => <option key={n} value={n} />)}
            </datalist>
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Laboratorio" hint="Elige uno existente o escribe uno nuevo">
            <input type="text" value={form.laboratorio}
              onChange={e => handleChange('laboratorio', e.target.value)}
              list="dim-laboratorios"
              placeholder="La Santé"
              className="m3-input" />
            <datalist id="dim-laboratorios">
              {dimensiones.laboratorios.map(n => <option key={n} value={n} />)}
            </datalist>
          </Field>

          <Field label="Categoría" hint="Elige una existente o escribe una nueva">
            <input type="text" value={form.categoria}
              onChange={e => handleChange('categoria', e.target.value)}
              list="dim-categorias"
              placeholder="Analgésicos"
              className="m3-input" />
            {/* El catálogo real manda; CATEGORIAS era una lista fija en el
                código que se desincronizaba de dim_categorias. */}
            <datalist id="dim-categorias">
              {(dimensiones.categorias.length ? dimensiones.categorias : CATEGORIAS).map(c => <option key={c} value={c} />)}
            </datalist>
          </Field>

          <Field label="Market Type (Tipo)">
            <select value={form.market_type} onChange={e => handleChange('market_type', e.target.value)}
              className="m3-select">
              <option value="GENERICO">GENÉRICO</option>
              <option value="MARCA">MARCA</option>
            </select>
          </Field>

          <Field label="Unidad de Negocio" hint="Elige una existente o escribe una nueva">
            <input type="text" value={form.unidad_negocio}
              onChange={e => handleChange('unidad_negocio', e.target.value)}
              list="dim-unidades-negocio"
              placeholder="La Sante"
              className="m3-input font-bold text-secondary" />
            <datalist id="dim-unidades-negocio">
              {(dimensiones.unidadesNegocio.length ? dimensiones.unidadesNegocio : ['La Sante', 'Pharmetique', 'OTC']).map(u => <option key={u} value={u} />)}
            </datalist>
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
      {hint && <p className="text-label-sm text-on-surface-variant font-mono">{hint}</p>}
    </div>
  );
}
