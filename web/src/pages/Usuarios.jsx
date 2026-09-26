import LimpiarFiltros from '../components/LimpiarFiltros';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, isSupabaseActive } from '../supabase';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import GitHubConfigModal from '../components/GitHubConfigModal';
import FiltroChip from '../components/FiltroChip';
import { FormSection, Field, ChoiceChips, normalizar } from '../components/formulario';
import { getGitHubConfig } from '../utils/githubClient';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { dbGuardarUsuario, dbCambiarActivoUsuario, dbEliminarUsuarioCompleto, dbAccesos } from '../utils/dbClient';
import { urlDelPanel } from '../utils/accesos';
import {
  AVAILABLE_MENUS, DEFAULT_CONSULTA_MENUS, esUsuarioActivo, etiquetaEvento, fechaHora, haceCuanto,
} from '../utils/usuarios';

// Se reexportan para quien los importaba de aqui.
export { AVAILABLE_MENUS, DEFAULT_CONSULTA_MENUS };

const ROLES = [
  ['consulta', 'Consulta'],
  ['administrador', 'Administrador'],
];
const esAdminU = (u) => u?.rol === 'administrador';
const menusDe = (u) => (esAdminU(u)
  ? AVAILABLE_MENUS.map(m => m.id)
  : (Array.isArray(u?.menus_permitidos) && u.menus_permitidos.length > 0 ? u.menus_permitidos : DEFAULT_CONSULTA_MENUS));

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

// Contraseña inicial facil de dictar: 3 palabras cortas y 2 numeros.
function generarClave() {
  const silabas = ['ma', 'lo', 'ti', 'ra', 'se', 'no', 'pa', 'vi', 'ce', 'du', 'ga', 'fe'];
  const azar = (n) => Math.floor(Math.random() * n);
  const palabra = () => Array.from({ length: 3 }, () => silabas[azar(silabas.length)]).join('');
  return `${palabra()}-${palabra()}-${10 + azar(90)}`;
}

export default function Usuarios({ userDoc }) {
  const { usuarios, loadingInitial: loading, refreshUsuarios: cargar } = useData();
  const { addToast } = useToast();

  const [editing, setEditing] = useState(null);
  const [fichaId, setFichaId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [githubInfo, setGithubInfo] = useState(null);
  const [accesos, setAccesos] = useState([]);

  const [search, setSearch] = useState('');
  const [filtroRol, setFiltroRol] = useState('todos');
  const [filtroEstado, setFiltroEstado] = useState('todos');
  const [filtroCorreos, setFiltroCorreos] = useState('todos');
  const menuMasRef = useRef(null);
  const buscadorRef = useRef(null);

  useEffect(() => {
    getGitHubConfig().then(cfg => setGithubInfo(cfg?.token ? cfg : null));
    dbAccesos().then(setAccesos);
  }, []);

  // Ultimo ingreso de cada correo.
  const ultimoIngreso = useMemo(() => {
    const m = new Map();
    for (const a of accesos) {
      if (a.evento !== 'ingreso') continue;
      const k = String(a.email).toLowerCase();
      if (!m.has(k)) m.set(k, a.fecha);
    }
    return m;
  }, [accesos]);

  const filtrados = useMemo(() => {
    const term = normalizar(search);
    return [...(usuarios || [])]
      .filter(u => {
        if (filtroRol === 'administrador' && !esAdminU(u)) return false;
        if (filtroRol === 'consulta' && esAdminU(u)) return false;
        if (filtroEstado === 'activos' && !esUsuarioActivo(u)) return false;
        if (filtroEstado === 'inactivos' && esUsuarioActivo(u)) return false;
        if (filtroCorreos === 'alertas' && !u.recibe_alertas_inmediatas) return false;
        if (filtroCorreos === 'resumen' && !u.recibe_resumen_diario) return false;
        if (filtroCorreos === 'ninguno' && (u.recibe_alertas_inmediatas || u.recibe_resumen_diario)) return false;
        return !term || normalizar(`${u.nombre} ${u.email}`).includes(term);
      })
      .sort((a, b) => (esAdminU(b) ? 1 : 0) - (esAdminU(a) ? 1 : 0) || (a.nombre || '').localeCompare(b.nombre || ''));
  }, [usuarios, search, filtroRol, filtroEstado, filtroCorreos]);
  const hayFiltros = filtroRol !== 'todos' || filtroEstado !== 'todos' || filtroCorreos !== 'todos';

  // ------------------------------------------------------------ acciones
  const handleSave = async (data, isNew) => {
    const email = data.email.trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(email)) throw new Error('El correo no es válido.');
    const rol = data.rol === 'administrador' ? 'administrador' : 'consulta';
    const menus = rol === 'administrador' ? AVAILABLE_MENUS.map(m => m.id)
      : (data.menus_permitidos?.length ? data.menus_permitidos : DEFAULT_CONSULTA_MENUS);

    if (isNew) {
      if ((usuarios || []).some(u => u.email?.toLowerCase() === email)) throw new Error('Ya existe un usuario con ese correo.');
      if (!data.password || data.password.length < 8) throw new Error('La contraseña inicial debe tener al menos 8 caracteres.');
      // La cuenta de acceso se crea en el servidor (Edge Function con la
      // service role): el panel no puede crearla.
      const { data: fnData, error: fnError } = await supabase.functions.invoke('crear-usuario', {
        body: {
          email, password: data.password, nombre: data.nombre.trim(), rol, menus_permitidos: menus,
          recibe_alertas_inmediatas: data.recibe_alertas_inmediatas, recibe_resumen_diario: data.recibe_resumen_diario,
          activo: data.activo,
        },
      });
      if (fnError) throw new Error(fnError.message || 'No se pudo comunicar con la función crear-usuario.');
      if (fnData?.error) throw new Error(fnData.error);
      addToast(`Usuario ${email} creado. Pásale su contraseña inicial: podrá cambiarla en "Mi cuenta".`, 'success');
    } else {
      const original = usuarios.find(u => u.id === editing);
      if (original?.email === userDoc?.email && (rol !== 'administrador' || !data.activo)) {
        throw new Error('No puedes quitarte a ti mismo el rol de administrador ni desactivarte.');
      }
      await dbGuardarUsuario({
        id: original?.id || emailToDocId(email),
        nombre: data.nombre.trim(),
        rol,
        menus_permitidos: menus,
        recibe_alertas_inmediatas: data.recibe_alertas_inmediatas,
        recibe_resumen_diario: data.recibe_resumen_diario,
        activo: data.activo,
      });
      addToast('Cambios guardados.', 'success');
    }
    setEditing(null);
    await cargar(true);
  };

  const enviarEnlaceClave = async (u) => {
    if (!isSupabaseActive()) return;
    const { error } = await supabase.auth.resetPasswordForEmail(u.email, { redirectTo: urlDelPanel() });
    if (error) addToast(`No se pudo enviar el correo: ${error.message}`, 'error');
    else addToast(`Correo enviado a ${u.email} con el enlace para crear una contraseña nueva.`, 'success');
  };

  const alternarActivo = async (u) => {
    if (u.email === userDoc?.email) { addToast('No puedes desactivar tu propio usuario.', 'error'); return; }
    const activar = !esUsuarioActivo(u);
    try {
      await dbCambiarActivoUsuario(u.id, activar);
      addToast(activar ? `${u.nombre} puede volver a entrar.` : `${u.nombre} ya no puede entrar ni ver datos.`, 'success', activar ? {} : {
        accion: { texto: 'Deshacer', onClick: async () => { try { await dbCambiarActivoUsuario(u.id, true); await cargar(true); } catch (e) { addToast(e.message, 'error'); } } },
      });
      await cargar(true);
    } catch (err) { addToast(err.message, 'error'); }
  };

  const eliminar = async () => {
    const u = confirmDelete;
    setConfirmDelete(null);
    try {
      await dbEliminarUsuarioCompleto(u.email);
      addToast(`${u.nombre || u.email} eliminado, también su cuenta de acceso.`, 'success');
      setFichaId(null);
      await cargar(true);
    } catch (err) { addToast(err.message, 'error'); }
  };

  const ficha = fichaId ? (usuarios || []).find(u => u.id === fichaId) : null;

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">group</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Usuarios y accesos</h1>
          </div>
          <p className="text-xs text-on-surface-variant">Quién entra al panel, qué menús ve y qué correos recibe.</p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <button onClick={() => setEditing('new')} className="m3-btn-primary">
            <span className="material-symbols-outlined text-base">person_add</span>
            <span>Nuevo usuario</span>
          </button>
          <details ref={menuMasRef} className="m3-menu">
            <summary className="m3-icon-btn" title="Más acciones" aria-label="Más acciones">
              <span className="material-symbols-outlined">more_vert</span>
            </summary>
            <div className="m3-menu-panel" role="menu">
              <button type="button" role="menuitem" className="m3-menu-item"
                onClick={() => { menuMasRef.current?.removeAttribute('open'); setShowGithubModal(true); }}>
                <span className="material-symbols-outlined">smart_toy</span>
                {githubInfo ? 'Token del robot (GitHub)' : 'Configurar el robot (GitHub)'}
              </button>
            </div>
          </details>
        </div>
      </div>

      <section className="m3-data-table" aria-label="Usuarios">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <label className="m3-search-field">
                <span className="material-symbols-outlined" aria-hidden="true">search</span>
                <input ref={buscadorRef} type="search" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por nombre o correo" aria-label="Buscar usuarios" />
                {search && (
                  <button type="button" onClick={() => setSearch('')} className="m3-icon-btn m3-icon-btn-sm" aria-label="Borrar búsqueda">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </label>
              <div className="m3-label-large text-on-surface-variant whitespace-nowrap md:ml-auto" aria-live="polite">
                {filtrados.length === (usuarios || []).length ? `${filtrados.length} usuarios` : `${filtrados.length} de ${(usuarios || []).length} usuarios`}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FiltroChip etiqueta="Rol" icono="badge" valor={filtroRol} onChange={setFiltroRol}
                opciones={[['todos', 'Rol: todos'], ['administrador', 'Administradores'], ['consulta', 'Consulta']]} />
              <FiltroChip etiqueta="Estado" icono="toggle_on" valor={filtroEstado} onChange={setFiltroEstado}
                opciones={[['todos', 'Estado: todos'], ['activos', 'Activos'], ['inactivos', 'Inactivos']]} />
              <FiltroChip etiqueta="Correos" icono="mail" valor={filtroCorreos} onChange={setFiltroCorreos}
                opciones={[['todos', 'Correos: todos'], ['alertas', 'Reciben alertas'], ['resumen', 'Reciben resumen'], ['ninguno', 'No reciben correos']]} />
              <LimpiarFiltros visible={hayFiltros} onClick={() => { setFiltroRol('todos'); setFiltroEstado('todos'); setFiltroCorreos('todos'); }} />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="p-4 space-y-3" aria-busy="true">
            {[1, 2, 3].map(n => <div key={n} className="h-14 rounded-xl m3-skeleton" />)}
          </div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">person_search</span>
            <div className="m3-title-medium text-on-surface">No hay usuarios que coincidan</div>
          </div>
        ) : (
          <>
            <ul className="md:hidden divide-y divide-outline-variant" aria-label="Usuarios">
              {filtrados.map(u => (
                <li key={u.id} className="m3-product-card">
                  <button type="button" onClick={() => setFichaId(u.id)} className="flex-1 min-w-0 text-left">
                    <span className="m3-cell-primary">{u.nombre || u.email}</span>
                    <div className="m3-cell-secondary">{u.email}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 m3-body-small">
                      <span>{esAdminU(u) ? 'Administrador' : 'Consulta'}</span>
                      <span className={`m3-status ${esUsuarioActivo(u) ? 'is-on' : ''}`}>{esUsuarioActivo(u) ? 'Activo' : 'Inactivo'}</span>
                    </div>
                  </button>
                  <button type="button" onClick={() => setEditing(u.id)} className="m3-icon-btn" aria-label={`Editar ${u.nombre}`}>
                    <span className="material-symbols-outlined">edit</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-x-auto">
              <table className="m3-table m3-table-productos m3-table-usuarios">
                <colgroup>
                  <col />
                  <col className="w-[22%]" />
                  <col className="w-[104px]" />
                  <col className="w-[136px]" />
                  <col className="w-[104px]" />
                  <col className="w-[180px]" />
                </colgroup>
                <thead className="m3-sticky-header">
                  <tr>
                    <th>Usuario</th>
                    <th>Rol</th>
                    <th className="text-center">Correos</th>
                    <th>Último acceso</th>
                    <th>Estado</th>
                    <th className="m3-sticky-actions"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map(u => {
                    const yo = u.email === userDoc?.email;
                    const menus = menusDe(u);
                    return (
                      <tr key={u.id}>
                        <td>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <button type="button" onClick={() => setFichaId(u.id)} className="m3-cell-link min-w-0" title="Abrir la ficha del usuario">
                              <span className="m3-cell-primary">{u.nombre || u.email}</span>
                            </button>
                            {yo && <span className="m3-chip-propio shrink-0">Tú</span>}
                          </div>
                          <div className="m3-cell-secondary">{u.email}</div>
                        </td>
                        <td>
                          <div className="m3-cell-primary">{esAdminU(u) ? 'Administrador' : 'Consulta'}</div>
                          <div className="m3-cell-secondary" title={AVAILABLE_MENUS.filter(m => menus.includes(m.id)).map(m => m.label).join(', ')}>
                            {esAdminU(u) ? 'Todos los menús' : `${menus.length} ${menus.length === 1 ? 'menú' : 'menús'}: ${AVAILABLE_MENUS.filter(m => menus.includes(m.id)).map(m => m.label).join(', ')}`}
                          </div>
                        </td>
                        <td className="text-center">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`material-symbols-outlined text-[20px] ${u.recibe_alertas_inmediatas ? 'text-primary' : 'text-outline-variant'}`}
                              title={u.recibe_alertas_inmediatas ? 'Recibe alertas inmediatas' : 'No recibe alertas'}>notifications_active</span>
                            <span className={`material-symbols-outlined text-[20px] ${u.recibe_resumen_diario ? 'text-primary' : 'text-outline-variant'}`}
                              title={u.recibe_resumen_diario ? 'Recibe el resumen diario' : 'No recibe el resumen'}>summarize</span>
                          </span>
                        </td>
                        <td>
                          <div className="m3-cell-primary">{haceCuanto(ultimoIngreso.get(String(u.email).toLowerCase()))}</div>
                        </td>
                        <td><span className={`m3-status ${esUsuarioActivo(u) ? 'is-on' : ''}`}>{esUsuarioActivo(u) ? 'Activo' : 'Inactivo'}</span></td>
                        <td className="m3-sticky-actions">
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => setEditing(u.id)} className="m3-icon-btn" title="Editar" aria-label={`Editar ${u.nombre}`}>
                              <span className="material-symbols-outlined">edit</span>
                            </button>
                            <button type="button" onClick={() => enviarEnlaceClave(u)} className="m3-icon-btn"
                              title="Enviarle un correo para crear una contraseña nueva" aria-label={`Enviar enlace de contraseña a ${u.nombre}`}>
                              <span className="material-symbols-outlined">lock_reset</span>
                            </button>
                            <button type="button" onClick={() => alternarActivo(u)} disabled={yo} className="m3-icon-btn"
                              title={esUsuarioActivo(u) ? 'Desactivar: ya no podrá entrar' : 'Reactivar'} aria-label={`${esUsuarioActivo(u) ? 'Desactivar' : 'Reactivar'} ${u.nombre}`}>
                              <span className="material-symbols-outlined">{esUsuarioActivo(u) ? 'person_off' : 'person_check'}</span>
                            </button>
                            <button type="button" onClick={() => setConfirmDelete(u)} disabled={yo} className="m3-icon-btn m3-icon-btn-danger"
                              title="Eliminar" aria-label={`Eliminar ${u.nombre}`}>
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
        <FichaUsuario
          usuario={ficha}
          yo={ficha.email === userDoc?.email}
          accesos={accesos.filter(a => String(a.email).toLowerCase() === String(ficha.email).toLowerCase())}
          onClose={() => setFichaId(null)}
          onEditar={() => { setFichaId(null); setEditing(ficha.id); }}
          onClave={() => enviarEnlaceClave(ficha)}
          onAlternarActivo={() => alternarActivo(ficha)}
        />
      )}

      {editing && (
        <UsuarioModal
          usuario={editing === 'new' ? null : (usuarios || []).find(u => u.id === editing)}
          yo={editing !== 'new' && (usuarios || []).find(u => u.id === editing)?.email === userDoc?.email}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar usuario?"
        message={confirmDelete
          ? `Se eliminará a ${confirmDelete.nombre || ''} (${confirmDelete.email}) y también su cuenta de acceso: ya no podrá entrar y para volver habría que crearlo de nuevo.\n\nSi solo quieres bloquearlo por un tiempo, desactívalo.`
          : ''}
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger
        onConfirm={eliminar}
        onCancel={() => setConfirmDelete(null)}
      />

      <GitHubConfigModal isOpen={showGithubModal} onClose={() => setShowGithubModal(false)} onSaveSuccess={setGithubInfo} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ficha lateral: datos, menus, correos y ultimos accesos.
// ---------------------------------------------------------------------------
function FichaUsuario({ usuario: u, yo, accesos, onClose, onEditar, onClave, onAlternarActivo }) {
  useEffect(() => {
    const alPulsar = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onClose]);
  const menus = menusDe(u);
  const activo = esUsuarioActivo(u);

  return createPortal(
    <div className="m3-modal-scrim m3-sheet-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <aside className="m3-side-sheet" role="dialog" aria-modal="true" aria-labelledby="ficha-usuario-titulo">
        <header className="flex items-start gap-3 px-6 pt-6 pb-4">
          <div className="w-12 h-12 rounded-full bg-primary text-on-primary flex items-center justify-center font-display font-bold text-lg shrink-0">
            {(u.nombre || u.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="ficha-usuario-titulo" className="m3-headline-small text-on-surface break-words">{u.nombre || u.email}</h2>
            <div className="m3-body-medium text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2">
              <span>{u.email}</span>
              <span aria-hidden="true">·</span>
              <span className={`m3-status ${activo ? 'is-on' : ''}`}>{activo ? 'Activo' : 'Inactivo'}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="m3-icon-btn" aria-label="Cerrar ficha">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
          <section>
            <h3 className="m3-title-small text-on-surface-variant mb-2">{esAdminU(u) ? 'Administrador · ve y cambia todo' : 'Consulta · puede ver'}</h3>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_MENUS.filter(m => menus.includes(m.id)).map(m => (
                <span key={m.id} className="m3-chip-menu"><span className="material-symbols-outlined" aria-hidden="true">{m.icon}</span>{m.label}</span>
              ))}
              {esAdminU(u) && <span className="m3-chip-menu"><span className="material-symbols-outlined" aria-hidden="true">group</span>Usuarios</span>}
            </div>
          </section>

          <section>
            <h3 className="m3-title-small text-on-surface-variant mb-2">Correos</h3>
            <ul className="space-y-1 m3-body-medium">
              <li className="flex items-center gap-2">
                <span className={`material-symbols-outlined ${u.recibe_alertas_inmediatas ? 'text-primary' : 'text-outline-variant'}`}>notifications_active</span>
                {u.recibe_alertas_inmediatas ? 'Recibe alertas inmediatas' : 'No recibe alertas inmediatas'}
              </li>
              <li className="flex items-center gap-2">
                <span className={`material-symbols-outlined ${u.recibe_resumen_diario ? 'text-primary' : 'text-outline-variant'}`}>summarize</span>
                {u.recibe_resumen_diario ? 'Recibe el resumen diario' : 'No recibe el resumen diario'}
              </li>
            </ul>
          </section>

          <section>
            <h3 className="m3-title-small text-on-surface-variant mb-2">Últimos accesos</h3>
            {accesos.length === 0 ? (
              <p className="m3-body-medium text-on-surface-variant">Sin accesos registrados todavía.</p>
            ) : (
              <ul className="divide-y divide-outline-variant">
                {accesos.slice(0, 20).map((a, i) => (
                  <li key={i} className="flex items-center gap-3 py-2 m3-body-medium">
                    <span className="material-symbols-outlined text-on-surface-variant" aria-hidden="true">{etiquetaEvento(a.evento).icono}</span>
                    <span className="flex-1">{etiquetaEvento(a.evento).texto}</span>
                    <span className="text-on-surface-variant tabular-nums">{fechaHora(a.fecha)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-outline-variant">
          {!yo && (
            <button type="button" onClick={onAlternarActivo} className="m3-btn-text mr-auto">
              <span className="material-symbols-outlined">{activo ? 'person_off' : 'person_check'}</span>
              {activo ? 'Desactivar' : 'Reactivar'}
            </button>
          )}
          <button type="button" onClick={onClave} className="m3-btn-tonal" title="Enviarle un correo para crear una contraseña nueva">
            <span className="material-symbols-outlined">lock_reset</span>
            Enviar enlace
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
// Formulario: misma estructura que el de producto.
// ---------------------------------------------------------------------------
function UsuarioModal({ usuario, yo, onSave, onClose }) {
  const isNew = !usuario;
  const [form, setForm] = useState({
    email: usuario?.email || '',
    nombre: usuario?.nombre || '',
    password: isNew ? generarClave() : '',
    rol: usuario?.rol === 'administrador' ? 'administrador' : 'consulta',
    menus_permitidos: Array.isArray(usuario?.menus_permitidos) && usuario.menus_permitidos.length > 0
      ? usuario.menus_permitidos : [...DEFAULT_CONSULTA_MENUS],
    recibe_alertas_inmediatas: usuario?.recibe_alertas_inmediatas ?? false,
    recibe_resumen_diario: usuario?.recibe_resumen_diario ?? true,
    activo: usuario ? esUsuarioActivo(usuario) : true,
  });
  const [verClave, setVerClave] = useState(true);
  const [errores, setErrores] = useState({});
  const [errorGeneral, setErrorGeneral] = useState(null);
  const [saving, setSaving] = useState(false);
  const cambiar = (k, v) => { setErrorGeneral(null); setErrores(e => ({ ...e, [k]: undefined })); setForm(f => ({ ...f, [k]: v })); };
  const alternarMenu = (id) => cambiar('menus_permitidos',
    form.menus_permitidos.includes(id) ? form.menus_permitidos.filter(m => m !== id) : [...form.menus_permitidos, id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = {};
    if (!/\S+@\S+\.\S+/.test(form.email.trim())) err.email = 'Escribe un correo válido';
    if (!form.nombre.trim()) err.nombre = 'Obligatorio';
    if (isNew && form.password.length < 8) err.password = 'Mínimo 8 caracteres';
    if (form.rol === 'consulta' && form.menus_permitidos.length === 0) err.menus = 'Elige al menos un menú';
    setErrores(err);
    if (Object.keys(err).length) return;
    setSaving(true);
    try { await onSave(form, isNew); } catch (ex) { setErrorGeneral(ex.message); }
    setSaving(false);
  };

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={isNew ? 'Nuevo usuario' : 'Editar usuario'}
      subtitle={isNew ? 'Los campos con * son obligatorios.' : usuario.email}
      icon={isNew ? 'person_add' : 'edit'}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 w-full">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" checked={form.activo} disabled={yo} onChange={e => cambiar('activo', e.target.checked)} className="m3-switch" />
            <span>{form.activo ? 'Activo: puede entrar' : 'Inactivo: no puede entrar'}</span>
          </label>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
            <button type="submit" form="usuario-form" disabled={saving} className="m3-btn-primary h-10 px-6">
              {saving ? 'Guardando…' : isNew ? 'Crear usuario' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      }
    >
      <form id="usuario-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {errorGeneral && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{errorGeneral}</span>
          </div>
        )}

        <FormSection titulo="Datos" icono="badge">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Correo" requerido error={errores.email} hint={isNew ? 'Será su usuario para entrar.' : 'No se puede cambiar.'}>
              <input type="email" value={form.email} disabled={!isNew} onChange={e => cambiar('email', e.target.value)} className="m3-input" placeholder="correo@empresa.com" />
            </Field>
            <Field label="Nombre" requerido error={errores.nombre}>
              <input type="text" value={form.nombre} onChange={e => cambiar('nombre', e.target.value)} className="m3-input" placeholder="Ej. Juan Pérez" />
            </Field>
          </div>
          {isNew && (
            <Field label="Contraseña inicial" requerido error={errores.password}
              hint="Pásasela a la persona; la cambia en Mi cuenta. También puedes enviarle el enlace de contraseña después.">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input type={verClave ? 'text' : 'password'} value={form.password} onChange={e => cambiar('password', e.target.value)}
                    className="m3-input pr-12 font-mono" autoComplete="new-password" />
                  <button type="button" onClick={() => setVerClave(v => !v)} className="m3-icon-btn m3-icon-btn-sm absolute right-2 top-1/2 -translate-y-1/2"
                    aria-label={verClave ? 'Ocultar' : 'Mostrar'}>
                    <span className="material-symbols-outlined">{verClave ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
                <button type="button" onClick={() => cambiar('password', generarClave())} className="m3-btn-text" title="Generar otra">
                  <span className="material-symbols-outlined">refresh</span>
                  Otra
                </button>
              </div>
            </Field>
          )}
        </FormSection>

        <FormSection titulo="Rol y menús" icono="admin_panel_settings">
          <Field label="Rol" requerido hint={form.rol === 'administrador' ? 'Ve y cambia todo, incluidos los usuarios.' : 'Solo ve los menús que marques; no cambia usuarios.'}>
            {yo ? (
              <p className="m3-body-medium text-on-surface-variant">Administrador (no puedes quitarte este rol).</p>
            ) : (
              <ChoiceChips valor={form.rol} onChange={v => cambiar('rol', v)} opciones={ROLES} nombre="rol" />
            )}
          </Field>
          {form.rol === 'consulta' && (
            <Field label="Menús que puede ver" requerido error={errores.menus}>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_MENUS.map(m => {
                  const on = form.menus_permitidos.includes(m.id);
                  return (
                    <button key={m.id} type="button" aria-pressed={on} onClick={() => alternarMenu(m.id)}
                      className={`m3-choice-chip ${on ? 'is-selected' : ''}`} title={m.desc}>
                      <span className="material-symbols-outlined" aria-hidden="true">{on ? 'check' : m.icon}</span>
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </FormSection>

        <FormSection titulo="Correos" icono="mail">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" className="m3-switch" checked={form.recibe_alertas_inmediatas}
              onChange={e => cambiar('recibe_alertas_inmediatas', e.target.checked)} />
            <span><strong>Alertas inmediatas</strong> · cuando un competidor cambia mucho su precio</span>
          </label>
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" className="m3-switch" checked={form.recibe_resumen_diario}
              onChange={e => cambiar('recibe_resumen_diario', e.target.checked)} />
            <span><strong>Resumen diario</strong> · un correo por la mañana con lo que cambió</span>
          </label>
        </FormSection>
      </form>
    </ModalWrapper>
  );
}
