import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import ModalWrapper from '../components/ModalWrapper';
import ConfirmModal from '../components/ConfirmModal';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import { FormSection, Field, ChoiceChips, ComboField, normalizar } from '../components/formulario';
import { invalidarDimensiones } from '../hooks/useDimensiones';
import { claveNombre, formatearMolecula } from '../utils/dbClient';
import { limpiarCacheDatos } from '../utils/cacheDatos';

// Catalogos del sistema. `uso`: la dimension la usan productos (se cuenta con
// v_uso_dimensiones, fase 27) y, si esta en uso, en vez de borrar se UNE con
// otra (fn_unir_dimension): la base no deja borrar algo que usan productos.
const TABLAS = {
  dim_laboratorios: {
    nombre: 'Laboratorios', singular: 'laboratorio', icono: 'biotech', uso: true,
    descripcion: 'Fabricantes de tus productos y de la competencia.',
    campos: [
      { key: 'nombre', label: 'Nombre', required: true },
      { key: 'es_propio', label: 'Laboratorio propio', type: 'boolean', hint: 'Tus laboratorios (LA SANTE). Los de la competencia van sin marcar.' },
    ],
  },
  dim_categorias: {
    nombre: 'Categorías', singular: 'categoría', icono: 'category', uso: true,
    descripcion: 'Agrupación terapéutica de los productos.',
    campos: [
      { key: 'nombre', label: 'Nombre', required: true },
      { key: 'descripcion', label: 'Descripción', type: 'textarea' },
    ],
  },
  dim_unidades_negocio: {
    nombre: 'Unidades de negocio', singular: 'unidad de negocio', icono: 'corporate_fare', uso: true,
    descripcion: 'Líneas comerciales internas (La Sante, Pharmetique, OTC…).',
    campos: [{ key: 'nombre', label: 'Nombre', required: true }],
  },
  dim_formas_farmaceuticas: {
    nombre: 'Formas farmacéuticas', singular: 'forma farmacéutica', icono: 'medication_liquid', uso: true,
    descripcion: 'Tabletas, jarabe, cápsulas, crema…',
    campos: [{ key: 'nombre', label: 'Nombre', required: true }],
  },
  dim_principios_activos: {
    nombre: 'Moléculas', singular: 'molécula', icono: 'science', uso: true,
    descripcion: 'Principios activos. Se guardan sin tildes; los otros nombres quedan como sinónimos.',
    campos: [{ key: 'nombre', label: 'Nombre', required: true }],
  },
  dim_tasa_bcv: {
    nombre: 'Tasas BCV', singular: 'tasa', icono: 'currency_exchange', pk: 'fecha', orden: { col: 'fecha', asc: false },
    descripcion: 'Tasa oficial del día. El robot la carga sola; aquí se corrige una mal cargada.',
    campos: [
      { key: 'fecha', label: 'Fecha', type: 'date', required: true },
      { key: 'tasa', label: 'Tasa (Bs por dólar)', type: 'number', step: '0.0001', required: true },
      { key: 'fuente', label: 'Fuente', defaultValue: 'BCV' },
    ],
  },
  pvp_propio: {
    nombre: 'Historial de PVP', singular: 'PVP', icono: 'price_check', soloLectura: true, orden: { col: 'vigente_desde', asc: false },
    descripcion: 'Cada cambio de PVP de tus productos. El PVP se cambia en Productos; aquí solo se consulta o se borra una fila errada.',
    campos: [],
  },
};

const pkDe = (t) => TABLAS[t].pk || 'id';

export default function Dimensiones() {
  const [activeTab, setActiveTab] = useState('dim_laboratorios');
  const [rows, setRows] = useState([]);
  const [uso, setUso] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filtroUso, setFiltroUso] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(25);
  const [editing, setEditing] = useState(null); // { row, nuevo }
  const [uniendo, setUniendo] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showResetModal, setShowResetModal] = useState(false);
  const menuMasRef = useRef(null);

  const { addToast } = useToast();
  // La carga no depende de addToast: si su identidad cambiara, se recargaria sin fin.
  const avisar = useRef(addToast);
  avisar.current = addToast;
  const { refreshData } = useData();
  const config = TABLAS[activeTab];
  const pk = pkDe(activeTab);

  // --------------------------------------------------------------- datos
  const cargar = useCallback(async (tabla) => {
    setLoading(true);
    try {
      if (!isSupabaseActive()) { setRows([]); return; }
      const cfg = TABLAS[tabla];
      let q = supabase.from(tabla).select(tabla === 'pvp_propio' ? '*, dim_productos(id_interno, nombre)' : '*');
      if (cfg.orden) q = q.order(cfg.orden.col, { ascending: cfg.orden.asc });
      const { data, error } = await q.limit(5000);
      if (error) throw error;
      setRows(data || []);
      if (cfg.uso) {
        const { data: u, error: eu } = await supabase.from('v_uso_dimensiones').select('*').eq('tabla', tabla);
        setUso(eu ? new Map() : new Map((u || []).map(x => [String(x.id), { propios: x.propios || 0, competidores: x.competidores || 0 }])));
      } else {
        setUso(new Map());
      }
    } catch (err) {
      avisar.current(`No se pudo cargar ${TABLAS[tabla].nombre}: ${err.message}`, 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSearch(''); setFiltroUso('todos'); setFiltroTipo('todos'); setPagina(1);
    setOrden({ campo: TABLAS[activeTab].orden ? TABLAS[activeTab].orden.col : 'nombre', dir: TABLAS[activeTab].orden?.asc === false ? 'desc' : 'asc' });
    cargar(activeTab);
  }, [activeTab, cargar]);

  const usoDe = (row) => uso.get(String(row.id)) || { propios: 0, competidores: 0 };
  const totalUso = (row) => { const u = usoDe(row); return u.propios + u.competidores; };

  const filtradas = useMemo(() => {
    const term = normalizar(search);
    const lista = rows.filter(r => {
      if (config.uso && filtroUso === 'en_uso' && totalUso(r) === 0) return false;
      if (config.uso && filtroUso === 'sin_uso' && totalUso(r) > 0) return false;
      if (activeTab === 'dim_laboratorios' && filtroTipo === 'propios' && !r.es_propio) return false;
      if (activeTab === 'dim_laboratorios' && filtroTipo === 'terceros' && r.es_propio) return false;
      if (!term) return true;
      const texto = activeTab === 'pvp_propio'
        ? `${r.dim_productos?.id_interno} ${r.dim_productos?.nombre}`
        : `${r.nombre || ''} ${(r.sinonimos || []).join(' ')} ${r.descripcion || ''} ${r.fecha || ''} ${r.fuente || ''}`;
      return normalizar(texto).includes(term);
    });
    const signo = orden.dir === 'asc' ? 1 : -1;
    const valor = (r) => orden.campo === 'uso' ? totalUso(r) : (r[orden.campo] ?? '');
    return [...lista].sort((a, b) => {
      const va = valor(a); const vb = valor(b);
      if (typeof va === 'number' && typeof vb === 'number') return signo * (va - vb);
      return signo * String(va).localeCompare(String(vb), 'es', { numeric: true });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, uso, search, filtroUso, filtroTipo, orden, activeTab]);

  useEffect(() => { setPagina(1); }, [search, filtroUso, filtroTipo, orden]);
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / porPagina));
  const visibles = filtradas.slice((pagina - 1) * porPagina, pagina * porPagina);
  const sinUso = config.uso ? rows.filter(r => totalUso(r) === 0).length : 0;

  const alternarOrden = (campo) => setOrden(o => (o.campo === campo ? { campo, dir: o.dir === 'asc' ? 'desc' : 'asc' } : { campo, dir: campo === 'uso' ? 'desc' : 'asc' }));
  const encabezado = (campo, texto, className = '') => (
    <th className={className} aria-sort={orden.campo === campo ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => alternarOrden(campo)} className={`m3-sort-btn ${orden.campo === campo ? 'is-active' : ''}`}>
        {texto}
        <span className="material-symbols-outlined" aria-hidden="true">
          {orden.campo !== campo ? 'unfold_more' : orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
        </span>
      </button>
    </th>
  );

  const tras = async () => {
    invalidarDimensiones();
    await cargar(activeTab);
    if (refreshData) refreshData(true);
  };

  // ------------------------------------------------------------ acciones
  const guardar = async (form, nuevo, original) => {
    const payload = {};
    for (const c of config.campos) {
      let v = form[c.key];
      if (c.type === 'boolean') v = Boolean(v);
      else if (c.type === 'number') v = v === '' || v == null ? null : Number(v);
      else v = typeof v === 'string' ? v.trim() : v;
      if (c.key === 'nombre' && activeTab === 'dim_principios_activos') v = formatearMolecula(v);
      payload[c.key] = v === '' ? null : v;
    }
    if (config.uso) {
      payload.sinonimos = String(form.sinonimosTexto || '').split(',').map(s => s.trim()).filter(Boolean);
      // Un nombre igual a otro (sin mayusculas ni tildes) seria un duplicado.
      const repetido = rows.find(r => r.id !== original?.id && claveNombre(r.nombre) === claveNombre(payload.nombre));
      if (repetido) throw new Error(`Ya existe "${repetido.nombre}". Si son el mismo, usa "Unir".`);
    }
    const q = nuevo
      ? supabase.from(activeTab).insert(payload).select()
      : supabase.from(activeTab).update(payload).eq(pk, original[pk]).select();
    let { data, error } = await q;
    // Sin la fase 27 aun no existe `sinonimos` en algunas tablas.
    if (error && /sinonimos/.test(error.message || '')) {
      delete payload.sinonimos;
      ({ data, error } = await (nuevo
        ? supabase.from(activeTab).insert(payload).select()
        : supabase.from(activeTab).update(payload).eq(pk, original[pk]).select()));
    }
    if (error) throw new Error(error.code === '23505' ? 'Ya existe un elemento con ese nombre.' : error.message);
    if (!data || data.length === 0) throw new Error('La base de datos no aceptó el cambio (permisos).');
    addToast(nuevo ? `${config.singular[0].toUpperCase()}${config.singular.slice(1)} creado.` : 'Cambios guardados.', 'success');
    setEditing(null);
    await tras();
  };

  const pedirBorrado = (row) => {
    if (config.uso && totalUso(row) > 0) { setUniendo({ row, desdeBorrar: true }); return; }
    setConfirmDelete(row);
  };

  const borrar = async () => {
    const row = confirmDelete;
    setConfirmDelete(null);
    const { data, error } = await supabase.from(activeTab).delete().eq(pk, row[pk]).select();
    if (error) {
      addToast(error.code === '23503'
        ? 'No se puede eliminar: todavía lo usan otros registros. Únelo con otro.'
        : `No se pudo eliminar: ${error.message}`, 'error');
      return;
    }
    if (!data || data.length === 0) { addToast('La base de datos no permitió eliminarlo (permisos).', 'error'); return; }
    addToast('Eliminado.', 'success');
    await tras();
  };

  const unir = async (origen, destinoId) => {
    const { data, error } = await supabase.rpc('fn_unir_dimension', { p_tabla: activeTab, p_origen: origen.id, p_destino: destinoId });
    if (error) {
      throw new Error(error.code === 'PGRST202' || /Could not find the function/i.test(error.message || '')
        ? 'Falta correr la fase 27 en Supabase para poder unir.'
        : error.message);
    }
    const destino = rows.find(r => r.id === destinoId);
    addToast(`"${origen.nombre}" unido con "${destino?.nombre}": ${data || 0} ${data === 1 ? 'registro pasó' : 'registros pasaron'} y su nombre quedó como sinónimo.`, 'success');
    setUniendo(null);
    await tras();
  };

  // ---------------------------------------------------------------- celdas
  const celdaUso = (row) => {
    const u = usoDe(row);
    if (u.propios + u.competidores === 0) return <span className="m3-cell-secondary">Sin uso</span>;
    return (
      <>
        <div className="m3-cell-primary tabular-nums">{u.propios + u.competidores} productos</div>
        <div className="m3-cell-secondary">
          {[u.propios ? `${u.propios} tuyos` : '', u.competidores ? `${u.competidores} competidores` : ''].filter(Boolean).join(' · ')}
        </div>
      </>
    );
  };

  const esFijo = activeTab === 'dim_tasa_bcv' || activeTab === 'pvp_propio';

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">schema</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Dimensiones</h1>
          </div>
          <p className="text-xs text-on-surface-variant">Los catálogos que usan los productos: laboratorios, categorías, unidades, formas, moléculas, tasas y PVP.</p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          {!config.soloLectura && (
            <button onClick={() => setEditing({ row: null, nuevo: true })} className="m3-btn-primary">
              <span className="material-symbols-outlined text-base">add</span>
              <span>Nuevo: {config.singular}</span>
            </button>
          )}
          <details ref={menuMasRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item-danger"
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setShowResetModal(true); }}>
                <span className="material-symbols-outlined">cleaning_services</span>
                Limpiar datos de prueba
              </button>
            </div>
          </details>
        </div>
      </div>

      <nav className="m3-tabs" aria-label="Catálogos">
        {Object.entries(TABLAS).map(([key, tab]) => (
          <button key={key} type="button" onClick={() => setActiveTab(key)} aria-current={activeTab === key ? 'page' : undefined}
            className={`m3-tab ${activeTab === key ? 'is-active' : ''}`}>
            <span className="material-symbols-outlined" aria-hidden="true">{tab.icono}</span>
            {tab.nombre}
          </button>
        ))}
      </nav>

      {config.uso && sinUso > 0 && filtroUso === 'todos' && (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">cleaning_services</span>
          <span className="m3-body-medium flex-1">
            <strong>{sinUso} {sinUso === 1 ? 'elemento no lo usa' : 'elementos no los usa'} ningún producto</strong>: se pueden eliminar sin problema.
          </span>
          <button type="button" onClick={() => setFiltroUso('sin_uso')} className="m3-btn-text">Ver cuáles</button>
        </div>
      )}

      <section className="m3-data-table" aria-label={config.nombre}>
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
            <p className="m3-body-medium text-on-surface-variant">{config.descripcion}</p>
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <label className="m3-search-field">
                <span className="material-symbols-outlined" aria-hidden="true">search</span>
                <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder={activeTab === 'pvp_propio' ? 'Buscar por ID o producto' : `Buscar en ${config.nombre.toLowerCase()}`} aria-label="Buscar" />
                {search && (
                  <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </label>
              <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
                {filtradas.length === rows.length ? `${rows.length} registros` : `${filtradas.length} de ${rows.length} registros`}
              </div>
            </div>
            {config.uso && (
              <div className="flex flex-wrap items-center gap-2">
                <FiltroChip etiqueta="Uso" icono="inventory_2" valor={filtroUso} onChange={setFiltroUso}
                  opciones={[['todos', 'Uso: todos'], ['en_uso', 'En uso'], ['sin_uso', 'Sin uso']]} />
                {activeTab === 'dim_laboratorios' && (
                  <FiltroChip etiqueta="Tipo" icono="verified" valor={filtroTipo} onChange={setFiltroTipo}
                    opciones={[['todos', 'Tipo: todos'], ['propios', 'Propios'], ['terceros', 'Competencia']]} />
                )}
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-4 space-y-3" aria-busy="true">
            {[1, 2, 3, 4].map(n => <div key={n} className="h-12 rounded-xl m3-skeleton" />)}
          </div>
        ) : filtradas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">inbox</span>
            <div className="m3-title-medium text-on-surface">No hay registros que coincidan</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-dimensiones">
              <thead className="m3-sticky-header">
                <tr>
                  {activeTab === 'dim_tasa_bcv' ? (
                    <>{encabezado('fecha', 'Fecha')}{encabezado('tasa', 'Tasa (Bs/$)', 'text-right')}<th>Fuente</th></>
                  ) : activeTab === 'pvp_propio' ? (
                    <><th>Producto</th>{encabezado('pvp_usd', 'PVP', 'text-right')}{encabezado('vigente_desde', 'Desde')}<th>Hasta</th></>
                  ) : (
                    <>
                      {encabezado('nombre', 'Nombre')}
                      {activeTab === 'dim_laboratorios' && <th>Tipo</th>}
                      {activeTab === 'dim_categorias' && <th>Descripción</th>}
                      {encabezado('uso', 'En uso')}
                    </>
                  )}
                  <th className="m3-sticky-actions"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((r) => (
                  <tr key={r[pk]}>
                    {activeTab === 'dim_tasa_bcv' ? (
                      <>
                        <td className="tabular-nums">{r.fecha}</td>
                        <td className="text-right tabular-nums font-medium">{Number(r.tasa || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                        <td className="text-on-surface-variant">{r.fuente || '—'}</td>
                      </>
                    ) : activeTab === 'pvp_propio' ? (
                      <>
                        <td>
                          <div className="m3-cell-primary">{r.dim_productos?.nombre || `Producto ${r.producto_id}`}</div>
                          <div className="m3-cell-secondary font-mono">{r.dim_productos?.id_interno || r.producto_id}</div>
                        </td>
                        <td className="text-right tabular-nums font-medium">${Number(r.pvp_usd || 0).toFixed(2)}</td>
                        <td className="tabular-nums">{r.vigente_desde}</td>
                        <td className="tabular-nums text-on-surface-variant">{r.vigente_hasta || 'vigente'}</td>
                      </>
                    ) : (
                      <>
                        <td>
                          <div className="m3-cell-primary">{r.nombre}</div>
                          {r.sinonimos?.length > 0 && (
                            <div className="m3-cell-secondary" title={r.sinonimos.join(', ')}>también: {r.sinonimos.join(', ')}</div>
                          )}
                        </td>
                        {activeTab === 'dim_laboratorios' && (
                          <td>{r.es_propio ? <span className="m3-chip-propio">Propio</span> : <span className="m3-body-medium text-on-surface-variant">Competencia</span>}</td>
                        )}
                        {activeTab === 'dim_categorias' && <td><span className="m3-cell-secondary" title={r.descripcion || ''}>{r.descripcion || '—'}</span></td>}
                        <td>{celdaUso(r)}</td>
                      </>
                    )}
                    <td className="m3-sticky-actions">
                      <div className="flex justify-end gap-1">
                        {!config.soloLectura && (
                          <button type="button" onClick={() => setEditing({ row: r, nuevo: false })} className="m3-icon-btn" title="Editar" aria-label="Editar">
                            <span className="material-symbols-outlined">edit</span>
                          </button>
                        )}
                        {config.uso && (
                          <button type="button" onClick={() => setUniendo({ row: r })} className="m3-icon-btn" title="Unir con otro (pasa sus productos y lo borra)" aria-label={`Unir ${r.nombre} con otro`}>
                            <span className="material-symbols-outlined">merge</span>
                          </button>
                        )}
                        <button type="button" onClick={() => pedirBorrado(r)} className="m3-icon-btn m3-icon-btn-danger" title="Eliminar" aria-label="Eliminar">
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filtradas.length > 0 && (
          <footer className="m3-data-table-footer">
            <label className="flex items-center gap-2 m3-body-medium text-on-surface-variant">
              Filas por página
              <Select value={porPagina} onChange={e => { setPorPagina(Number(e.target.value)); setPagina(1); }} className="m3-rows-select">
                {[25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
            <span className="m3-body-medium text-on-surface-variant sm:ml-auto">
              {(pagina - 1) * porPagina + 1}–{Math.min(filtradas.length, pagina * porPagina)} de {filtradas.length}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setPagina(p => Math.max(1, p - 1))} disabled={pagina === 1} className="m3-icon-btn" aria-label="Página anterior">
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="m3-label-large px-2">Página {pagina} de {totalPaginas}</span>
              <button type="button" onClick={() => setPagina(p => Math.min(totalPaginas, p + 1))} disabled={pagina === totalPaginas} className="m3-icon-btn" aria-label="Página siguiente">
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          </footer>
        )}
      </section>

      {editing && (
        <DimensionModal
          tabla={activeTab}
          row={editing.row}
          nuevo={editing.nuevo}
          uso={editing.row ? usoDe(editing.row) : null}
          onSave={guardar}
          onClose={() => setEditing(null)}
        />
      )}

      {uniendo && (
        <UnirModal
          config={config}
          origen={uniendo.row}
          desdeBorrar={uniendo.desdeBorrar}
          uso={usoDe(uniendo.row)}
          opciones={rows.filter(r => r.id !== uniendo.row.id)}
          onUnir={unir}
          onClose={() => setUniendo(null)}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        title={`¿Eliminar ${config.singular}?`}
        message={confirmDelete ? (esFijo
          ? `Se eliminará este registro${activeTab === 'dim_tasa_bcv' ? ` (${confirmDelete.fecha})` : ''}. No se puede deshacer.`
          : `Se eliminará "${confirmDelete.nombre}". Ningún producto lo usa. No se puede deshacer.`) : ''}
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger
        onConfirm={borrar}
        onCancel={() => setConfirmDelete(null)}
      />

      {showResetModal && (
        <LimpiezaModal
          onClose={() => setShowResetModal(false)}
          onTerminado={async () => { setShowResetModal(false); await tras(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crear / editar un elemento.
// ---------------------------------------------------------------------------
function DimensionModal({ tabla, row, nuevo, uso, onSave, onClose }) {
  const config = TABLAS[tabla];
  const [form, setForm] = useState(() => {
    const f = {};
    for (const c of config.campos) {
      f[c.key] = row ? (row[c.key] ?? (c.type === 'boolean' ? false : '')) :
        (c.defaultValue ?? (c.type === 'boolean' ? false : c.type === 'date' ? new Date().toISOString().slice(0, 10) : ''));
    }
    f.sinonimosTexto = (row?.sinonimos || []).join(', ');
    return f;
  });
  const [errores, setErrores] = useState({});
  const [errorGeneral, setErrorGeneral] = useState(null);
  const [saving, setSaving] = useState(false);
  const cambiar = (k, v) => { setErrorGeneral(null); setErrores(e => ({ ...e, [k]: undefined })); setForm(f => ({ ...f, [k]: v })); };

  const enviar = async (e) => {
    e.preventDefault();
    const err = {};
    for (const c of config.campos) if (c.required && String(form[c.key] ?? '').trim() === '') err[c.key] = 'Obligatorio';
    setErrores(err);
    if (Object.keys(err).length) return;
    setSaving(true);
    try { await onSave(form, nuevo, row); } catch (ex) { setErrorGeneral(ex.message); }
    setSaving(false);
  };

  const enUso = uso ? uso.propios + uso.competidores : 0;

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={nuevo ? `Nuevo: ${config.singular}` : `Editar ${config.singular}`}
      subtitle={nuevo ? config.nombre : (row?.nombre || row?.fecha || '')}
      icon={nuevo ? 'add' : 'edit'}
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
          <button type="submit" form="dimension-form" disabled={saving} className="m3-btn-primary h-10 px-6">
            {saving ? 'Guardando…' : nuevo ? 'Crear' : 'Guardar cambios'}
          </button>
        </div>
      }
    >
      <form id="dimension-form" onSubmit={enviar} noValidate className="space-y-4">
        {errorGeneral && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{errorGeneral}</span>
          </div>
        )}
        <FormSection titulo="Datos" icono={config.icono}>
          {config.campos.map(c => (
            c.type === 'boolean' ? (
              <Field key={c.key} label={c.label} hint={c.hint}>
                <ChoiceChips valor={form[c.key] ? 'si' : 'no'} onChange={v => cambiar(c.key, v === 'si')}
                  opciones={[['no', 'No'], ['si', 'Sí']]} nombre={c.key} />
              </Field>
            ) : (
              <Field key={c.key} label={c.label} requerido={c.required} error={errores[c.key]}
                hint={c.key === 'nombre' && tabla === 'dim_principios_activos' ? 'Se guarda sin tildes (Losartan potasico).' : c.hint}>
                {c.type === 'textarea' ? (
                  <textarea value={form[c.key] || ''} onChange={e => cambiar(c.key, e.target.value)} rows={3} className="m3-input" />
                ) : (
                  <input type={c.type || 'text'} step={c.step} value={form[c.key] ?? ''} disabled={!nuevo && c.key === config.pk}
                    onChange={e => cambiar(c.key, e.target.value)} className="m3-input" />
                )}
              </Field>
            )
          ))}
          {config.uso && (
            <Field label="Sinónimos" hint="Otros nombres con los que llega en los CSV, separados por coma. Una carga con esos nombres usará este elemento.">
              <input type="text" value={form.sinonimosTexto} onChange={e => cambiar('sinonimosTexto', e.target.value)} className="m3-input" />
            </Field>
          )}
          {!nuevo && enUso > 0 && (
            <p className="m3-body-small text-on-surface-variant">Lo usan {enUso} productos: el cambio de nombre se ve en todos.</p>
          )}
        </FormSection>
      </form>
    </ModalWrapper>
  );
}

// ---------------------------------------------------------------------------
// Unir: los productos del origen pasan al destino y el origen se borra.
// ---------------------------------------------------------------------------
function UnirModal({ config, origen, desdeBorrar, uso, opciones, onUnir, onClose }) {
  const [texto, setTexto] = useState('');
  const [error, setError] = useState(null);
  const [uniendo, setUniendo] = useState(false);
  const nombres = useMemo(() => opciones.map(o => o.nombre).sort((a, b) => a.localeCompare(b, 'es')), [opciones]);
  const destino = opciones.find(o => claveNombre(o.nombre) === claveNombre(texto)) || null;
  const total = uso.propios + uso.competidores;

  const confirmar = async () => {
    if (!destino) { setError(`Elige un ${config.singular} de la lista.`); return; }
    setUniendo(true);
    try { await onUnir(origen, destino.id); } catch (ex) { setError(ex.message); }
    setUniendo(false);
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={`Unir "${origen.nombre}"`}
      subtitle={`con otro ${config.singular}`}
      icon="merge"
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
          <button type="button" onClick={confirmar} disabled={uniendo || !destino} className="m3-btn-primary h-10 px-6">
            {uniendo ? 'Uniendo…' : destino ? `Unir con "${destino.nombre}"` : 'Unir'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {desdeBorrar && (
          <div className="m3-form-alert m3-form-alert-warning" role="status">
            <span className="material-symbols-outlined" aria-hidden="true">info</span>
            <span className="flex-1">
              No se puede eliminar directamente: lo usan {total} productos
              {uso.competidores ? ` (${uso.competidores} de la competencia)` : ''}. Únelo con otro {config.singular}: esos productos pasan al elegido y "{origen.nombre}" se borra.
            </span>
          </div>
        )}
        <Field label={`${config.singular[0].toUpperCase()}${config.singular.slice(1)} que queda`} requerido error={error}
          hint="Escribe para buscar y elige de la lista.">
          <ComboField value={texto} onChange={v => { setTexto(v); setError(null); }} opciones={nombres} placeholder="Buscar…" />
        </Field>
        <ul className="m3-body-medium text-on-surface-variant space-y-1 list-disc pl-5">
          <li>{total > 0 ? `Los ${total} productos de "${origen.nombre}" pasan a ${destino ? `"${destino.nombre}"` : 'el elegido'}.` : `"${origen.nombre}" no lo usa ningún producto.`}</li>
          <li>"{origen.nombre}" se borra y su nombre queda como sinónimo: si llega en un CSV, se usará el elegido.</li>
          <li>No se puede deshacer.</li>
        </ul>
      </div>
    </ModalWrapper>
  );
}

// ---------------------------------------------------------------------------
// Limpiar datos de prueba (vaciar tablas operativas).
// ---------------------------------------------------------------------------
function LimpiezaModal({ onClose, onTerminado }) {
  const { addToast } = useToast();
  const [tipo, setTipo] = useState('scrapes');
  const [confirmacion, setConfirmacion] = useState('');
  const [limpiando, setLimpiando] = useState(false);

  const limpiar = async () => {
    setLimpiando(true);
    const fallos = [];
    let total = 0;
    // `.select('id')` distingue "borré todo" de "RLS bloqueó el DELETE".
    const vaciar = async (tabla) => {
      const { data, error } = await supabase.from(tabla).delete().not('id', 'is', null).select('id');
      if (error) {
        // 42P01: tabla legacy renombrada; 55000: vista no actualizable.
        if (error.code !== '42P01' && error.code !== '55000') fallos.push(`${tabla}: ${error.message}`);
        return;
      }
      total += (data || []).length;
    };
    try {
      if (isSupabaseActive()) {
        // Hijos antes que padres: todas las FK son ON DELETE RESTRICT.
        await vaciar('fact_precios');
        await vaciar('scrape_runs');
        if (tipo === 'todo') {
          await vaciar('publicaciones');
          await vaciar('pvp_propio');
          await vaciar('producto_equivalencias');
          await vaciar('dim_productos');
        }
      }
      limpiarCacheDatos();
      if (fallos.length) addToast(`Terminó con errores (${fallos.length}): ${fallos[0]}`, 'error');
      else addToast(`Limpieza terminada: ${total} filas eliminadas.`, 'success');
      await onTerminado();
    } catch (err) {
      addToast(`Error al limpiar: ${err.message}`, 'error');
    } finally {
      setLimpiando(false);
    }
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title="Limpiar datos de prueba"
      subtitle="Vacía tablas operativas. No toca los catálogos de esta pantalla."
      icon="cleaning_services"
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
          <button type="button" onClick={limpiar} disabled={limpiando || confirmacion.trim().toUpperCase() !== 'BORRAR'}
            className="m3-btn-primary h-10 px-6 !bg-error !text-on-error">
            {limpiando ? 'Limpiando…' : 'Borrar datos'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Qué borrar">
          <ChoiceChips valor={tipo} onChange={setTipo} nombre="limpieza"
            opciones={[['scrapes', 'Solo precios capturados'], ['todo', 'Productos, enlaces y precios']]} />
        </Field>
        <p className="m3-body-medium text-on-surface-variant">
          {tipo === 'scrapes'
            ? 'Borra todas las capturas de precio y las corridas del robot. Tus productos y enlaces quedan.'
            : 'Borra TODO el catálogo: productos, enlaces, PVP, equivalencias, capturas y corridas. Solo para empezar de cero.'}
        </p>
        <Field label='Escribe BORRAR para confirmar' requerido>
          <input type="text" value={confirmacion} onChange={e => setConfirmacion(e.target.value)} className="m3-input" autoComplete="off" />
        </Field>
      </div>
    </ModalWrapper>
  );
}
