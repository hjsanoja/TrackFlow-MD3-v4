import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import ModalWrapper from '../components/ModalWrapper';
import ConfirmModal from '../components/ConfirmModal';

const TABLAS_CONFIG = {
  dim_laboratorios: {
    nombre: 'Laboratorios',
    icono: 'biotech',
    descripcion: 'Gestión de fabricantes, marcas y laboratorios (incluyendo marca propia vs competencia)',
    columnas: [
      { key: 'id', label: 'ID', type: 'number', readOnly: true },
      { key: 'nombre', label: 'Laboratorio', type: 'text', required: true },
      { key: 'es_propio', label: '¿Es Marca Propia?', type: 'boolean', defaultValue: false }
    ],
    pk: 'id',
    // Tablas que apuntan aquí. Sirve para contar los dependientes ANTES de
    // intentar el borrado y decir exactamente qué lo bloquea, en vez de
    // devolver el error crudo de Postgres.
    dependencias: [
      { tabla: 'dim_productos', columna: 'laboratorio_id', etiqueta: 'productos' },
      { tabla: 'dim_marcas', columna: 'laboratorio_id', etiqueta: 'marcas' }
    ]
  },
  dim_categorias: {
    nombre: 'Categorías Terapéuticas',
    icono: 'category',
    descripcion: 'Agrupación médica o terapéutica de los medicamentos y productos',
    columnas: [
      { key: 'id', label: 'ID', type: 'number', readOnly: true },
      { key: 'nombre', label: 'Categoría', type: 'text', required: true },
      { key: 'descripcion', label: 'Descripción', type: 'text' }
    ],
    pk: 'id',
    dependencias: [
      { tabla: 'dim_productos', columna: 'categoria_id', etiqueta: 'productos' }
    ]
  },
  dim_unidades_negocio: {
    nombre: 'Unidades de Negocio',
    icono: 'corporate_fare',
    descripcion: 'Líneas comerciales y de negocio internas (La Santé, Pharmetique, OTC, etc.)',
    columnas: [
      { key: 'id', label: 'ID', type: 'number', readOnly: true },
      { key: 'nombre', label: 'Nombre Unidad', type: 'text', required: true },
      { key: 'codigo', label: 'Código / Siglas', type: 'text' }
    ],
    pk: 'id',
    dependencias: [
      { tabla: 'dim_productos', columna: 'unidad_negocio_id', etiqueta: 'productos' }
    ]
  },
  dim_formas_farmaceuticas: {
    nombre: 'Formas Farmacéuticas',
    icono: 'medication_liquid',
    descripcion: 'Presentaciones galénicas (Tabletas, Jarabes, Cápsulas, Solución, Gotas, etc.)',
    columnas: [
      { key: 'id', label: 'ID', type: 'number', readOnly: true },
      { key: 'nombre', label: 'Forma Farmacéutica', type: 'text', required: true }
    ],
    pk: 'id',
    dependencias: [
      { tabla: 'dim_productos', columna: 'forma_farmaceutica_id', etiqueta: 'productos' }
    ]
  },
  dim_cadenas: {
    nombre: 'Cadenas',
    icono: 'storefront',
    descripcion: 'Cadenas monitoreadas para el web scraping (Farmatodo, Locatel, Farmacias SAAS, etc.)',
    columnas: [
      { key: 'id', label: 'ID de la Cadena', type: 'text', required: true },
      { key: 'nombre', label: 'Nombre de la Cadena', type: 'text', required: true },
      { key: 'color_hex', label: 'Color de la Cadena', type: 'color', defaultValue: '#040d53' },
      { key: 'activo', label: '¿Activo en Monitoreo?', type: 'boolean', defaultValue: true }
    ],
    pk: 'id',
    dependencias: [
      { tabla: 'publicaciones', columna: 'cadena_id', etiqueta: 'enlaces monitoreados' },
      { tabla: 'scrape_runs', columna: 'cadena_id', etiqueta: 'corridas del scraper' }
    ]
  },
  dim_tasa_bcv: {
    nombre: 'Histórico Tasas BCV',
    icono: 'currency_exchange',
    descripcion: 'Registro de tasas oficiales del Banco Central de Venezuela por fecha',
    columnas: [
      { key: 'fecha', label: 'Fecha (YYYY-MM-DD)', type: 'date', required: true },
      { key: 'tasa', label: 'Tasa (Bs/USD)', type: 'number', step: '0.0001', required: true },
      { key: 'fuente', label: 'Fuente', type: 'text', defaultValue: 'BCV' }
    ],
    pk: 'fecha'
  },
  pvp_propio: {
    nombre: 'PVP Propio Vigente',
    icono: 'price_check',
    descripcion: 'Histórico y precios de venta vigentes fijados para productos propios',
    columnas: [
      { key: 'id', label: 'ID', type: 'number', readOnly: true },
      { key: 'producto_id', label: 'ID Interno del Producto', type: 'number', required: true },
      { key: 'pvp_usd', label: 'PVP Oficial ($ USD)', type: 'number', step: '0.01', required: true },
      { key: 'vigente_desde', label: 'Vigente Desde', type: 'date', required: true },
      { key: 'vigente_hasta', label: 'Vigente Hasta (Opcional)', type: 'date' }
    ],
    pk: 'id'
  }
};

export default function Dimensiones() {
  const [activeTab, setActiveTab] = useState('dim_laboratorios');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingRow, setEditingRow] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Conteo de filas que impiden el borrado, para explicarlo antes de intentarlo.
  const [bloqueantes, setBloqueantes] = useState(null);
  const [revisandoDeps, setRevisandoDeps] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetType, setResetType] = useState('all'); // 'all' | 'scrapes' | 'products'

  const { addToast } = useToast();
  const { refreshData } = useData();

  const handleResetTables = async () => {
    setResetting(true);
    const fallos = [];
    let totalBorradas = 0;

    // Vacía una tabla y reporta el resultado real.
    // - `.not('id', 'is', null)` sirve para cualquier tipo de PK (uuid, text o
    //   bigint); el `.neq('id', -999999)` anterior reventaba contra las tablas
    //   de PK uuid/text y el error se descartaba en silencio.
    // - `.select('id')` es obligatorio: sin él PostgREST responde 204 y no hay
    //   forma de distinguir "borré todo" de "RLS bloqueó el DELETE".
    const vaciarTabla = async (tabla) => {
      const { data, error } = await supabase
        .from(tabla)
        .delete()
        .not('id', 'is', null)
        .select('id');

      if (error) {
        // Esperado tras fase5_archivo_deprecacion.sql, no es un fallo:
        //  42P01 = la tabla se renombró a legacy_* (historico_precios, productos).
        //  55000 = es una vista de compatibilidad no actualizable
        //          (productos_competencia); se vacía sola al limpiar
        //          fact_precios y publicaciones.
        if (error.code === '42P01' || error.code === '55000') return 0;
        fallos.push(`${tabla}: ${error.message}`);
        return 0;
      }

      const n = Array.isArray(data) ? data.length : 0;
      totalBorradas += n;
      return n;
    };

    try {
      if (isSupabaseActive()) {
        // Orden obligatorio: todas las FK del esquema son ON DELETE RESTRICT,
        // así que los hijos van siempre antes que los padres.
        if (resetType === 'scrapes' || resetType === 'all') {
          await vaciarTabla('historico_precios');
          await vaciarTabla('fact_precios');
          await vaciarTabla('scrape_runs');
        }

        if (resetType === 'products' || resetType === 'all') {
          await vaciarTabla('historico_precios');
          await vaciarTabla('fact_precios');
          await vaciarTabla('productos_competencia');
          await vaciarTabla('publicaciones');
          await vaciarTabla('pvp_propio');
          await vaciarTabla('producto_equivalencias');
          await vaciarTabla('dim_productos');
          await vaciarTabla('productos');
          await vaciarTabla('legacy_productos');
        }
      }

      try {
        sessionStorage.removeItem('trackflow_data_cache_v3');
      } catch (_) {}

      if (fallos.length > 0) {
        addToast(
          `La limpieza terminó con errores (${fallos.length}). Revisa la consola. Primero: ${fallos[0]}`,
          'error'
        );
        console.error('Tablas que no se pudieron limpiar:', fallos);
      } else if (totalBorradas === 0) {
        addToast(
          'No se borró ninguna fila. O las tablas ya estaban vacías, o falta la política DELETE de RLS (ejecuta fase6_correcciones.sql).',
          'warning'
        );
      } else {
        addToast(
          resetType === 'scrapes'
            ? `Scraping e histórico limpiados: ${totalBorradas} filas eliminadas.`
            : resetType === 'products'
            ? `Catálogo y PVP propio limpiados: ${totalBorradas} filas eliminadas.`
            : `Tablas operativas reiniciadas: ${totalBorradas} filas eliminadas.`,
          'success'
        );
      }

      setShowResetModal(false);
      await fetchTableData(activeTab);
      if (refreshData) refreshData(true);
    } catch (err) {
      console.error('Error limpiando datos:', err);
      addToast(`Error al limpiar datos: ${err.message}`, 'error');
    } finally {
      setResetting(false);
    }
  };

  const config = TABLAS_CONFIG[activeTab];

  const fetchTableData = useCallback(async (tableName) => {
    setLoading(true);
    try {
      if (!isSupabaseActive()) {
        setRows([]);
        return;
      }

      let queryBuilder = supabase.from(tableName).select('*');
      if (config?.pk) {
        queryBuilder = queryBuilder.order(config.pk, { ascending: true });
      }

      const { data, error } = await queryBuilder;

      if (error) throw error;
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(`Error cargando ${tableName}:`, err);
      addToast(`Error al cargar datos de ${config.nombre}: ${err.message}`, 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [config, addToast]);

  useEffect(() => {
    setSearchTerm('');
    setEditingRow(null);
    fetchTableData(activeTab);
  }, [activeTab, fetchTableData]);

  const filteredRows = useMemo(() => {
    if (!searchTerm.trim()) return rows;
    const term = searchTerm.toLowerCase().trim();
    return rows.filter(row => {
      return Object.values(row).some(val => 
        String(val ?? '').toLowerCase().includes(term)
      );
    });
  }, [rows, searchTerm]);

  const handleCreateNew = () => {
    const defaultData = {};
    config.columnas.forEach(col => {
      if (col.readOnly) return;
      if (col.defaultValue !== undefined) {
        defaultData[col.key] = col.defaultValue;
      } else if (col.type === 'boolean') {
        defaultData[col.key] = false;
      } else if (col.type === 'date') {
        defaultData[col.key] = new Date().toISOString().split('T')[0];
      } else if (col.type === 'number') {
        defaultData[col.key] = '';
      } else {
        defaultData[col.key] = '';
      }
    });
    setEditingRow(defaultData);
    setIsNew(true);
  };

  const handleEdit = (row) => {
    setEditingRow({ ...row });
    setIsNew(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...editingRow };

      // Convertir campos numéricos y tipos
      config.columnas.forEach(col => {
        if (col.type === 'number' && payload[col.key] !== '' && payload[col.key] !== undefined && payload[col.key] !== null) {
          payload[col.key] = Number(payload[col.key]);
        }
        if (col.type === 'boolean') {
          payload[col.key] = Boolean(payload[col.key]);
        }
        if (col.readOnly && isNew) {
          delete payload[col.key];
        }
      });

      let response;
      if (isNew) {
        response = await supabase.from(activeTab).insert([payload]).select();
      } else {
        const pkVal = editingRow[config.pk];
        response = await supabase.from(activeTab).update(payload).eq(config.pk, pkVal).select();
      }

      if (response.error) throw response.error;

      addToast(
        isNew ? `Elemento agregado a ${config.nombre} exitosamente` : `Registro actualizado en ${config.nombre}`,
        'success'
      );
      setEditingRow(null);
      await fetchTableData(activeTab);
      if (refreshData) refreshData(true);
    } catch (err) {
      console.error('Error al guardar fila:', err);
      addToast(`Error al guardar en ${config.nombre}: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Cuenta los dependientes ANTES de abrir el modal. Todas las FK del esquema
  // son ON DELETE RESTRICT, así que Postgres rechaza el borrado con el error
  // 23503 y un detalle tipo: Key is still referenced from table "dim_productos".
  // Ese mensaje no le dice nada a quien usa el panel; esto sí.
  const solicitarBorrado = async (row) => {
    setConfirmDelete(row);
    setBloqueantes(null);

    if (!config.dependencias || !isSupabaseActive()) return;

    setRevisandoDeps(true);
    try {
      const pkVal = row[config.pk];
      const conteos = await Promise.all(
        config.dependencias.map(async (dep) => {
          const { count, error } = await supabase
            .from(dep.tabla)
            .select('*', { count: 'exact', head: true })
            .eq(dep.columna, pkVal);
          return error ? null : { ...dep, total: count || 0 };
        })
      );
      setBloqueantes(conteos.filter(c => c && c.total > 0));
    } catch (err) {
      console.warn('No se pudieron contar los dependientes:', err);
      setBloqueantes(null);
    } finally {
      setRevisandoDeps(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const pkVal = confirmDelete[config.pk];

      // `.select()` es imprescindible. Sin él PostgREST devuelve 204 No Content
      // y un DELETE bloqueado por RLS se ve idéntico a uno exitoso: por eso el
      // panel mostraba "Registro eliminado" y la fila seguía ahí al recargar.
      const { data, error } = await supabase
        .from(activeTab)
        .delete()
        .eq(config.pk, pkVal)
        .select();

      if (error) throw error;

      if (!Array.isArray(data) || data.length === 0) {
        addToast(
          `No se eliminó nada de ${config.nombre}. La fila existe pero RLS no permite DELETE a tu usuario: ejecuta fase6_correcciones.sql en el SQL Editor de Supabase.`,
          'error'
        );
        return;
      }

      addToast(`Registro eliminado de ${config.nombre}`, 'success');
      setConfirmDelete(null);
      await fetchTableData(activeTab);
      if (refreshData) refreshData(true);
    } catch (err) {
      console.error('Error al eliminar fila:', err);

      // 23503 = foreign_key_violation. Con FKs ON DELETE RESTRICT es el caso
      // más común y el mensaje crudo de Postgres no le dice nada al usuario.
      const msg = err.code === '23503'
        ? `No se puede eliminar: hay registros que dependen de esta fila (${err.details || 'revisa productos, publicaciones o precios asociados'}). Elimina primero los dependientes.`
        : `No se pudo eliminar: ${err.message}`;

      addToast(msg, 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-display text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-3xl">schema</span>
            Tablas de Dimensiones Maestras
          </h1>
          <p className="text-sm text-on-surface-variant mt-1">
            Administra los catálogos relacionales del sistema: laboratorios, unidades de negocio, formas farmacéuticas, tasas y precios.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowResetModal(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 bg-surface-container border border-error/30 text-error hover:bg-error-container/20 rounded-xl font-bold text-xs transition-all cursor-pointer shadow-xs"
            title="Limpiar datos de prueba y reiniciar tablas"
          >
            <span className="material-symbols-outlined text-base">cleaning_services</span>
            Limpiar Datos de Prueba
          </button>

          <button
            onClick={handleCreateNew}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-md hover:bg-primary/90 transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-lg">add_circle</span>
            Nuevo en {config.nombre}
          </button>
        </div>
      </div>

      {/* Tabs de Dimensiones */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 border-b border-outline-variant/50 no-scrollbar">
        {Object.entries(TABLAS_CONFIG).map(([key, tab]) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                isActive
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              <span className="material-symbols-outlined text-base">{tab.icono}</span>
              <span>{tab.nombre}</span>
            </button>
          );
        })}
      </div>

      {/* Tarjeta Informativa de la Dimensión Activa */}
      <div className="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-2xl">{config.icono}</span>
          </div>
          <div>
            <h2 className="font-bold text-sm text-on-surface font-display">{config.nombre} (`{activeTab}`)</h2>
            <p className="text-xs text-on-surface-variant">{config.descripcion}</p>
          </div>
        </div>

        {/* Buscador Rápido */}
        <div className="relative w-full md:w-72">
          <span className="material-symbols-outlined absolute left-3 top-2.5 text-on-surface-variant text-lg">search</span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={`Buscar en ${config.nombre}...`}
            className="w-full pl-9 pr-3 py-2 bg-surface-container text-xs rounded-xl border border-outline-variant focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Tabla de Datos */}
      <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-surface-container border-b border-outline-variant text-on-surface-variant font-mono uppercase text-[10px] tracking-wider">
                {config.columnas.map(col => (
                  <th key={col.key} className="px-4 py-3 font-bold">
                    {col.label}
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-bold w-24">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-on-surface">
              {loading ? (
                <tr>
                  <td colSpan={config.columnas.length + 1} className="px-6 py-12 text-center text-on-surface-variant">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-3xl text-primary">progress_activity</span>
                      <span className="font-mono text-xs">Cargando catálogo `{activeTab}`...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={config.columnas.length + 1} className="px-6 py-12 text-center text-on-surface-variant">
                    <div className="flex flex-col items-center justify-center gap-1">
                      <span className="material-symbols-outlined text-4xl text-outline">inbox</span>
                      <p className="font-bold mt-2">No se encontraron registros</p>
                      <p className="text-[11px]">Usa el botón "Nuevo en {config.nombre}" para agregar la primera fila.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRows.map((row, idx) => {
                  const pkVal = row[config.pk];
                  return (
                    <tr key={pkVal || idx} className="hover:bg-surface-container-high/40 transition-colors">
                      {config.columnas.map(col => {
                        const val = row[col.key];
                        return (
                          <td key={col.key} className="px-4 py-3 align-middle font-sans">
                            {col.type === 'boolean' ? (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono ${
                                val ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-gray-100 text-gray-600 border border-gray-200'
                              }`}>
                                <span className="material-symbols-outlined text-[12px]">{val ? 'check' : 'close'}</span>
                                {val ? 'Sí / Propio' : 'No / Tercero'}
                              </span>
                            ) : col.type === 'color' ? (
                              <div className="flex items-center gap-2 font-mono">
                                <span className="w-4 h-4 rounded-full border border-gray-300" style={{ backgroundColor: val || '#000' }} />
                                <span>{val || '—'}</span>
                              </div>
                            ) : col.key === 'pvp_usd' || col.key === 'tasa' ? (
                              <span className="font-mono font-bold text-primary">
                                {col.key === 'pvp_usd' ? `$${Number(val || 0).toFixed(2)}` : `Bs ${Number(val || 0).toFixed(4)}`}
                              </span>
                            ) : (
                              <span className={col.readOnly ? 'font-mono text-on-surface-variant' : 'font-medium'}>
                                {val !== null && val !== undefined ? String(val) : '—'}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 text-right align-middle">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleEdit(row)}
                            className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-surface-container rounded-lg transition-colors cursor-pointer"
                            title="Editar fila"
                          >
                            <span className="material-symbols-outlined text-base">edit</span>
                          </button>
                          <button
                            onClick={() => solicitarBorrado(row)}
                            className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container/30 rounded-lg transition-colors cursor-pointer"
                            title="Eliminar fila"
                          >
                            <span className="material-symbols-outlined text-base">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de Crear / Editar Fila */}
      {editingRow && (
        <ModalWrapper
          isOpen={true}
          onClose={() => setEditingRow(null)}
          title={`${isNew ? 'Nuevo Registro' : 'Editar Registro'} · ${config.nombre}`}
        >
          <form onSubmit={handleSave} className="space-y-4">
            <p className="text-xs text-on-surface-variant">
              Modificando la tabla maestra <code className="bg-surface-container px-1.5 py-0.5 rounded font-mono font-bold text-primary">{activeTab}</code>
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {config.columnas.map(col => {
                if (col.readOnly && isNew) return null;

                const val = editingRow[col.key] ?? '';

                if (col.type === 'boolean') {
                  return (
                    <div key={col.key} className="md:col-span-2 flex items-center gap-3 bg-surface-container p-3 rounded-xl border border-outline-variant">
                      <input
                        type="checkbox"
                        id={`input_${col.key}`}
                        checked={Boolean(editingRow[col.key])}
                        onChange={(e) => setEditingRow({ ...editingRow, [col.key]: e.target.checked })}
                        className="w-4 h-4 rounded text-primary focus:ring-primary"
                      />
                      <label htmlFor={`input_${col.key}`} className="text-xs font-bold text-on-surface cursor-pointer select-none">
                        {col.label}
                      </label>
                    </div>
                  );
                }

                return (
                  <div key={col.key} className={col.key === 'descripcion' ? 'md:col-span-2' : ''}>
                    <label className="block text-xs font-bold text-on-surface mb-1 font-mono">
                      {col.label} {col.required && <span className="text-error">*</span>}
                    </label>
                    <input
                      type={col.type || 'text'}
                      step={col.step}
                      disabled={col.readOnly}
                      required={col.required}
                      value={val}
                      onChange={(e) => setEditingRow({ ...editingRow, [col.key]: e.target.value })}
                      className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary disabled:opacity-50 disabled:bg-surface-container-low"
                    />
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-2 pt-4 border-t border-outline-variant">
              <button
                type="button"
                onClick={() => setEditingRow(null)}
                className="px-4 py-2 border border-outline-variant text-on-surface-variant hover:bg-surface-container rounded-xl text-xs font-bold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-primary text-on-primary hover:bg-primary/90 rounded-xl text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
              >
                {saving && <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                {isNew ? 'Guardar Elemento' : 'Actualizar Cambios'}
              </button>
            </div>
          </form>
        </ModalWrapper>
      )}

      {/* Confirmar Eliminación */}
      {confirmDelete && (
        <ConfirmModal
          isOpen={true}
          title={`Eliminar Registro de ${config.nombre}`}
          message={
            revisandoDeps
              ? 'Revisando si algo depende de este registro...'
              : (bloqueantes && bloqueantes.length > 0)
                ? `No se puede eliminar "${confirmDelete.nombre || confirmDelete[config.pk]}" porque otros registros dependen de él:\n\n` +
                  bloqueantes.map(b => `  • ${b.total} ${b.etiqueta}`).join('\n') +
                  `\n\nElimina o reasigna esos registros primero. Nada se ha borrado.`
                : `¿Eliminar "${confirmDelete.nombre || confirmDelete[config.pk]}" de ${config.nombre}?\n\nNada depende de este registro, así que la eliminación es segura. La acción no se puede deshacer.`
          }
          confirmText={
            deleting ? 'Eliminando...'
              : (bloqueantes && bloqueantes.length > 0) ? 'Entendido'
              : 'Eliminar Registro'
          }
          isDanger={!(bloqueantes && bloqueantes.length > 0)}
          onConfirm={
            (bloqueantes && bloqueantes.length > 0)
              ? () => { setConfirmDelete(null); setBloqueantes(null); }
              : handleDelete
          }
          onCancel={() => { setConfirmDelete(null); setBloqueantes(null); }}
        />
      )}

      {/* Modal de Limpieza y Reinicio de Tablas */}
      {showResetModal && (
        <ModalWrapper
          isOpen={true}
          onClose={() => setShowResetModal(false)}
          title="Limpieza y Reinicio de Datos de Prueba"
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-on-surface">
              <div className="flex items-center gap-2 font-bold text-amber-600 mb-1">
                <span className="material-symbols-outlined text-base">warning</span>
                <span>Atención: Acción Destructiva</span>
              </div>
              <p className="text-on-surface-variant">
                Esta herramienta te permite vaciar los registros de prueba para arrancar desde cero con la estructura relacional limpia y sin datos mezclados.
              </p>
            </div>

            <div className="space-y-2">
              <label className="font-bold text-on-surface">Selecciona el alcance de la limpieza:</label>
              <div className="space-y-2">
                <label className="flex items-start gap-3 p-3 bg-surface-container rounded-xl border border-outline-variant cursor-pointer hover:bg-surface-container-high transition-colors">
                  <input
                    type="radio"
                    name="reset_type"
                    value="all"
                    checked={resetType === 'all'}
                    onChange={(e) => setResetType(e.target.value)}
                    className="mt-0.5 text-primary focus:ring-primary"
                  />
                  <div>
                    <div className="font-bold text-on-surface">Reiniciar Todo (Catálogo de Productos + Scraping + PVP)</div>
                    <div className="text-on-surface-variant text-[11px] mt-0.5">
                      Borra <code className="bg-surface-container-low px-1 rounded">dim_productos</code>, <code className="bg-surface-container-low px-1 rounded">pvp_propio</code>, <code className="bg-surface-container-low px-1 rounded">productos_competencia</code> e <code className="bg-surface-container-low px-1 rounded">historico_precios</code>. Conserva las dimensiones maestras (laboratorios, categorías, etc.).
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 bg-surface-container rounded-xl border border-outline-variant cursor-pointer hover:bg-surface-container-high transition-colors">
                  <input
                    type="radio"
                    name="reset_type"
                    value="scrapes"
                    checked={resetType === 'scrapes'}
                    onChange={(e) => setResetType(e.target.value)}
                    className="mt-0.5 text-primary focus:ring-primary"
                  />
                  <div>
                    <div className="font-bold text-on-surface">Limpiar solo Scraping e Histórico de Precios</div>
                    <div className="text-on-surface-variant text-[11px] mt-0.5">
                      Borra solo <code className="bg-surface-container-low px-1 rounded">historico_precios</code> y <code className="bg-surface-container-low px-1 rounded">scrape_runs</code>. Mantiene intactos tus productos y mapeos de URLs.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 bg-surface-container rounded-xl border border-outline-variant cursor-pointer hover:bg-surface-container-high transition-colors">
                  <input
                    type="radio"
                    name="reset_type"
                    value="products"
                    checked={resetType === 'products'}
                    onChange={(e) => setResetType(e.target.value)}
                    className="mt-0.5 text-primary focus:ring-primary"
                  />
                  <div>
                    <div className="font-bold text-on-surface">Limpiar solo Catálogo de Productos Propios y Competencia</div>
                    <div className="text-on-surface-variant text-[11px] mt-0.5">
                      Borra <code className="bg-surface-container-low px-1 rounded">dim_productos</code>, <code className="bg-surface-container-low px-1 rounded">pvp_propio</code> y enlaces de competencia.
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-4 border-t border-outline-variant">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 border border-outline-variant text-on-surface-variant hover:bg-surface-container rounded-xl text-xs font-bold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleResetTables}
                disabled={resetting}
                className="px-4 py-2 bg-error text-white hover:bg-error/90 rounded-xl text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
              >
                {resetting && <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                {resetting ? 'Limpiando...' : 'Confirmar y Limpiar'}
              </button>
            </div>
          </div>
        </ModalWrapper>
      )}
    </div>
  );
}
