import LimpiarFiltros from '../components/LimpiarFiltros';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import FiltroChip from '../components/FiltroChip';
import Select from '../components/Select';
import CadenaBadge from '../components/CadenaBadge';
import AvisoRobot from '../components/AvisoRobot';
import GitHubConfigModal from '../components/GitHubConfigModal';
import { FormSection, Field, normalizar } from '../components/formulario';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { useRobot } from '../hooks/useRobot';
import { supabase, isSupabaseActive } from '../supabase';
import { dbGuardarCadena, dbCambiarActivoCadena, dbEliminarCadena } from '../utils/dbClient';
import { PALETA_CADENAS, siglaCadena } from '../utils/brandColors';
import { LECTORES, lectorDe, dominio, esDeOtraWeb } from '../utils/cadenas';
import { haceCuanto, fechaHora } from '../utils/usuarios';

// Cadenas con la misma estructura que Productos y Competencia: cada cadena
// con su color y sigla, su lector del robot, sus enlaces y su ultima lectura.
export default function Cadenas() {
  const { cadenas, productosCompetencia: enlaces, loadingInitial: loading, refreshData: cargar } = useData();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(null);
  const [fichaId, setFichaId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [search, setSearch] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('todos');
  const [filtroRobot, setFiltroRobot] = useState('todos');
  const [filtroRevisar, setFiltroRevisar] = useState('todos');

  // Lecturas del robot por cadena (scrape_runs: una fila por cadena y corrida).
  const [corridas, setCorridas] = useState([]);
  const cargarCorridas = useCallback(async () => {
    if (!isSupabaseActive()) return;
    const { data, error } = await supabase.from('scrape_runs')
      .select('cadena_id, started_at, finished_at, total_urls, exitosos, fallidos, estado, tipo_trigger')
      .order('started_at', { ascending: false }).limit(400);
    if (!error) setCorridas(data || []);
  }, []);
  useEffect(() => { cargarCorridas(); }, [cargarCorridas]);

  const robot = useRobot({
    onTerminado: async ({ corrida, leidos }) => {
      await cargar(true);
      cargarCorridas();
      addToast(`Robot terminado${corrida.etiqueta ? ` en ${corrida.etiqueta}` : ''}: ${leidos} de ${corrida.total} enlaces leídos.`, 'success');
    },
    onError: (mensaje, { faltaConfig } = {}) => {
      if (faltaConfig) setShowGithubModal(true);
      addToast(mensaje, faltaConfig ? 'info' : 'error');
    },
  });

  // Enlaces por cadena (los enlaces traen el id de la cadena; algunos viejos, el nombre).
  const enlacesDe = useCallback((c) => {
    const claves = new Set([String(c.id).toLowerCase(), String(c.nombre).toLowerCase()]);
    return (enlaces || []).filter(e => claves.has(String(e.cadena || '').toLowerCase()));
  }, [enlaces]);

  const resumen = useMemo(() => {
    const m = new Map();
    for (const c of cadenas || []) {
      const propios = enlacesDe(c);
      const activos = propios.filter(e => e.activo !== false);
      const otraWeb = activos.filter(e => esDeOtraWeb(e.url, c.website));
      const runs = corridas.filter(r => String(r.cadena_id).toLowerCase() === String(c.id).toLowerCase());
      m.set(c.id, { activos, deBaja: propios.length - activos.length, otraWeb, runs, ultima: runs[0] || null });
    }
    return m;
  }, [cadenas, enlacesDe, corridas]);

  const conFallos = (c) => {
    const u = resumen.get(c.id)?.ultima;
    return Boolean(u && (u.fallidos || 0) > 0);
  };

  const filtradas = useMemo(() => {
    const term = normalizar(search);
    return [...(cadenas || [])].filter(c => {
      const r = resumen.get(c.id);
      if (filtroEstado === 'activas' && !c.activo) return false;
      if (filtroEstado === 'baja' && c.activo) return false;
      if (filtroRobot === 'probado' && !lectorDe(c.modulo_scraper).probado) return false;
      if (filtroRobot === 'sin_probar' && lectorDe(c.modulo_scraper).probado) return false;
      if (filtroRevisar === 'otra_web' && !(r?.otraWeb.length > 0)) return false;
      if (filtroRevisar === 'fallos' && !conFallos(c)) return false;
      if (filtroRevisar === 'sin_enlaces' && !(c.activo && r?.activos.length === 0)) return false;
      return !term || normalizar(`${c.nombre} ${c.id} ${c.website} ${siglaCadena(c.id)}`).includes(term);
    }).sort((a, b) => (b.activo ? 1 : 0) - (a.activo ? 1 : 0) || a.nombre.localeCompare(b.nombre));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cadenas, resumen, search, filtroEstado, filtroRobot, filtroRevisar]);
  const hayFiltros = filtroEstado !== 'todos' || filtroRobot !== 'todos' || filtroRevisar !== 'todos';

  const totalOtraWeb = useMemo(() => [...resumen.values()].reduce((n, r) => n + r.otraWeb.length, 0), [resumen]);
  const cadenasConFallos = (cadenas || []).filter(c => c.activo && conFallos(c)).length;
  const activasSinEnlaces = (cadenas || []).filter(c => c.activo && resumen.get(c.id)?.activos.length === 0).length;

  // ------------------------------------------------------------ acciones
  const handleSave = async (data, isNew, original) => {
    const nombre = data.nombre.trim();
    const docId = isNew ? nombre.replace(/\s+/g, '_') : original.id;
    if (!nombre) throw new Error('El nombre es obligatorio.');
    const otra = (cadenas || []).find(c => c.id !== original?.id &&
      (c.id.toLowerCase() === docId.toLowerCase() || c.nombre.toLowerCase() === nombre.toLowerCase()));
    if (otra) throw new Error(`Ya existe la cadena ${otra.nombre}.`);
    const colorEnUso = (cadenas || []).find(c => c.id !== original?.id && data.color_hex &&
      (c.color_hex || '').toUpperCase() === data.color_hex.toUpperCase());
    if (colorEnUso) throw new Error(`Ese color ya lo usa ${colorEnUso.nombre}. Elige otro.`);
    await dbGuardarCadena({
      id: docId, nombre, website: data.website.trim(), modulo_scraper: data.modulo_scraper,
      activo: data.activo, color_hex: data.color_hex, sigla: data.sigla.trim().toUpperCase(),
    }, { nueva: isNew });
    addToast(isNew ? `Cadena ${nombre} creada.` : 'Cambios guardados.', 'success');
    setEditing(null);
    await cargar(true);
  };

  const alternarActivo = async (c) => {
    try {
      await dbCambiarActivoCadena(c.id, !c.activo);
      addToast(c.activo ? `${c.nombre} dada de baja: el robot deja de leerla.` : `${c.nombre} reactivada.`, 'success', c.activo ? {
        accion: { texto: 'Deshacer', onClick: async () => { try { await dbCambiarActivoCadena(c.id, true); await cargar(true); } catch (e) { addToast(e.message, 'error'); } } },
      } : {});
      await cargar(true);
    } catch (err) { addToast(err.message, 'error'); }
  };

  const eliminar = async () => {
    const c = confirmDelete;
    setConfirmDelete(null);
    try {
      await dbEliminarCadena(c.id);
      addToast(`${c.nombre} eliminada.`, 'success');
      setFichaId(null);
      await cargar(true);
    } catch (err) { addToast(err.message, 'error'); }
  };

  const leerCadena = async (c) => {
    const activos = resumen.get(c.id)?.activos || [];
    if (!c.activo) { addToast(`${c.nombre} está de baja: reactívala para leerla.`, 'info'); return; }
    if (activos.length === 0) { addToast(`${c.nombre} no tiene enlaces activos.`, 'info'); return; }
    const ok = await robot.lanzar(activos, activos, c.nombre);
    if (ok) addToast(`Robot lanzado para los ${activos.length} enlaces de ${c.nombre}.`, 'info');
  };

  const verOtraWeb = (c) => navigate(`/competencia?cadena=${encodeURIComponent(c.id)}&revisar=otra_web`);

  const ficha = fichaId ? (cadenas || []).find(c => c.id === fichaId) : null;

  // ---------------------------------------------------------------- celdas
  const celdaLectura = (c) => {
    const u = resumen.get(c.id)?.ultima;
    if (!u) return <><div className="m3-cell-primary">Sin lecturas</div><div className="m3-cell-secondary">el robot aún no la leyó</div></>;
    const fallos = (u.fallidos || 0) > 0;
    return (
      <>
        <div className="m3-cell-primary" title={fechaHora(u.finished_at || u.started_at)}>{haceCuanto(u.finished_at || u.started_at)}</div>
        <div className={`m3-cell-secondary ${fallos ? (u.exitosos ? 'm3-count-stale' : 'text-error') : ''}`}>
          {u.exitosos || 0} de {u.total_urls || 0} bien{fallos ? ` · ${u.fallidos} fallaron` : ''}
        </div>
      </>
    );
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">storefront</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Cadenas</h1>
          </div>
          <p className="text-xs text-on-surface-variant">Las farmacias que vigila el robot: su color, su lector, sus enlaces y cómo le fue en la última lectura.</p>
        </div>
        <button onClick={() => setEditing('new')} className="m3-btn-primary self-start lg:self-auto">
          <span className="material-symbols-outlined text-base">add_business</span>
          <span>Nueva cadena</span>
        </button>
      </div>

      <AvisoRobot robot={robot} />

      {(totalOtraWeb > 0 || cadenasConFallos > 0 || activasSinEnlaces > 0) && filtroRevisar === 'todos' && (
        <div className="m3-banner" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">rule</span>
          <span className="m3-body-medium flex-1 min-w-0">
            <strong>Para revisar:</strong>{' '}
            <span className="m3-banner-links">
              {cadenasConFallos > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('fallos')} className="text-primary font-medium hover:underline">
                  {cadenasConFallos} {cadenasConFallos === 1 ? 'cadena' : 'cadenas'} con fallos en la última lectura
                </button>
              )}
              {totalOtraWeb > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('otra_web')} className="text-primary font-medium hover:underline"
                  title="Enlaces cuya dirección es de otra web que la de su cadena">
                  {totalOtraWeb} {totalOtraWeb === 1 ? 'enlace' : 'enlaces'} de otra web
                </button>
              )}
              {activasSinEnlaces > 0 && (
                <button type="button" onClick={() => setFiltroRevisar('sin_enlaces')} className="text-primary font-medium hover:underline">
                  {activasSinEnlaces} {activasSinEnlaces === 1 ? 'cadena activa' : 'cadenas activas'} sin enlaces
                </button>
              )}
            </span>
          </span>
        </div>
      )}

      <section className="m3-data-table" aria-label="Cadenas">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <label className="m3-search-field">
                <span className="material-symbols-outlined" aria-hidden="true">search</span>
                <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, sigla o web" aria-label="Buscar cadenas" />
                {search && (
                  <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </label>
              <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
                {filtradas.length === (cadenas || []).length ? `${filtradas.length} cadenas` : `${filtradas.length} de ${(cadenas || []).length} cadenas`}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FiltroChip etiqueta="Estado" icono="toggle_on" valor={filtroEstado} onChange={setFiltroEstado}
                opciones={[['todos', 'Estado: todas'], ['activas', 'Activas'], ['baja', 'De baja']]} />
              <FiltroChip etiqueta="Robot" icono="smart_toy" valor={filtroRobot} onChange={setFiltroRobot}
                opciones={[['todos', 'Robot: todos'], ['probado', 'Lector probado'], ['sin_probar', 'Sin probar']]} />
              <FiltroChip etiqueta="Revisar" icono="rule" valor={filtroRevisar} onChange={setFiltroRevisar}
                opciones={[['todos', 'Revisar: todas'], ['fallos', 'Fallos en la última lectura'], ['otra_web', 'Con enlaces de otra web'], ['sin_enlaces', 'Activas sin enlaces']]} />
              <LimpiarFiltros visible={hayFiltros} onClick={() => { setFiltroEstado('todos'); setFiltroRobot('todos'); setFiltroRevisar('todos'); }} />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="p-4 space-y-3" aria-busy="true">
            {[1, 2, 3].map(n => <div key={n} className="h-14 rounded-xl m3-skeleton" />)}
          </div>
        ) : filtradas.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">store</span>
            <div className="m3-title-medium text-on-surface">{(cadenas || []).length ? 'Ninguna cadena coincide' : 'Aún no hay cadenas'}</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Cadenas">
              {filtradas.map(c => {
                const r = resumen.get(c.id);
                return (
                  <li key={c.id} className="m3-product-card">
                    <CadenaBadge cadena={c.id} tamano="md" title="" />
                    <button type="button" onClick={() => setFichaId(c.id)} className="flex-1 min-w-0 text-left">
                      <span className="m3-cell-primary">{c.nombre}</span>
                      <div className="m3-cell-secondary">{r?.activos.length || 0} enlaces · {lectorDe(c.modulo_scraper).probado ? 'lector probado' : 'sin probar'}</div>
                      <div className="mt-1"><span className={`m3-status ${c.activo ? 'is-on' : ''}`}>{c.activo ? 'Activa' : 'De baja'}</span></div>
                    </button>
                    <button type="button" onClick={() => setEditing(c.id)} className="m3-icon-btn" aria-label={`Editar ${c.nombre}`}>
                      <span className="material-symbols-outlined">edit</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="hidden md:block overflow-x-auto">
              <table className="m3-table m3-table-productos m3-table-cadenas">
                <colgroup>
                  <col />
                  <col className="w-[150px]" />
                  <col className="w-[150px]" />
                  <col className="w-[170px]" />
                  <col className="w-[104px]" />
                  <col className="w-[180px]" />
                </colgroup>
                <thead className="m3-sticky-header">
                  <tr>
                    <th>Cadena</th>
                    <th>Robot</th>
                    <th>Enlaces</th>
                    <th>Última lectura</th>
                    <th>Estado</th>
                    <th className="m3-sticky-actions"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtradas.map(c => {
                    const r = resumen.get(c.id);
                    const lector = lectorDe(c.modulo_scraper);
                    const leyendo = Boolean(robot.corrida?.etiqueta === c.nombre);
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="flex items-center gap-3 min-w-0">
                            <CadenaBadge cadena={c.id} tamano="md" title="" />
                            <div className="min-w-0">
                              <button type="button" onClick={() => setFichaId(c.id)} className="m3-cell-link min-w-0" title="Abrir la ficha de la cadena">
                                <span className="m3-cell-primary">{c.nombre}</span>
                              </button>
                              <div className="m3-cell-secondary">
                                {c.website ? (
                                  <a href={c.website} target="_blank" rel="noopener noreferrer" className="hover:underline">{dominio(c.website)}</a>
                                ) : 'sin web'}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className={`m3-cell-primary ${lector.probado ? '' : 'm3-count-stale'}`}
                            title={lector.probado ? 'El robot tiene reglas propias para esta tienda' : 'El robot la intenta con el lector genérico: puede fallar'}>
                            {lector.probado ? 'Lector probado' : 'Sin probar'}
                          </div>
                          <div className="m3-cell-secondary">{lector.label}</div>
                        </td>
                        <td>
                          <div className="m3-cell-primary">{r?.activos.length || 0} activos</div>
                          <div className="m3-cell-secondary">
                            {r?.otraWeb.length ? (
                              <button type="button" onClick={() => verOtraWeb(c)} className="m3-count-stale hover:underline"
                                title="Ver en Competencia los enlaces de otra web">
                                {r.otraWeb.length} de otra web
                              </button>
                            ) : r?.deBaja ? `${r.deBaja} de baja` : '—'}
                          </div>
                        </td>
                        <td>{leyendo ? <div className="m3-cell-primary text-primary font-medium">Leyendo…</div> : celdaLectura(c)}</td>
                        <td><span className={`m3-status ${c.activo ? 'is-on' : ''}`}>{c.activo ? 'Activa' : 'De baja'}</span></td>
                        <td className="m3-sticky-actions">
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => leerCadena(c)} disabled={Boolean(robot.corrida) || !c.activo} className="m3-icon-btn"
                              title={robot.corrida ? 'Ya hay una lectura en curso' : `Leer ahora los enlaces de ${c.nombre}`} aria-label={`Leer ${c.nombre}`}>
                              <span className={`material-symbols-outlined ${leyendo ? 'animate-spin' : ''}`}>{leyendo ? 'sync' : 'smart_toy'}</span>
                            </button>
                            <button type="button" onClick={() => setEditing(c.id)} className="m3-icon-btn" title="Editar" aria-label={`Editar ${c.nombre}`}>
                              <span className="material-symbols-outlined">edit</span>
                            </button>
                            <button type="button" onClick={() => alternarActivo(c)} className="m3-icon-btn"
                              title={c.activo ? 'Dar de baja: el robot deja de leerla' : 'Reactivar'} aria-label={`${c.activo ? 'Dar de baja' : 'Reactivar'} ${c.nombre}`}>
                              <span className="material-symbols-outlined">{c.activo ? 'archive' : 'unarchive'}</span>
                            </button>
                            <button type="button" onClick={() => setConfirmDelete(c)} className="m3-icon-btn m3-icon-btn-danger" title="Eliminar" aria-label={`Eliminar ${c.nombre}`}>
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
      </section>

      {ficha && (
        <FichaCadena
          cadena={ficha}
          resumen={resumen.get(ficha.id)}
          robotOcupado={Boolean(robot.corrida)}
          onClose={() => setFichaId(null)}
          onEditar={() => { setFichaId(null); setEditing(ficha.id); }}
          onLeer={() => leerCadena(ficha)}
          onVerOtraWeb={() => verOtraWeb(ficha)}
        />
      )}

      {editing && (
        <CadenaModal
          cadena={editing === 'new' ? null : (cadenas || []).find(c => c.id === editing)}
          cadenas={cadenas || []}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar cadena?"
        message={confirmDelete
          ? (resumen.get(confirmDelete.id)?.activos.length || 0) + (resumen.get(confirmDelete.id)?.deBaja || 0) > 0
            ? `${confirmDelete.nombre} tiene enlaces: no se puede eliminar sin perder su historial de precios. Dala de baja (el robot deja de leerla y se conserva todo).`
            : `Se eliminará ${confirmDelete.nombre}. No tiene enlaces.`
          : ''}
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger
        onConfirm={eliminar}
        onCancel={() => setConfirmDelete(null)}
      />

      <GitHubConfigModal isOpen={showGithubModal} onClose={() => setShowGithubModal(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ficha lateral: lecturas del robot y enlaces de otra web.
// ---------------------------------------------------------------------------
function FichaCadena({ cadena: c, resumen: r, robotOcupado, onClose, onEditar, onLeer, onVerOtraWeb }) {
  useEffect(() => {
    const alPulsar = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onClose]);
  const lector = lectorDe(c.modulo_scraper);
  const u = r?.ultima;

  return createPortal(
    <div className="m3-modal-scrim m3-sheet-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <aside className="m3-side-sheet" role="dialog" aria-modal="true" aria-labelledby="ficha-cadena-titulo">
        <header className="flex items-start gap-3 px-6 pt-6 pb-4">
          <CadenaBadge cadena={c.id} tamano="lg" title="" />
          <div className="min-w-0 flex-1">
            <h2 id="ficha-cadena-titulo" className="m3-headline-small text-on-surface break-words">{c.nombre}</h2>
            <div className="m3-body-medium text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2">
              {c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer" className="hover:underline">{dominio(c.website)}</a> : <span>sin web</span>}
              <span aria-hidden="true">·</span>
              <span className={`m3-status ${c.activo ? 'is-on' : ''}`}>{c.activo ? 'Activa' : 'De baja'}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="m3-icon-btn" aria-label="Cerrar ficha">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
          <section>
            <div className="grid grid-cols-3 gap-2">
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Enlaces activos</span>
                <span className="m3-title-large text-on-surface">{r?.activos.length || 0}</span>
                {r?.deBaja ? <span className="m3-body-small text-on-surface-variant">{r.deBaja} de baja</span> : null}
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Última lectura</span>
                <span className="m3-title-large text-on-surface">{u ? `${u.exitosos || 0}/${u.total_urls || 0}` : '—'}</span>
                <span className="m3-body-small text-on-surface-variant">{u ? haceCuanto(u.finished_at || u.started_at) : 'nunca'}</span>
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Lector</span>
                <span className={`m3-title-medium ${lector.probado ? 'text-on-surface' : 'm3-count-stale'}`}>{lector.probado ? 'Probado' : 'Sin probar'}</span>
                <span className="m3-body-small text-on-surface-variant truncate">{lector.label}</span>
              </div>
            </div>
            {!lector.probado && (
              <p className="m3-body-small text-on-surface-variant mt-2">
                El robot no tiene reglas propias para esta tienda: la lee con el lector genérico, que busca el precio en la página y puede fallar.
              </p>
            )}
          </section>

          {r?.otraWeb.length > 0 && (
            <section>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="m3-title-small text-on-surface-variant">Enlaces de otra web ({r.otraWeb.length})</h3>
                <button type="button" onClick={onVerOtraWeb} className="m3-btn-text">Ver en Competencia</button>
              </div>
              <ul className="space-y-1">
                {r.otraWeb.slice(0, 8).map(e => (
                  <li key={e.id} className="m3-ficha-enlace">
                    <div className="min-w-0 flex-1">
                      <div className="m3-cell-primary">{e.marca || e.id_producto_propio}</div>
                      <div className="m3-cell-secondary m3-count-stale">{dominio(e.url)} (esperado {dominio(c.website)})</div>
                    </div>
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" aria-label="Abrir la URL">
                      <span className="material-symbols-outlined">open_in_new</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="m3-title-small text-on-surface-variant mb-2">Últimas lecturas del robot</h3>
            {!r?.runs.length ? (
              <p className="m3-body-medium text-on-surface-variant">El robot todavía no leyó esta cadena.</p>
            ) : (
              <ul className="divide-y divide-outline-variant">
                {r.runs.slice(0, 10).map((run, i) => {
                  const fallos = (run.fallidos || 0) > 0;
                  return (
                    <li key={i} className="flex items-center gap-3 py-2 m3-body-medium">
                      <span className={`material-symbols-outlined ${fallos ? (run.exitosos ? 'm3-count-stale' : 'text-error') : 'text-primary'}`} aria-hidden="true">
                        {fallos ? (run.exitosos ? 'error' : 'cancel') : 'check_circle'}
                      </span>
                      <span className="flex-1">{run.exitosos || 0} de {run.total_urls || 0} bien{fallos ? ` · ${run.fallidos} fallaron` : ''}</span>
                      <span className="text-on-surface-variant tabular-nums">{fechaHora(run.finished_at || run.started_at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-outline-variant">
          <button type="button" onClick={onLeer} disabled={robotOcupado || !c.activo} className="m3-btn-tonal mr-auto">
            <span className="material-symbols-outlined">smart_toy</span>
            Leer esta cadena
          </button>
          <button type="button" onClick={onEditar} className="m3-btn-primary h-10">
            <span className="material-symbols-outlined text-base">edit</span>
            Editar
          </button>
        </footer>
      </aside>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Formulario: misma estructura que los demas.
// ---------------------------------------------------------------------------
function CadenaModal({ cadena, cadenas, onSave, onClose }) {
  const isNew = !cadena;
  // Colores que ya usan las demas cadenas: no se pueden repetir.
  const usados = new Map(cadenas.filter(c => c.id !== cadena?.id && c.color_hex).map(c => [c.color_hex.toUpperCase(), c.nombre]));
  const primeroLibre = PALETA_CADENAS.find(col => !usados.has(col)) || '';
  const [form, setForm] = useState({
    nombre: cadena?.nombre || '',
    sigla: cadena?.sigla || '',
    website: cadena?.website || '',
    modulo_scraper: cadena?.modulo_scraper || 'generico',
    activo: cadena?.activo ?? true,
    color_hex: (cadena?.color_hex || (isNew ? primeroLibre : '')).toUpperCase(),
  });
  const [errores, setErrores] = useState({});
  const [errorGeneral, setErrorGeneral] = useState(null);
  const [saving, setSaving] = useState(false);
  const cambiar = (k, v) => { setErrorGeneral(null); setErrores(e => ({ ...e, [k]: undefined })); setForm(f => ({ ...f, [k]: v })); };
  const siglaVista = (form.sigla.trim() || siglaCadena(form.nombre || 'Cadena')).toUpperCase();
  const siglaRepetida = form.sigla.trim() && cadenas.find(c => c.id !== cadena?.id && (c.sigla || '').toUpperCase() === form.sigla.trim().toUpperCase());

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = {};
    if (!form.nombre.trim()) err.nombre = 'Obligatorio';
    if (form.website.trim() && !dominio(form.website)) err.website = 'Escribe una dirección válida';
    setErrores(err);
    if (Object.keys(err).length) return;
    setSaving(true);
    try { await onSave({ ...form, sigla: form.sigla.trim() || siglaVista }, isNew, cadena); } catch (ex) { setErrorGeneral(ex.message); }
    setSaving(false);
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={isNew ? 'Nueva cadena' : 'Editar cadena'}
      subtitle={isNew ? 'Los campos con * son obligatorios.' : cadena.nombre}
      icon={isNew ? 'add_business' : 'edit'}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 w-full">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" checked={form.activo} onChange={e => cambiar('activo', e.target.checked)} className="m3-switch" />
            <span>{form.activo ? 'Activa: el robot la lee' : 'De baja'}</span>
          </label>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
            <button type="submit" form="cadena-form" disabled={saving} className="m3-btn-primary h-10 px-6">
              {saving ? 'Guardando…' : isNew ? 'Crear cadena' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      }
    >
      <form id="cadena-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {errorGeneral && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{errorGeneral}</span>
          </div>
        )}

        <FormSection titulo="Datos" icono="storefront">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-4">
            <Field label="Nombre" requerido error={errores.nombre} hint="Como se muestra en todo el panel.">
              <input type="text" value={form.nombre} onChange={e => cambiar('nombre', e.target.value)} className="m3-input" placeholder="Ej. Farmatodo" />
            </Field>
            <Field label="Sigla" hint={form.sigla.trim() ? undefined : `Vacía: ${siglaVista}`}
              aviso={siglaRepetida ? `También la usa ${siglaRepetida.nombre}` : null}>
              <input type="text" value={form.sigla} maxLength={4} onChange={e => cambiar('sigla', e.target.value.toUpperCase().replace(/[^A-Z0-9ÁÉÍÓÚÑ]/g, ''))}
                className="m3-input uppercase" placeholder={siglaVista} />
            </Field>
          </div>
          <Field label="Web" error={errores.website} hint="La página de la tienda. Sirve para avisar de enlaces de otra web.">
            <input type="url" value={form.website} onChange={e => cambiar('website', e.target.value)} className="m3-input" placeholder="https://www.ejemplo.com.ve" />
          </Field>
        </FormSection>

        <FormSection titulo="Robot" icono="smart_toy">
          <Field label="Lector" hint={lectorDe(form.modulo_scraper).probado
            ? 'El robot tiene reglas propias para esta tienda.'
            : 'Sin reglas propias: el robot la intenta con el lector genérico y puede fallar.'}>
            <Select value={form.modulo_scraper} onChange={e => cambiar('modulo_scraper', e.target.value)} className="m3-select w-full">
              {LECTORES.map(l => <option key={l.value} value={l.value}>{`${l.label} · ${l.probado ? 'probado' : 'sin probar'}`}</option>)}
            </Select>
          </Field>
        </FormSection>

        <FormSection titulo="Color e insignia" icono="palette">
          <Field label="Color de la cadena" hint="Único por cadena: se usa en todos los gráficos, tarjetas y leyendas del panel."
            aviso={form.color_hex && usados.has(form.color_hex) ? `Ya lo usa ${usados.get(form.color_hex)}.` : null}>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color de la cadena">
              {PALETA_CADENAS.map(col => {
                const ocupadoPor = usados.get(col);
                const elegido = form.color_hex === col;
                return (
                  <button key={col} type="button" role="radio" aria-checked={elegido} disabled={Boolean(ocupadoPor)}
                    onClick={() => cambiar('color_hex', col)} title={ocupadoPor ? `${col} · lo usa ${ocupadoPor}` : col}
                    className={`m3-swatch ${elegido ? 'is-selected' : ''}`} style={{ backgroundColor: col }}>
                    {elegido && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
                    {ocupadoPor && <span className="material-symbols-outlined" aria-hidden="true">block</span>}
                  </button>
                );
              })}
              <label className="m3-swatch m3-swatch-libre" title="Otro color">
                <input type="color" value={/^#[0-9A-F]{6}$/i.test(form.color_hex) ? form.color_hex : '#475569'}
                  onChange={e => cambiar('color_hex', e.target.value.toUpperCase())} aria-label="Elegir otro color" />
                <span className="material-symbols-outlined" aria-hidden="true">colorize</span>
              </label>
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-3 m3-body-medium">
            <span className="m3-label-medium text-on-surface-variant">Vista previa</span>
            <span className="m3-cadena-badge is-md" style={{ backgroundColor: form.color_hex || '#475569' }}>{siglaVista}</span>
            <span className="inline-flex items-center gap-2 px-3 h-8 rounded-full border border-outline-variant">
              <span className="m3-cadena-badge is-xs" style={{ backgroundColor: form.color_hex || '#475569' }}>{siglaVista}</span>
              {form.nombre || 'Cadena'}
            </span>
            <span className="h-3 w-16 rounded-full" style={{ backgroundColor: form.color_hex || '#475569' }} aria-hidden="true" />
          </div>
        </FormSection>
      </form>
    </ModalWrapper>
  );
}
