import { claveCompetidor, claveDosis, concentracionDe, unidadesDe } from '../utils/competidor';
import BarraFiltros from '../components/BarraFiltros';
import Segmentado from '../components/Segmentado';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { esMarca, leerTipoMercado, sugerirTipoMercado } from '../utils/tipoMercado';
import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { validarCsv } from '../utils/validarCsv';
import ImportPreview from '../components/ImportPreview';
import { useDimensiones } from '../hooks/useDimensiones';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, isSupabaseActive } from '../supabase';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import GitHubConfigModal from '../components/GitHubConfigModal';
import FichaEnlace from '../components/FichaEnlace';
import CoberturaCadenas from '../components/CoberturaCadenas';
import AvisoRobot from '../components/AvisoRobot';
import CadenaBadge from '../components/CadenaBadge';
import { useRobot, estimarMinutos } from '../hooks/useRobot';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import { FormSection, Field, ChoiceChips, ComboField, normalizar } from '../components/formulario';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { exportToCSV } from '../utils/exportUtils';
import { parseCSV, getRowValue, leerArchivoCsv } from '../utils/csvParser';
import { DIAS_ENLACE_CAIDO, enlaceCaido, describirPresentacion } from '../utils/presentacion';
import { esDeOtraWeb } from '../utils/cadenas';
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

// CSV de enlaces. La PLANTILLA de carga solo lleva lo que relaciona tu
// producto con su enlace o su competidor (lo mismo que el formulario "Vincular
// enlace"). El REPORTE agrega PVP, precios y fecha de captura, que son
// informativos. Donde el dato es el mismo que en el CSV de productos, la
// columna se llama igual (id_interno, nombre, laboratorio, tipo_mercado,
// activo). En las filas "propio", laboratorio, unidades, medida y tipo_mercado
// salen de Productos para que el archivo no tenga huecos; al importar se
// ignoran (se cambian en Productos).
const COLUMNAS_PLANTILLA = [
  'id_interno', 'nombre', 'cadena', 'relacion', 'competidor', 'concentracion', 'laboratorio', 'unidades_empaque', 'medida', 'tipo_mercado', 'url', 'activo',
];
const COLUMNAS_CSV_PLANTILLA = COLUMNAS_PLANTILLA.map(key => ({ label: key, key }));
const COLUMNAS_CSV_REPORTE = [
  ...COLUMNAS_PLANTILLA, 'pvp_propio_usd', 'precio_usd', 'precio_bs', 'precio_oferta_bs', 'ultima_captura',
].map(key => ({ label: key, key }));
const ARCHIVO_REPORTE = 'competencia_enlaces_reporte';
const ARCHIVO_PLANTILLA = 'competencia_enlaces_plantilla_carga';

const esPropio = (it) => String(it.tipo || '').toLowerCase() === 'propio';

// ¿La fila del CSV deja el enlace igual que como esta? Un campo vacio en el
// CSV no cambia nada, asi que solo se comparan los que traen dato.
function sinCambios(n, e) {
  if (!e) return false;
  const txt = (v) => String(v ?? '').trim().toLowerCase();
  if (txt(n.id_producto_propio) !== txt(e.id_producto_propio)) return false;
  if ((n.activo !== false) !== (e.activo !== false)) return false;
  if (String(n.tipo) === 'propio') return true;
  if (n.marca && txt(n.marca) !== txt(e.nombre_competidor || e.marca)) return false;
  if (n.laboratorio && txt(n.laboratorio) !== txt(e.laboratorio)) return false;
  if (n.concentracion && txt(n.concentracion).replace(/\s/g, '') !== txt(e.concentracion).replace(/\s/g, '')) return false;
  if (n.unidades_empaque && Number(n.unidades_empaque) !== Number(e.unidades_empaque)) return false;
  if (n.unidades_empaque && (n.unidad_contenido || 'unidad') !== (e.unidad_contenido || 'unidad')) return false;
  if (n.tipo_mercado && n.tipo_mercado !== e.tipo_mercado) return false;
  return true;
}

// Lecturas fallidas seguidas a partir de las cuales el enlace se marca
// "Revisar URL" (vista v_enlaces_fallidos, fase 23).
const FALLOS_REVISAR = 3;
const claveTexto = (t) => normalizar(t).replace(/[^a-z0-9]/g, '');

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
  const [filtroLab, setFiltroLab] = useState('todos');
  const [filtroRevisar, setFiltroRevisar] = useState('todos');
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
  const [progresoCsv, setProgresoCsv] = useState(null);
  const [previewCsv, setPreviewCsv] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [confirmRobotTodos, setConfirmRobotTodos] = useState(false);
  const [showCobertura, setShowCobertura] = useState(false);
  // Producto y cadena ya elegidos al abrir "Vincular enlace" desde otro sitio.
  const [preseleccion, setPreseleccion] = useState(null);

  const [seleccion, setSeleccion] = useState(() => new Set());
  const [confirmBorrarSel, setConfirmBorrarSel] = useState(false);
  const [procesandoSel, setProcesandoSel] = useState(null);
  const [ocultos, setOcultos] = useState(() => new Set());
  const borradosPendientes = useRef(new Map());

  const fileInputRef = useRef(null);
  const buscadorRef = useRef(null);
  const menuMasRef = useRef(null);

  // Si llegamos con ?producto=140216 (desde Productos), se filtra por el.
  // Con &vincular=1 (boton de la ficha de Productos) se abre el formulario.
  useEffect(() => {
    const productoParam = searchParams.get('producto');
    if (productoParam) setFiltroProducto(productoParam);
    // Desde Cadenas: ?cadena=Saas&revisar=otra_web
    const cadenaParam = searchParams.get('cadena');
    if (cadenaParam) setFiltroCadena(cadenaParam);
    const revisarParam = searchParams.get('revisar');
    if (revisarParam) setFiltroRevisar(revisarParam);
    if (productoParam && searchParams.get('vincular') === '1') {
      setPreseleccion({ producto: productoParam, cadena: '' });
      setEditing('new');
      setSearchParams({ producto: productoParam });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Desde Revision de capturas: ?editar=<publicacion>&volver=revision abre el
  // formulario de ese enlace y, al cerrarlo, regresa a la bandeja.
  const navigate = useNavigate();
  const volverRef = useRef(null);
  useEffect(() => {
    const editarParam = searchParams.get('editar');
    if (!editarParam || loading) return;
    const item = (items || []).find(it => String(publicacionIdDe(it)) === editarParam);
    const volver = searchParams.get('volver');
    setSearchParams({}, { replace: true });
    if (!item) {
      addToast('No se encontró ese enlace en Competencia.', 'warning');
      return;
    }
    volverRef.current = volver === 'revision' ? '/experimental?tab=revision' : null;
    setEditing(item.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, items, loading]);
  // Se vuelve solo cuando el formulario abierto desde la bandeja se cierra
  // (editing pasa de un id a null), no en el mismo render que lo abre.
  const editingAntes = useRef(null);
  useEffect(() => {
    const antes = editingAntes.current;
    editingAntes.current = editing;
    if (editing !== null || antes === null || !volverRef.current) return;
    const destino = volverRef.current;
    volverRef.current = null;
    navigate(destino);
  }, [editing, navigate]);

  const claveFiltros = [search, filtroProducto, filtroCadena, filtroTipo, filtroPrecio, filtroActivo, filtroLab, filtroRevisar].join('|');
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

  // Lecturas fallidas seguidas por publicacion. Sin la fase 23 la vista no
  // existe y simplemente no hay datos.
  const [fallos, setFallos] = useState(() => new Map());
  const cargarFallos = useCallback(async () => {
    if (!isSupabaseActive()) return;
    const { data, error } = await supabase.from('v_enlaces_fallidos').select('*');
    if (!error) setFallos(new Map((data || []).map(f => [String(f.publicacion_id), f])));
  }, []);
  useEffect(() => { cargarFallos(); }, [cargarFallos, items]);
  const fallosDe = (it) => fallos.get(String(publicacionIdDe(it))) || null;
  const revisarUrl = (it) => it.activo !== false && (fallosDe(it)?.fallos_seguidos || 0) >= FALLOS_REVISAR;

  // Posibles duplicados:
  //  - el mismo competidor (nombre, laboratorio, concentracion y tamano) dos
  //    veces en la misma cadena para el mismo producto;
  //  - dos enlaces propios del mismo producto en una cadena;
  //  - el mismo enlace (URL) en mas de un producto.
  const { duplicados, urlEnVarios } = useMemo(() => {
    const grupos = new Map();
    for (const it of items) {
      if (ocultos.has(it.id)) continue;
      const clave = [String(it.id_producto_propio).trim(), String(idCadena(it.cadena)).toLowerCase(),
        esPropio(it) ? '#propio' : claveCompetidor(it)].join('|');
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(it.id);
    }
    const ids = new Set();
    for (const lista of grupos.values()) if (lista.length > 1) lista.forEach(id => ids.add(id));
    const enVarios = new Set();
    const porUrl = new Map();
    for (const it of items) {
      if (ocultos.has(it.id) || !it.url) continue;
      const u = normalizarUrl(it.url);
      if (!porUrl.has(u)) porUrl.set(u, []);
      porUrl.get(u).push(it);
    }
    for (const lista of porUrl.values()) {
      if (new Set(lista.map(it => String(it.id_producto_propio))).size > 1) lista.forEach(it => { ids.add(it.id); enVarios.add(it.id); });
    }
    return { duplicados: ids, urlEnVarios: enVarios };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, ocultos, cadenaPorClave]);

  // Mercado mal armado: el competidor tiene otra concentracion, otro tamano
  // u otro tipo (marca / generico) que tu producto. Dosis y tamano solo si se
  // saben los dos lados.
  const mercadoDistinto = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      if (esPropio(it)) continue;
      const p = productoPorId.get(String(it.id_producto_propio).trim());
      if (!p) continue;
      const suyaDosis = concentracionDe(it);
      // Si su dosis se leyo del nombre (una sola) y la tuya es combinada, se
      // compara con la primera.
      const tuyaDosis = !it.concentracion && String(p.concentracion || '').includes('+')
        ? String(p.concentracion).split('+')[0] : p.concentracion;
      const dosis = suyaDosis && tuyaDosis && claveDosis(suyaDosis) !== claveDosis(tuyaDosis);
      const suyas = unidadesDe(it);
      const tuyas = Number(p.unidosis) > 0 ? Number(p.unidosis) : null;
      const tamano = suyas && tuyas && Math.abs(suyas - tuyas) > 0.001;
      // Marca contra generico: tu producto y el competidor, cada uno con su
      // tipo (el del competidor se carga en Competencia; fase 29).
      const tuTipo = esMarca(p) ? 'marca' : 'genérico';
      const suTipo = esMarca(it) ? 'marca' : 'genérico';
      const tipo = tuTipo !== suTipo;
      if (dosis || tamano || tipo) {
        m.set(it.id, {
          dosis, tamano, tipo,
          etiqueta: [dosis && 'Otra dosis', tamano && 'Otro tamaño', tipo && (suTipo === 'marca' ? 'Es marca' : 'Es genérico')].filter(Boolean).join(' · '),
          texto: `Tuyo: ${[p.concentracion, tuyas ? `x ${tuyas}` : '', tuTipo].filter(Boolean).join(' ')} · este: ${[suyaDosis, suyas ? `x ${suyas}` : '', suTipo].filter(Boolean).join(' ')}`,
        });
      }
    }
    return m;
  }, [items, productoPorId]);

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
      if (filtroLab !== 'todos' && (esPropio(it) || it.laboratorio !== filtroLab)) return false;
      if (filtroRevisar === 'fallos' && !revisarUrl(it)) return false;
      if (filtroRevisar === 'duplicados' && !duplicados.has(it.id)) return false;
      if (filtroRevisar === 'mercado' && !mercadoDistinto.has(it.id)) return false;
      if (filtroRevisar === 'viejo' && !(it.activo && enlaceCaido(it))) return false;
      if (filtroRevisar === 'otra_web' && !esDeOtraWeb(it.url, cadenaPorClave.get(String(it.cadena || '').toLowerCase())?.website)) return false;
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
  }, [items, search, filtroProducto, filtroCadena, filtroTipo, filtroPrecio, filtroActivo, filtroLab, filtroRevisar, fallos, duplicados, mercadoDistinto, orden, ocultos, productoPorId, cadenaPorClave, tasaBcv]);

  const hayFiltros = filtroProducto !== 'todos' || filtroCadena !== 'todas' || filtroTipo !== 'todos' || filtroPrecio !== 'todos' ||
    filtroActivo !== 'todos' || filtroLab !== 'todos' || filtroRevisar !== 'todos';
  const limpiarFiltros = () => {
    setFiltroProducto('todos'); setFiltroCadena('todas'); setFiltroTipo('todos');
    setFiltroPrecio('todos'); setFiltroActivo('todos'); setFiltroLab('todos'); setFiltroRevisar('todos');
    if (searchParams.get('producto')) setSearchParams({});
  };

  const caidosActivos = useMemo(() => items.filter(it => it.activo && enlaceCaido(it)).length, [items]);
  const urlsQueFallan = useMemo(() => items.filter(revisarUrl).length,
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, fallos]);
  const laboratoriosCompetidores = useMemo(() => [...new Set(items.filter(it => !esPropio(it) && it.laboratorio).map(it => it.laboratorio))]
    .sort((a, b) => a.localeCompare(b)), [items]);
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
  // El robot corre en GitHub Actions: tarda unos minutos en arrancar. El
  // avance se sigue en useRobot y se muestra en un aviso sobre la tabla.
  const robot = useRobot({
    onTerminado: async ({ corrida, leidos, fallo, urlGitHub }) => {
      await cargar(true);
      cargarFallos();
      if (fallo) {
        addToast('El robot terminó con errores. Revisa la corrida en GitHub Actions.', 'error',
          urlGitHub ? { accion: { texto: 'Ver en GitHub', onClick: () => window.open(urlGitHub, '_blank', 'noopener') } } : {});
      } else if (corrida.ids) {
        addToast(`Robot terminado: ${leidos} de ${corrida.total} ${corrida.total === 1 ? 'enlace leído' : 'enlaces leídos'}.`, 'success');
      } else {
        addToast('Robot terminado: precios actualizados.', 'success');
      }
    },
    onError: (mensaje, { faltaConfig } = {}) => {
      if (faltaConfig) setShowGithubModal(true);
      addToast(mensaje, faltaConfig ? 'info' : 'error');
    },
  });
  const activos = useMemo(() => items.filter(it => it.activo !== false), [items]);
  const lanzarRobot = async (enlaces) => {
    const ok = await robot.lanzar(enlaces, activos);
    if (ok && enlaces) {
      const deBaja = enlaces.length - enlaces.filter(e => e.activo !== false).length;
      addToast(`Robot lanzado para ${enlaces.length - deBaja} ${enlaces.length - deBaja === 1 ? 'enlace' : 'enlaces'}${deBaja ? ` (${deBaja} de baja no se leen)` : ''}.`, 'info');
    }
    return ok;
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
      relacion: esPropio(it) ? 'propio' : 'competidor',
      competidor: esPropio(it) ? '' : (it.nombre_competidor || it.marca || ''),
      concentracion: esPropio(it) ? (p?.concentracion || '') : (it.concentracion || ''),
      laboratorio: esPropio(it) ? (p?.laboratorio || '') : (it.laboratorio || ''),
      ...contenidoCsv(it, p),
      tipo_mercado: (esPropio(it) ? esMarca(p) : esMarca(it)) ? 'marca' : 'generico',
      url: it.url || '',
      activo: it.activo === false ? 'no' : 'si',
      pvp_propio_usd: pvp ? pvp.toFixed(2) : '',
      precio_usd: usd ? usd.toFixed(2) : '',
      precio_bs: full ? full.toFixed(2) : '',
      precio_oferta_bs: desc && desc !== full ? desc.toFixed(2) : '',
      ultima_captura: it.ultimo_scrape ? String(it.ultimo_scrape).slice(0, 10) : '',
    };
  };

  // Unidades y medida del empaque: las de tu producto en las filas propias;
  // en las del competidor, las suyas (1 = "no se sabe": se deja vacio).
  const contenidoCsv = (it, p) => {
    if (esPropio(it)) {
      const unidades = Number(p?.unidosis) || parseUnidosisCount(p?.tamano, p?.nombre, null) || '';
      const medida = /\bml\b/i.test(p?.tamano || '') ? 'ml' : /\bg\b/i.test(p?.tamano || '') ? 'g' : 'unidad';
      return { unidades_empaque: unidades ? String(unidades) : '', medida: unidades ? medida : '' };
    }
    const n = Number(it.unidades_empaque);
    return n > 1
      ? { unidades_empaque: String(n), medida: ['ml', 'g'].includes(it.unidad_contenido) ? it.unidad_contenido : 'unidad' }
      : { unidades_empaque: '', medida: '' };
  };

  const handleExportar = () => {
    exportToCSV(ARCHIVO_REPORTE, COLUMNAS_CSV_REPORTE, filtrados.map(filaCsvEnlace));
    addToast(`Exportados ${filtrados.length} enlaces a CSV.`, 'success');
  };

  const descargarPlantilla = () => {
    const filas = items.length > 0
      ? items.map(filaCsvEnlace)
      : [
          { id_interno: '140216', nombre: 'ACETAMINOFEN', cadena: 'Farmatodo', relacion: 'propio', competidor: '', concentracion: '500 mg', laboratorio: 'LA SANTE', unidades_empaque: '20', medida: 'unidad', tipo_mercado: 'generico', url: 'https://www.farmatodo.com.ve/producto/111243559-acetaminofen-500-la-sante', activo: 'si' },
          { id_interno: '140216', nombre: 'ACETAMINOFEN', cadena: 'Farmatodo', relacion: 'competidor', competidor: 'Atamel', concentracion: '500 mg', laboratorio: 'CALOX', unidades_empaque: '20', medida: 'unidad', tipo_mercado: 'marca', url: 'https://www.farmatodo.com.ve/producto/114592534-atamel-500', activo: 'si' },
        ];
    exportToCSV(items.length > 0 ? ARCHIVO_PLANTILLA : `${ARCHIVO_PLANTILLA}_ejemplo`, COLUMNAS_CSV_PLANTILLA, filas);
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
      const enOtroProducto = [];
      rows.forEach((row) => {
        const id_producto = getRowValue(row, 'id_interno', 'id_producto_propio', 'id_producto', 'sku').trim();
        const url = getRowValue(row, 'url', 'enlace', 'link', 'url_competencia').trim();
        if (!url || !id_producto) return;
        const cadena = idCadena(getRowValue(row, 'cadena', 'cadena_farmacia', 'farmacia').trim());
        const clave = `${String(cadena).toLowerCase()}|${normalizarUrl(url)}`;
        if (vistas.has(clave)) { duplicados++; return; }
        // Un enlace solo puede estar en un producto: si esta URL ya esta
        // vinculada a otro, la fila no se carga (antes lo movia en silencio).
        const enOtro = items.find(it => normalizarUrl(it.url || '') === normalizarUrl(url)
          && String(it.id_producto_propio).trim() !== String(id_producto).trim());
        if (enOtro) { enOtroProducto.push(`${id_producto} → ya está en ${enOtro.id_producto_propio}`); return; }
        vistas.add(clave);

        const tipoRaw = celdaExacta(row, 'relacion', 'tipo', 'tipo_enlace').trim().toLowerCase();
        const propio = ['propio', 'propia', 'mi producto', 'mi marca'].includes(tipoRaw);
        const claveActivo = Object.keys(row).find(k => k.trim().toLowerCase() === 'activo');
        const activoRaw = claveActivo ? String(row[claveActivo] ?? '').trim().toLowerCase() : '';
        const existente = items.find(it => `${String(idCadena(it.cadena)).toLowerCase()}|${normalizarUrl(it.url || '')}` === clave);
        // Por nombre exacto: con getRowValue una celda 'competidor' vacia
        // tomaba el valor de 'laboratorio_competidor', que la contiene.
        const marca = celdaExacta(row, 'competidor', 'marca', 'marca_competencia');
        const laboratorio = getRowValue(row, 'laboratorio_competidor', 'laboratorio', 'fabricante').trim();
        const unidades = Number(getRowValue(row, 'unidades_empaque', 'unidades_por_empaque').trim().replace(',', '.'));
        const medidaLeida = getRowValue(row, 'medida', 'unidad_contenido').trim().toLowerCase();
        const medida = ['ml', 'g'].includes(medidaLeida) ? medidaLeida : ['unidad', 'unidades', 'und', 'u'].includes(medidaLeida) ? 'unidad' : null;
        // Marca o generico: vacio = se conserva lo guardado; en uno nuevo se
        // deduce del nombre (si empieza con la molecula es generico).
        const tipoMercadoLeido = leerTipoMercado(getRowValue(row, 'tipo_mercado', 'marca_o_generico'));
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
          // En filas propias laboratorio, unidades, medida y tipo son de
          // Productos: se ignoran.
          laboratorio: propio ? '' : laboratorio || (existente && !esPropio(existente) ? existente.laboratorio || '' : ''),
          unidades_empaque: !propio && unidades > 0 ? unidades : null,
          unidad_contenido: !propio && unidades > 0 ? (medida || 'unidad') : null,
          concentracion: propio ? '' : getRowValue(row, 'concentracion', 'dosis').trim(),
          principio_activo_propio: productoPorId.get(id_producto)?.principio_activo || '',
          tipo_mercado: propio ? null
            : tipoMercadoLeido || (existente ? null : sugerirTipoMercado(marca, productoPorId.get(id_producto)?.principio_activo)),
        });
      });
      if (lista.length === 0 && !enOtroProducto.length) throw new Error('No hay filas con producto y URL.');
      // Solo se guardan las filas que cambian algo: reescribir 500 enlaces
      // iguales era lo que hacia la carga tan lenta.
      const porId = new Map(items.map(it => [it.id, it]));
      const aGuardar = lista.filter(n => !sinCambios(n, porId.get(n.id)));
      const iguales = lista.length - aGuardar.length;
      if (aGuardar.length) await dbUpsertCompetenciaBulk(aGuardar, (hechos, total) => setProgresoCsv({ hechos, total }));
      if (refreshCompetencia) refreshCompetencia();
      await cargar(true);
      addToast(`Importación terminada: ${aGuardar.length} ${aGuardar.length === 1 ? 'enlace guardado' : 'enlaces guardados'}${iguales ? `, ${iguales} sin cambios` : ''}${duplicados ? `, ${duplicados} repetidos en el archivo (omitidos)` : ''}.`, 'success');
      if (enOtroProducto.length) {
        addToast(`${enOtroProducto.length} ${enOtroProducto.length === 1 ? 'fila no se cargó' : 'filas no se cargaron'}: su enlace ya está en otro producto (${enOtroProducto.slice(0, 3).join('; ')}${enOtroProducto.length > 3 ? '…' : ''}). Para moverlo, edita ese enlace.`, 'warning');
      }
      setShowCsvModal(false);
    } catch (err) {
      addToast('Error importando: ' + (err.message || String(err)), 'error');
    } finally {
      setProgresoCsv(null);
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
  // "Bs 1.234,56". Desde 10.000 sin centimos, para que quepa en la columna.
  const formatoBs = (v) => `Bs ${v.toLocaleString('es-VE', v >= 10000
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    if (robot.leyendo(it)) {
      return (
        <>
          <div className="m3-cell-primary text-primary font-medium" title="El robot está leyendo este enlace">Leyendo</div>
          <div className="m3-cell-secondary text-primary">
            <span className="material-symbols-outlined text-[16px] animate-spin align-middle" aria-hidden="true">sync</span>
          </div>
        </>
      );
    }
    const f = fallosDe(it);
    if (revisarUrl(it)) {
      return (
        <>
          <div className="m3-cell-primary text-error font-medium" title={`Revisar la URL. ${f.ultimo_error || 'El robot no logra leer esta página.'}`}>Revisar</div>
          <div className="m3-cell-secondary">{f.fallos_seguidos} fallos</div>
        </>
      );
    }
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
          <button data-edita onClick={() => setShowCsvModal(true)} className="m3-btn-outline" title="Crear o actualizar muchos enlaces con un CSV">
            <span className="material-symbols-outlined text-base">upload_file</span>
            <span>Carga masiva</span>
          </button>
          <button data-edita onClick={() => { setPreseleccion(null); setEditing('new'); }} className="m3-btn-primary">
            <span className="material-symbols-outlined text-base">add_link</span>
            <span>Vincular enlace</span>
          </button>
          <details ref={menuMasRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item"
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setShowCobertura(true); }}>
                <span className="material-symbols-outlined">grid_view</span>
                Cobertura por cadena
              </button>
              <button data-edita type="button" role="menuitem" className="m3-menu-item" disabled={Boolean(robot.corrida)}
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setConfirmRobotTodos(true); }}>
                <span className={`material-symbols-outlined ${robot.corrida ? 'animate-spin' : ''}`}>{robot.corrida ? 'sync' : 'smart_toy'}</span>
                {robot.corrida ? 'Robot en curso…' : 'Leer todos los precios'}
              </button>
              <button data-borra type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger"
                disabled={deletingAll || items.length === 0}
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setConfirmDeleteAll(true); }}>
                <span className="material-symbols-outlined">delete_sweep</span>
                {deletingAll ? 'Vaciando…' : 'Vaciar enlaces'}
              </button>
            </div>
          </details>
        </div>
      </div>

      <AvisoRobot robot={robot} />

      {productoFiltradoSinEnlaces ? (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">link_off</span>
          <span className="m3-body-medium flex-1">
            <strong>{productoFiltradoSinEnlaces.nombre}</strong> todavía no tiene enlaces: el robot no lo vigila.
          </span>
          <button data-edita type="button" onClick={() => { setPreseleccion({ producto: filtroProducto, cadena: '' }); setEditing('new'); }} className="m3-btn-text">Vincular enlace</button>
        </div>
      ) : (urlsQueFallan > 0 || duplicados.size > 0 || mercadoDistinto.size > 0 || caidosActivos > 0) && filtroRevisar === 'todos' && (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">rule</span>
          <span className="m3-body-medium flex-1 min-w-0">
            <strong>Para revisar:</strong>{' '}
            <span className="m3-banner-links">
              {urlsQueFallan > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('fallos')} className="text-primary font-medium hover:underline"
                  title={`El robot falló ${FALLOS_REVISAR} o más veces seguidas: casi siempre la tienda cambió o quitó la página`}>
                  {urlsQueFallan} {urlsQueFallan === 1 ? 'URL que falla' : 'URL que fallan'}
                </button>
              )}
              {duplicados.size > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('duplicados')} className="text-primary font-medium hover:underline"
                  title="El mismo competidor dos veces en la misma cadena para un producto">
                  {duplicados.size} posibles duplicados
                </button>
              )}
              {mercadoDistinto.size > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('mercado')} className="text-primary font-medium hover:underline"
                  title="Competidores con otra concentración, otro tamaño u otro tipo (marca / genérico) que tu producto: no se comparan peras con peras">
                  {mercadoDistinto.size} con dosis, tamaño o tipo distinto
                </button>
              )}
              {caidosActivos > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('viejo')} className="text-primary font-medium hover:underline"
                  title={`Enlaces activos sin precio nuevo hace más de ${DIAS_ENLACE_CAIDO} días`}>
                  {caidosActivos} sin precio hace +{DIAS_ENLACE_CAIDO} días
                </button>
              )}
            </span>
          </span>
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
                  <button data-edita type="button" onClick={async () => { if (await lanzarRobot(seleccionados)) setSeleccion(new Set()); }}
                    disabled={Boolean(robot.corrida)} className="m3-btn-tonal"
                    title={robot.corrida ? 'Ya hay una lectura en curso' : 'El robot lee ahora el precio de los enlaces seleccionados'}>
                    <span className="material-symbols-outlined">smart_toy</span>
                    Leer precios
                  </button>
                  <button data-edita type="button" onClick={() => cambiarActivoSeleccion(false)} className="m3-btn-primary h-10" title="El robot deja de leerlos. Conserva el historial.">
                    <span className="material-symbols-outlined">archive</span>
                    Dar de baja
                  </button>
                  <button data-edita type="button" onClick={() => cambiarActivoSeleccion(true)} className="m3-btn-text">
                    <span className="material-symbols-outlined">unarchive</span>
                    Reactivar
                  </button>
                  <button data-borra type="button" onClick={() => setConfirmBorrarSel(true)} className="m3-btn-text m3-btn-text-danger">
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
                  <Segmentado etiqueta="Moneda de la columna Precio" rotulo="Moneda" valor={enBs ? 'bs' : 'usd'} onChange={v => cambiarMoneda(v === 'bs')}
                    opciones={[['usd', '$', 'Dólares'], ['bs', 'Bs', 'Bolívares']]} />
                  <div className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">
                    {filtrados.length === items.length ? `${items.length} enlaces` : `${filtrados.length} de ${items.length} enlaces`}
                  </div>
                </div>
              </div>
              <BarraFiltros
                integrada
                limpiar={{ visible: hayFiltros, onClick: limpiarFiltros }}
                filtrar={(
                  <>
                    <FiltroChip etiqueta="Producto" icono="medication" valor={filtroProducto}
                      onChange={v => { setFiltroProducto(v); if (searchParams.get('producto')) setSearchParams({}); }}
                      opciones={opcionesProducto} />
                    <FiltroChip etiqueta="Cadena" icono="storefront" valor={filtroCadena === 'todas' ? 'todos' : filtroCadena}
                      onChange={v => setFiltroCadena(v === 'todos' ? 'todas' : v)}
                      opciones={[['todos', 'Cadena: todas'], ...(cadenas || []).map(c => [c.id, c.nombre])]} />
                    <FiltroChip etiqueta="Relación" icono="sell" valor={filtroTipo} onChange={setFiltroTipo}
                      opciones={[['todos', 'Relación: todas'], ['propio', 'Mis productos'], ['competidor', 'Competidores']]} />
                    <FiltroChip etiqueta="Laboratorio" icono="science" valor={filtroLab} onChange={setFiltroLab}
                      opciones={[['todos', 'Laboratorio: todos'], ...laboratoriosCompetidores.map(l => [l, l])]} />
                    <FiltroChip etiqueta="Precio" icono="payments" valor={filtroPrecio} onChange={setFiltroPrecio}
                      opciones={[['todos', 'Precio: todos'], ['con_precio', 'Con precio'], ['sin_captura', 'Sin captura']]} />
                    <FiltroChip etiqueta="Estado" icono="toggle_on" valor={filtroActivo} onChange={setFiltroActivo}
                      opciones={[['todos', 'Estado: todos'], ['activos', 'Activos'], ['inactivos', 'De baja']]} />
                    <FiltroChip etiqueta="Revisar" icono="rule" valor={filtroRevisar} onChange={setFiltroRevisar}
                      opciones={[['todos', 'Revisar: todos'], ['fallos', `La URL falla (${FALLOS_REVISAR}+ veces)`], ['duplicados', 'Posibles duplicados'], ['mercado', 'Dosis, tamaño o tipo distinto al tuyo'], ['viejo', `Sin precio hace +${DIAS_ENLACE_CAIDO} días`], ['otra_web', 'URL de otra web']]} />
                  </>
                )}
              />
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
                        <span className="m3-cell-primary tabular-nums">{precioEnMoneda(it).texto || 'Sin precio'}</span>
                        {celdaDif(it)}
                        <span className={`m3-status ${it.activo ? 'is-on' : ''}`}>{it.activo ? 'Activo' : 'De baja'}</span>
                      </div>
                    </button>
                    <button data-edita type="button" onClick={() => setEditing(it.id)} className="m3-icon-btn" aria-label={`Editar ${it.marca}`}>
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
                  <col className="w-[96px]" />
                  <col className="w-[112px]" />
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
                          <div className="m3-cell-secondary">
                            {mercadoDistinto.has(it.id) && (
                              <span className="m3-chip-caido mr-1" title={mercadoDistinto.get(it.id).texto}>
                                {mercadoDistinto.get(it.id).etiqueta}
                              </span>
                            )}
                            {duplicados.has(it.id) && (
                              <span className="material-symbols-outlined m3-count-stale align-[-2px] mr-1" style={{ fontSize: 14 }}
                                title={urlEnVarios.has(it.id) ? 'Este mismo enlace está vinculado a más de un producto: debe quedar en uno solo' : 'Posible duplicado: hay otro enlace del mismo competidor (nombre, laboratorio, concentración y tamaño) en esta cadena para este producto'}
                                aria-label="Posible duplicado">content_copy</span>
                            )}
                            {it.laboratorio || '—'}
                          </div>
                        </td>
                        <td>
                          <div className="m3-cell-primary" title={nombreCadena(it.cadena)}>{nombreCadena(it.cadena)}</div>
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 m3-body-small text-on-surface-variant">
                            <CadenaBadge cadena={idCadena(it.cadena)} tamano="xs" title="" />
                            {propio && <span className="truncate">propio</span>}
                          </div>
                        </td>
                        <td>{celdaCaptura(it)}</td>
                        <td className="text-right">{celdaPrecio(it)}</td>
                        <td className="text-center">{celdaDif(it)}</td>
                        <td><span className={`m3-status ${it.activo ? 'is-on' : ''}`}>{it.activo ? 'Activo' : 'De baja'}</span></td>
                        <td className="m3-sticky-actions">
                          <div className="flex justify-end gap-1">
                            <button data-edita type="button" onClick={() => setEditing(it.id)} className="m3-icon-btn" title="Editar" aria-label={`Editar ${it.marca}`}>
                              <span className="material-symbols-outlined">edit</span>
                            </button>
                            <button data-edita type="button" onClick={() => handleToggleActivo(it)} className="m3-icon-btn"
                              title={it.activo ? 'Dar de baja' : 'Reactivar'} aria-label={`${it.activo ? 'Dar de baja' : 'Reactivar'} ${it.marca}`}>
                              <span className="material-symbols-outlined">{it.activo ? 'archive' : 'unarchive'}</span>
                            </button>
                            <button data-borra type="button" onClick={() => setConfirmDelete(it)} className="m3-icon-btn m3-icon-btn-danger" title="Eliminar" aria-label={`Eliminar ${it.marca}`}>
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
          robotOcupado={Boolean(robot.corrida)}
          leyendo={robot.leyendo(fichaItem)}
          fallos={fallosDe(fichaItem)}
          duplicado={duplicados.has(fichaItem.id)}
          onClose={() => setFichaId(null)}
          onEditar={() => { setFichaId(null); setEditing(fichaItem.id); }}
          onPrecioManual={() => setManualPriceItem(fichaItem)}
          onRobot={() => lanzarRobot([fichaItem])}
          onAlternarActivo={() => handleToggleActivo(fichaItem)}
        />
      )}

      {editing && (
        <EnlaceModal
          item={editing === 'new' ? null : items.find(i => i.id === editing)}
          productoIdPreseleccionado={preseleccion?.producto || (filtroProducto !== 'todos' ? filtroProducto : '')}
          cadenaPreseleccionada={preseleccion?.cadena || ''}
          tipoPreseleccionado={preseleccion?.tipo || ''}
          productos={productos}
          cadenas={cadenas}
          enlaces={items}
          onSave={handleSave}
          onClose={() => { setEditing(null); setPreseleccion(null); }}
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
              <div>relacion <span className="text-on-surface-variant font-sans font-medium">(propio / competidor)</span>, competidor <span className="text-on-surface-variant font-sans font-medium">(solo el nombre)</span>, concentracion, laboratorio</div>
              <div>unidades_empaque, medida <span className="text-on-surface-variant font-sans font-medium">(unidad / ml / g)</span></div>
              <div>tipo_mercado <span className="text-on-surface-variant font-sans font-medium">(marca / generico; vacío en uno nuevo = se deduce del nombre)</span></div>
              <div className="font-sans text-on-surface-variant pt-1">En las filas «propio», concentracion, laboratorio, unidades, medida y tipo_mercado vienen de Productos y al importar se ignoran: se cambian en Productos.</div>
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
          progreso={progresoCsv}
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

      <ConfirmModal
        isOpen={confirmRobotTodos}
        title="¿Leer todos los precios ahora?"
        message={`El robot leerá los ${activos.length} enlaces activos. Tarda unos ${estimarMinutos(activos)} minutos (GitHub necesita unos 4 para arrancar). Puedes seguir usando el panel: el avance se ve arriba de la tabla.\n\nEl robot ya corre solo todos los días a las 4:00 a. m.`}
        confirmText="Leer precios"
        cancelText="Cancelar"
        onConfirm={() => { setConfirmRobotTodos(false); lanzarRobot(null); }}
        onCancel={() => setConfirmRobotTodos(false)}
      />

      {showCobertura && (
        <CoberturaCadenas
          productos={productos}
          cadenas={cadenas}
          enlaces={items}
          idCadena={idCadena}
          onVincular={(producto, cadena) => { setShowCobertura(false); setPreseleccion({ producto, cadena, tipo: 'propio' }); setEditing('new'); }}
          onClose={() => setShowCobertura(false)}
        />
      )}

      <GitHubConfigModal isOpen={showGithubModal} onClose={() => setShowGithubModal(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulario de enlace: misma estructura que el de producto.
// ---------------------------------------------------------------------------
function EnlaceModal({ item, productoIdPreseleccionado, cadenaPreseleccionada = '', tipoPreseleccionado = '', productos, cadenas, enlaces = [], onSave, onClose }) {
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
    if (!item?.cadena) return cadenaPreseleccionada;
    const c = (cadenas || []).find(x => String(x.id).toLowerCase() === String(item.cadena).toLowerCase() || String(x.nombre).toLowerCase() === String(item.cadena).toLowerCase());
    return c?.id || item.cadena;
  })();

  const [productoTexto, setProductoTexto] = useState(productoInicial ? etiquetaProducto(productoInicial) : '');
  const [form, setForm] = useState({
    cadena: cadenaInicial,
    tipo: item ? (String(item.tipo) === 'propio' ? 'propio' : 'alternativa') : (tipoPreseleccionado === 'propio' ? 'propio' : 'alternativa'),
    // Nombre corto: sin dosis ni tamano, que van en sus campos.
    marca: item && String(item.tipo) !== 'propio' ? item.nombre_competidor || item.marca || '' : '',
    concentracion: item && String(item.tipo) !== 'propio' ? item.concentracion || '' : '',
    laboratorio: item && String(item.tipo) !== 'propio' ? item.laboratorio || '' : '',
    // 1 es el valor por defecto ("no se sabe"): el campo sale vacio.
    unidades: item && String(item.tipo) !== 'propio' && Number(item.unidades_empaque) > 1 ? String(Number(item.unidades_empaque)) : '',
    medida: ['ml', 'g'].includes(item?.unidad_contenido) ? item.unidad_contenido : 'unidad',
    // Vacio = se usa lo que sugiere el nombre (se ve en el desplegable).
    tipoMercado: ['MARCA', 'GENERICO'].includes(item?.tipo_mercado) ? item.tipo_mercado : '',
    url: item?.url || '',
    activo: item?.activo ?? true,
  });
  const [errores, setErrores] = useState({});
  const [saving, setSaving] = useState(false);
  const [errorGeneral, setErrorGeneral] = useState(null);

  const cambiar = (k, v) => { setErrorGeneral(null); setErrores(e => ({ ...e, [k]: undefined })); setForm(f => ({ ...f, [k]: v })); };
  const producto = productoDesdeTexto(productoTexto);
  const tipoSugerido = sugerirTipoMercado(form.marca, producto?.principio_activo);
  const tipoMercado = form.tipoMercado || tipoSugerido;

  // Enlaces que ya tiene el producto elegido: se ven antes de guardar, para
  // no vincular dos veces lo mismo.
  const cadenaDe = (v) => cadenasActivas.find(c => String(c.id).toLowerCase() === String(v || '').toLowerCase() ||
    String(c.nombre).toLowerCase() === String(v || '').toLowerCase()) || null;
  const existentes = useMemo(() => {
    if (!producto) return [];
    return (enlaces || [])
      .filter(e => e.id !== item?.id && String(e.id_producto_propio).trim() === String(producto.id_interno))
      .sort((a, b) => (esPropio(b) ? 1 : 0) - (esPropio(a) ? 1 : 0) ||
        String(cadenaDe(a.cadena)?.nombre || a.cadena).localeCompare(String(cadenaDe(b.cadena)?.nombre || b.cadena)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [producto?.id_interno, enlaces, item?.id]);
  const enEstaCadena = existentes.filter(e => (cadenaDe(e.cadena)?.id || e.cadena) === form.cadena);
  const avisoTipo = form.tipo === 'propio' && enEstaCadena.some(esPropio)
    ? `Tu producto ya tiene enlace en ${cadenaDe(form.cadena)?.nombre || form.cadena}.` : null;
  const claveForm = claveCompetidor({
    nombre_competidor: form.marca, laboratorio: form.laboratorio, concentracion: form.concentracion,
    unidades_empaque: Number(String(form.unidades).replace(',', '.')) || null,
  });
  const avisoMarca = form.tipo !== 'propio' && form.marca.trim() &&
    enEstaCadena.some(e => !esPropio(e) && claveCompetidor(e) === claveForm)
    ? `Ya hay un enlace de "${form.marca.trim()}" del mismo laboratorio, concentración y tamaño en ${cadenaDe(form.cadena)?.nombre || form.cadena} para este producto.` : null;
  // Nombre completo que se verá en tablas y fichas.
  const nombreCompleto = [form.marca.trim(), form.concentracion.trim(),
    form.unidades.trim() ? `x ${form.unidades.trim()}${form.medida === 'unidad' ? '' : ` ${form.medida}`}` : ''].filter(Boolean).join(' ');
  // El mismo enlace (la URL, sin importar el producto ni la cadena) solo
  // puede estar una vez: si ya existe en otro enlace, no se guarda.
  const urlRepetida = useMemo(() => {
    if (!form.url.trim()) return null;
    const url = normalizarUrl(/^https?:\/\//.test(form.url) ? form.url.trim() : `https://${form.url.trim()}`);
    return (enlaces || []).find(e => e.id !== item?.id && publicacionIdDe(e) !== publicacionIdDe(item || {})
      && normalizarUrl(e.url || '') === url) || null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.url, form.cadena, enlaces, item?.id]);

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
    if (form.tipo !== 'propio' && form.unidades.trim() && !(Number(form.unidades.replace(',', '.')) > 0)) e.unidades = 'Escribe un número mayor que cero';
    if (urlRepetida) e.url = `Este enlace ya está vinculado al producto ${urlRepetida.id_producto_propio}${String(urlRepetida.id_producto_propio) !== String(producto?.id_interno) ? ' (otro producto)' : ''}. Un enlace solo puede estar una vez.`;
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
      unidades_empaque: form.tipo !== 'propio' && form.unidades.trim() ? Number(form.unidades.replace(',', '.')) : null,
      unidad_contenido: form.tipo !== 'propio' && form.unidades.trim() ? form.medida : null,
      tipo_mercado: form.tipo !== 'propio' ? tipoMercado : null,
      concentracion: form.tipo !== 'propio' ? form.concentracion.trim() : '',
      principio_activo_propio: producto.principio_activo || '',
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
          {producto && (
            <div className="m3-existentes" aria-label="Enlaces que ya tiene este producto">
              <div className="m3-label-medium text-on-surface-variant">
                {existentes.length === 0 ? 'Este producto todavía no tiene enlaces.' : `Ya vinculados (${existentes.length})`}
              </div>
              {existentes.length > 0 && (
                <ul>
                  {existentes.map(e => {
                    const propioE = esPropio(e);
                    const misma = (cadenaDe(e.cadena)?.id || e.cadena) === form.cadena;
                    return (
                      <li key={e.id} className={misma ? 'is-match' : ''}>
                        <span className="m3-existentes-cadena">{cadenaDe(e.cadena)?.nombre || e.cadena}</span>
                        <span className="min-w-0 flex-1 truncate" title={propioE ? 'Tu producto' : `${e.marca}${e.laboratorio ? ` · ${e.laboratorio}` : ''}`}>
                          {propioE ? <span className="m3-chip-propio">Mi producto</span> : <>{e.marca}{e.laboratorio ? <span className="text-on-surface-variant"> · {e.laboratorio}</span> : ''}</>}
                        </span>
                        {!e.activo && <span className="m3-status shrink-0">De baja</span>}
                        {e.url && (
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn m3-icon-btn-sm shrink-0"
                            title="Abrir en la tienda" aria-label={`Abrir ${e.marca} en la tienda`}>
                            <span className="material-symbols-outlined">open_in_new</span>
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          <Field label="Cadena" requerido error={errores.cadena}>
            <ChoiceChips valor={form.cadena} onChange={v => cambiar('cadena', v)}
              opciones={cadenasActivas.map(c => [c.id, c.nombre])} nombre="cadena" />
          </Field>
          <Field label="Relación" requerido aviso={avisoTipo}>
            <ChoiceChips valor={form.tipo} onChange={v => cambiar('tipo', v)}
              opciones={[['alternativa', 'Competidor'], ['propio', 'Mi producto en esta cadena']]} nombre="tipo" />
          </Field>
        </FormSection>

        <FormSection titulo="Enlace" icono="link">
          <Field label="URL del producto en la tienda" requerido error={errores.url}
            aviso={urlRepetida ? `Esta URL ya está vinculada en ${cadenaDe(urlRepetida.cadena)?.nombre || urlRepetida.cadena} (${esPropio(urlRepetida) ? 'tu producto' : urlRepetida.marca}, producto ${urlRepetida.id_producto_propio}).` : avisoUrl}
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
              <Field label="Nombre del competidor" requerido error={errores.marca} aviso={avisoMarca}
                hint={nombreCompleto ? `Se verá como: ${nombreCompleto}` : 'Solo el nombre, sin dosis ni tamaño. Ej: Atamel o Acetaminofén Calox'}>
                <input type="text" value={form.marca} onChange={e => cambiar('marca', e.target.value)} className="m3-input" />
              </Field>
              <Field label="Concentración" hint={`Ej: 500 mg, 120 mg/5 ml.${producto?.concentracion ? ` La tuya: ${producto.concentracion}.` : ''}`}>
                <input type="text" value={form.concentracion} onChange={e => cambiar('concentracion', e.target.value)} className="m3-input" placeholder={producto?.concentracion || ''} />
              </Field>
              <Field label="Laboratorio" hint="Fabricante del competidor">
                <ComboField value={form.laboratorio} onChange={v => cambiar('laboratorio', v)}
                  opciones={dimensiones.laboratorios} cargando={!dimensiones.cargado} permitirNuevo />
              </Field>
              <Field label="Unidades por empaque" error={errores.unidades}
                hint={`Cuántas trae el empaque del competidor. Sirve para comparar por unidad.${producto?.tamano ? ` El tuyo: ${producto.tamano}.` : ''}`}>
                <div className="flex gap-2">
                  <input type="text" inputMode="decimal" value={form.unidades} onChange={e => cambiar('unidades', e.target.value)}
                    className="m3-input flex-1 min-w-0" placeholder="Ej: 20" aria-label="Unidades por empaque" />
                  <Select value={form.medida} onChange={e => cambiar('medida', e.target.value)} className="m3-select w-40" aria-label="Medida">
                    <option value="unidad">unidades</option>
                    <option value="ml">ml</option>
                    <option value="g">g</option>
                  </Select>
                </div>
              </Field>
              <Field label="Marca o genérico"
                hint={form.tipoMercado ? 'Elegido a mano.' : `Sugerido por el nombre: ${tipoSugerido === 'MARCA' ? 'marca' : 'genérico'}. Cámbialo si no es así.`}>
                <Select value={tipoMercado} onChange={e => cambiar('tipoMercado', e.target.value)} className="m3-select" aria-label="Marca o genérico">
                  <option value="GENERICO">Genérico</option>
                  <option value="MARCA">Marca</option>
                </Select>
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
