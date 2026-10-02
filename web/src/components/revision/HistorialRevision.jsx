import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import CadenaBadge from '../CadenaBadge';
import FiltroChip from '../FiltroChip';
import BarraFiltros from '../BarraFiltros';
import InfoGrafico from '../InfoGrafico';
import { normalizar } from '../formulario';
import { haceCuanto, fechaHora } from '../../utils/usuarios';

// Historial de decisiones (fase 47): quien marco cada captura como valida o
// erronea, o la devolvio a pendientes, y cuando. Lo anota la base sola.
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const ACCIONES = {
  valida: ['Válida', 'check_circle', 'is-valida'],
  erronea: ['Errónea', 'block', 'is-erronea'],
  pendiente: ['Volvió a pendientes', 'undo', ''],
};
const bs = (v) => (v == null ? '—' : `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export default function HistorialRevision({ selector, nombreCadena }) {
  const [filas, setFilas] = useState([]);
  const [estado, setEstado] = useState({ cargando: true, sinFase: false, error: null });
  const [quien, setQuien] = useState('todos');
  const [accion, setAccion] = useState('todos');
  const [busqueda, setBusqueda] = useState('');

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setEstado({ cargando: false, sinFase: false, error: null }); return; }
    setEstado(e => ({ ...e, cargando: true }));
    const { data, error } = await supabase.from('v_revision_historial').select('*').order('fecha', { ascending: false }).limit(500);
    setFilas(error ? [] : data || []);
    setEstado({ cargando: false, sinFase: Boolean(error && faltaVista(error)), error: error && !faltaVista(error) ? error : null });
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const personas = useMemo(() => [...new Map(filas.map(f => [f.usuario || '', f.usuario_nombre || f.usuario || 'Sin usuario'])).entries()], [filas]);
  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return filas.filter(f => (quien === 'todos' || (f.usuario || '') === quien)
      && (accion === 'todos' || f.accion === accion)
      && (!t || normalizar(`${f.id_producto_propio} ${f.producto_propio_nombre} ${f.producto_nombre} ${f.laboratorio} ${f.nombre_capturado || ''}`).includes(t)));
  }, [filas, quien, accion, busqueda]);

  return (
    <section className="m3-data-table" aria-label="Historial de decisiones">
      <div className="m3-data-table-toolbar flex flex-col gap-3">
        <BarraFiltros integrada limpiar={{ visible: quien !== 'todos' || accion !== 'todos', onClick: () => { setQuien('todos'); setAccion('todos'); } }} filtrar={<>
          {selector}
          <FiltroChip etiqueta="Quién" icono="person" valor={quien} onChange={setQuien}
            opciones={[['todos', 'Quién: todos'], ...personas.map(([id, n]) => [id, n])]} />
          <FiltroChip etiqueta="Decisión" icono="rule" valor={accion} onChange={setAccion}
            opciones={[['todos', 'Decisión: todas'], ...Object.entries(ACCIONES).map(([k, [t]]) => [k, t])]} />
        </>} />
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <label className="m3-search-field">
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, producto o laboratorio" aria-label="Buscar en el historial" />
          </label>
          <div className="flex items-center gap-1 md:ml-auto">
            <span className="m3-label-large text-on-surface-variant mr-1">{visibles.length} decisiones</span>
            <InfoGrafico alinear="derecha" titulo="Historial de decisiones"
              que="Cada vez que alguien marca una captura como válida o errónea, o la devuelve a pendientes, la base anota quién y cuándo. También las de Precios repetidos y los «Deshacer»."
              lectura="Las marcas automáticas del control de calidad no salen aquí: solo las decisiones de una persona. Se anotan desde que se corrió la fase 47." />
            <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
              <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
          </div>
        </div>
      </div>

      {estado.sinFase ? (
        <p className="m3-body-medium text-on-surface-variant p-6">Ejecuta <strong>fase47_historial_revision.sql</strong> en Supabase para ver el historial.</p>
      ) : estado.cargando && !filas.length ? (
        <div className="h-48 m3-skeleton m-4 rounded-2xl" aria-busy="true" />
      ) : estado.error ? (
        <p className="m3-body-medium text-error p-6">No se pudo cargar: {estado.error.message}</p>
      ) : visibles.length === 0 ? (
        <p className="m3-body-medium text-on-surface-variant p-6 text-center">{filas.length ? 'Nada con estos filtros.' : 'Aún no hay decisiones anotadas.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="m3-table m3-table-apilada">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Quién</th>
                <th>Decisión</th>
                <th>Producto</th>
                <th>Cadena</th>
                <th className="text-right">Precio leído</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map(f => {
                const [texto, icono, clase] = ACCIONES[f.accion] || [f.accion, 'help', ''];
                return (
                  <tr key={f.id}>
                    <td className="whitespace-nowrap" data-label="Cuándo" title={fechaHora(f.fecha)}>{haceCuanto(f.fecha)}</td>
                    <td data-label="Quién"><span className="m3-cell-clamp max-w-[12rem]" title={f.usuario || ''}>{f.usuario_nombre || f.usuario || '—'}</span></td>
                    <td data-label="Decisión">
                      <span className={`m3-revision-estado ${clase}`}>
                        <span className="material-symbols-outlined" aria-hidden="true">{icono}</span>{texto}
                      </span>
                    </td>
                    <td data-label="Producto">
                      <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={f.producto_propio_nombre}>{f.producto_propio_nombre}</div>
                      <div className="m3-cell-secondary">{f.es_propio ? 'Tu enlace' : `${f.producto_nombre} · ${f.laboratorio}`}</div>
                    </td>
                    <td data-label="Cadena"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><CadenaBadge cadena={f.cadena_id} tamano="xs" title="" />{nombreCadena(f.cadena_id)}</span></td>
                    <td className="text-right tabular-nums whitespace-nowrap" data-label="Precio leído">{bs(f.precio_bs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
