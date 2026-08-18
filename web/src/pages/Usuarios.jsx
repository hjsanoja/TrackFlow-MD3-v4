import { useEffect, useState } from 'react';
import { db, firebaseConfig } from '../firebase';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'firebase/auth';
import { supabase, isSupabaseActive } from '../supabase';
import ConfirmModal from '../components/ConfirmModal';
import ModalWrapper from '../components/ModalWrapper';
import GitHubConfigModal from '../components/GitHubConfigModal';
import { getGitHubConfig } from '../utils/githubClient';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import { dbUpsertUsuario, dbDeleteUsuario } from '../utils/dbClient';

const ROLES = [
  { value: 'administrador', label: 'Administrador', desc: 'Acceso completo, puede editar todo' },
  { value: 'lector', label: 'Lector', desc: 'Solo ver y exportar datos' },
];

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

export default function Usuarios({ userDoc }) {
  const { usuarios, loadingInitial: loading, refreshUsuarios: cargar } = useData();

  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [githubInfo, setGithubInfo] = useState(null);

  const { addToast } = useToast();

  const cargarGithubConfig = async () => {
    const cfg = await getGitHubConfig();
    if (cfg && cfg.token) {
      setGithubInfo(cfg);
    } else {
      setGithubInfo(null);
    }
  };

  useEffect(() => {
    cargarGithubConfig();
  }, []);

  const handleSave = async (data, isNew) => {
    let secondaryApp = null;
    try {
      const email = data.email.trim().toLowerCase();
      if (!email || !/\S+@\S+\.\S+/.test(email)) {
        throw new Error('Email inválido');
      }
      const docId = emailToDocId(email);
      if (isNew && usuarios.some(u => u.id === docId)) {
        throw new Error('Ya existe un usuario con ese email en la base de datos');
      }

      if (isNew) {
        if (!data.password || data.password.length < 6) {
          throw new Error('La contraseña debe tener al menos 6 caracteres');
        }

        // 1. Intentar registro en Supabase Auth si está activo
        if (isSupabaseActive()) {
          try {
            await supabase.auth.signUp({
              email,
              password: data.password,
            });
          } catch (sbErr) {
            console.warn('[Supabase Auth Warning]:', sbErr?.message || sbErr);
          }
        }

        // 2. Intentar registro en Firebase Auth solo si la API key no es mock
        const isMockFirebaseKey = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('MockKey') || firebaseConfig.apiKey.includes('123456');
        if (!isMockFirebaseKey) {
          try {
            secondaryApp = initializeApp(firebaseConfig, `secondary-app-${Date.now()}`);
            const secondaryAuth = getAuth(secondaryApp);
            await createUserWithEmailAndPassword(secondaryAuth, email, data.password);
            await signOut(secondaryAuth);
            await deleteApp(secondaryApp);
            secondaryApp = null;
          } catch (fbErr) {
            console.warn('[Firebase Auth Warning]:', fbErr?.message || fbErr);
            if (secondaryApp) {
              try { await deleteApp(secondaryApp); } catch (e) {}
              secondaryApp = null;
            }
          }
        }
      }

      await dbUpsertUsuario({
        id: docId,
        email,
        nombre: data.nombre.trim(),
        rol: data.rol,
        recibe_alertas_inmediatas: data.recibe_alertas_inmediatas,
        recibe_resumen_diario: data.recibe_resumen_diario,
        activo: data.activo,
      });

      addToast(
        isNew
          ? `Usuario creado y registrado correctamente.`
          : 'Cambios guardados con éxito',
        'success'
      );
      setEditing(null);
      await cargar(true);
    } catch (err) {
      if (secondaryApp) {
        try { await deleteApp(secondaryApp); } catch (e) {}
      }
      addToast(err.message, 'error');
    }
  };

  const handleSendResetEmail = async (email) => {
    try {
      if (isSupabaseActive()) {
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (!error) {
          addToast(`Se ha enviado un correo para restablecer la contraseña a ${email}`, 'success');
          return;
        }
      }
      const isMockFirebaseKey = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('MockKey') || firebaseConfig.apiKey.includes('123456');
      if (!isMockFirebaseKey) {
        const authInstance = getAuth();
        await sendPasswordResetEmail(authInstance, email);
        addToast(`Se ha enviado un correo para restablecer la contraseña a ${email}`, 'success');
      } else {
        addToast(`Solicitud de restablecimiento registrada para ${email}`, 'info');
      }
    } catch (err) {
      addToast('Error al enviar correo de restablecimiento: ' + (err.message || String(err)), 'error');
    }
  };

  const handleDelete = (usuario) => {
    if (usuario.email === userDoc?.email) {
      addToast('No puedes eliminar tu propio usuario.', 'error');
      return;
    }
    setConfirmDelete(usuario);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const usuario = confirmDelete;
    setConfirmDelete(null);
    try {
      await dbDeleteUsuario(usuario.id);
      addToast('Usuario eliminado con éxito.', 'success');
      await cargar(true);
    } catch (err) {
      addToast('Error al eliminar: ' + err.message, 'error');
    }
  };

  const handleToggleActivo = async (usuario) => {
    if (usuario.email === userDoc?.email && usuario.activo) {
      addToast('No puedes desactivar tu propio usuario.', 'error');
      return;
    }
    try {
      await dbUpsertUsuario({
        ...usuario,
        activo: !usuario.activo,
      });
      await cargar(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      {/* Title Header Block */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">manage_accounts</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">
              Usuarios Autorizados
            </h1>
          </div>
          <p className="text-xs text-on-surface-variant font-sans">
            Administra los roles de acceso, credenciales y perfiles de alertas del sistema.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="m3-btn-primary"
        >
          <span className="material-symbols-outlined text-base">person_add</span>
          <span>Invitar Usuario</span>
        </button>
      </div>

      <div className="bg-primary/5 border border-primary/20 rounded-2xl px-5 py-4 text-xs text-on-background space-y-1.5 shadow-xs">
        <div className="flex items-center gap-2 font-mono font-bold text-sm text-primary">
          <span className="material-symbols-outlined text-lg leading-none">info</span>
          <span>Cómo registrar y dar acceso a un colaborador</span>
        </div>
        <ol className="list-decimal ml-5 mt-1 space-y-1 text-xs text-on-surface-variant font-sans">
          <li>Haz clic en el botón <strong>"Invitar Usuario"</strong> para registrar sus datos y crear automáticamente su cuenta.</li>
          <li>Especifica una contraseña inicial segura (mínimo 6 caracteres) para que el nuevo colaborador pueda iniciar sesión de inmediato.</li>
          <li>Si un colaborador olvida su contraseña, haz clic en el botón <strong>"Clave"</strong> junto a su nombre para enviarle un correo automático para restablecerla.</li>
        </ol>
      </div>

      {/* Main Grid View */}
      <div className="neural-card overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto animate-pulse">
            <table className="m3-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Email</th>
                  <th>Rol</th>
                  <th className="text-center">Alertas Inmediatas</th>
                  <th className="text-center">Resumen Diario</th>
                  <th className="text-center">Estado</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {[1, 2, 3].map((n) => (
                  <tr key={n}>
                    <td><div className="h-4 bg-gray-200 rounded w-32"></div></td>
                    <td><div className="h-4 bg-gray-200 rounded w-48"></div></td>
                    <td><div className="h-4 bg-gray-200 rounded w-28"></div></td>
                    <td className="text-center"><div className="h-4 bg-gray-200 rounded w-8 mx-auto"></div></td>
                    <td className="text-center"><div className="h-4 bg-gray-200 rounded w-8 mx-auto"></div></td>
                    <td className="text-center"><div className="h-6 bg-gray-200 rounded-full w-14 mx-auto"></div></td>
                    <td className="text-right"><div className="h-4 bg-gray-200 rounded w-16 ml-auto"></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : usuarios.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant">
              <span className="material-symbols-outlined text-2xl">group_add</span>
            </div>
            <div>
              <div className="font-bold text-on-surface font-display text-base">Aún no hay usuarios registrados</div>
              <div className="text-xs text-on-surface-variant mt-0.5">Invita a miembros del equipo para delegar acceso y configurar alertas.</div>
            </div>
            <button onClick={() => setEditing('new')} className="m3-btn-primary h-8 px-4 text-xs mt-1">
              + Invitar Primer Usuario
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[750px] relative">
            <table className="m3-table">
              <thead className="m3-sticky-header">
                <tr>
                  <th>Nombre</th>
                  <th>Email</th>
                  <th>Rol</th>
                  <th className="text-center">Alertas Inmediatas</th>
                  <th className="text-center">Resumen Diario</th>
                  <th className="text-center">Estado</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant">
                {usuarios.map(u => {
                  const isCurrent = u.email === userDoc?.email;
                  return (
                    <tr key={u.id} className="hover:bg-surface-low transition-colors">
                      <td>
                        <span className="font-bold text-on-surface font-display text-sm">{u.nombre}</span>
                        {isCurrent && (
                          <span className="ml-2 text-[10px] bg-primary-container text-on-primary-container font-mono uppercase font-bold px-2 py-0.5 rounded-full">
                            Tú
                          </span>
                        )}
                      </td>
                      <td className="font-mono text-xs text-on-surface-variant">{u.email}</td>
                      <td>
                        <span className={`text-[10px] uppercase font-mono font-bold px-2.5 py-1 rounded-full ${
                          u.rol === 'administrador' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-low text-on-surface-variant border border-outline-variant'
                        }`}>
                          {u.rol}
                        </span>
                      </td>
                      <td className="text-center">
                        {u.recibe_alertas_inmediatas ? (
                          <span className="material-symbols-outlined text-base text-secondary select-none">check_circle</span>
                        ) : (
                          <span className="text-on-surface-variant/40 font-mono select-none">—</span>
                        )}
                      </td>
                      <td className="text-center">
                        {u.recibe_resumen_diario ? (
                          <span className="material-symbols-outlined text-base text-secondary select-none">check_circle</span>
                        ) : (
                          <span className="text-on-surface-variant/40 font-mono select-none">—</span>
                        )}
                      </td>
                      <td className="text-center">
                        <button onClick={() => handleToggleActivo(u)} disabled={isCurrent && u.activo}
                          className={`text-[10px] uppercase font-mono font-bold px-3 py-1 rounded-full transition-all ${
                            u.activo ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-low text-on-surface-variant border border-outline-variant'
                          } ${isCurrent && u.activo ? 'opacity-50 cursor-not-allowed' : ''}`}>
                          {u.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <button onClick={() => setEditing(u.id)}
                          className="text-xs text-primary hover:text-primary/80 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">edit</span>
                          Editar
                        </button>
                        <button onClick={() => handleSendResetEmail(u.email)}
                          className="text-xs text-amber-600 hover:text-amber-700 font-bold mr-4 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">lock_reset</span>
                          Clave
                        </button>
                        <button onClick={() => handleDelete(u)} disabled={isCurrent}
                          className={`text-xs text-error hover:text-error/80 font-bold inline-flex items-center gap-1 ${
                            isCurrent ? 'opacity-30 cursor-not-allowed' : ''
                          }`}>
                          <span className="material-symbols-outlined text-sm">delete</span>
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* GitHub Integration Card (Solo Administradores) */}
      <div className="bg-white rounded-3xl border border-[#e1e2ec] shadow-sm p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 rounded-2xl">
              <span className="material-symbols-outlined text-2xl">smart_toy</span>
            </div>
            <div>
              <h3 className="text-base font-bold text-[#040d53] font-display">Integración Robot Extractor (GitHub Actions)</h3>
              <p className="text-xs text-[#464650] font-sans">
                {githubInfo
                  ? `Conectado al repositorio ${githubInfo.repo_owner}/${githubInfo.repo_name}`
                  : 'Aún no se han configurado credenciales de conexión a GitHub.'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowGithubModal(true)}
            className="m3-btn-outline h-9 px-4 text-xs flex items-center gap-2 self-start sm:self-auto"
          >
            <span className="material-symbols-outlined text-base">key</span>
            <span>{githubInfo ? 'Modificar Token / Configuración' : 'Configurar Token PAT'}</span>
          </button>
        </div>
      </div>

      {editing && (
        <UsuarioModal
          usuario={editing === 'new' ? null : usuarios.find(u => u.id === editing)}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmModal
        isOpen={!!confirmDelete}
        title="¿Eliminar Usuario?"
        message={
          confirmDelete 
            ? `¿Estás seguro de que deseas eliminar a "${confirmDelete.nombre}" (${confirmDelete.email})?\n\nIMPORTANTE: El documento se borrará de Firestore, pero su cuenta de Firebase Auth seguirá activa. Para impedir el inicio de sesión completamente, también debes eliminarla en Firebase Console → Authentication.`
            : ''
        }
        confirmText="Eliminar"
        cancelText="Cancelar"
        isDanger={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      <GitHubConfigModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
        onSaveSuccess={(newConfig) => {
          setGithubInfo(newConfig);
        }}
      />
    </div>
  );
}

function UsuarioModal({ usuario, onSave, onClose }) {
  const isNew = !usuario;
  const [form, setForm] = useState({
    email: usuario?.email || '',
    nombre: usuario?.nombre || '',
    password: '',
    rol: usuario?.rol || 'lector',
    recibe_alertas_inmediatas: usuario?.recibe_alertas_inmediatas ?? false,
    recibe_resumen_diario: usuario?.recibe_resumen_diario ?? true,
    activo: usuario?.activo ?? true,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(form, isNew);
    setSaving(false);
  };
  const handleChange = (key, value) => setForm(f => ({ ...f, [key]: value }));

  return (
    <ModalWrapper
      isOpen={true}
      onClose={onClose}
      title={isNew ? 'Invitar Usuario' : 'Editar Usuario'}
      subtitle={isNew ? 'Registra una nueva cuenta de acceso al sistema' : `Editando permisos de ${form.nombre || form.email}`}
      icon="person"
      maxWidth="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Correo Electrónico *">
          <input type="email" required value={form.email}
            onChange={e => handleChange('email', e.target.value)}
            disabled={!isNew}
            placeholder="correo@empresa.com"
            className="m3-input disabled:bg-surface-container-low" />
        </Field>
        <Field label="Nombre Completo *">
          <input type="text" required value={form.nombre}
            onChange={e => handleChange('nombre', e.target.value)}
            placeholder="Ej. Juan Pérez"
            className="m3-input" />
        </Field>
        {isNew && (
          <Field label="Contraseña de Acceso (mínimo 6 carácteres) *">
            <input type="password" required minLength={6} value={form.password}
              onChange={e => handleChange('password', e.target.value)}
              placeholder="Ingresa la contraseña del nuevo usuario"
              className="m3-input" />
          </Field>
        )}
        <Field label="Rol Autorizado *">
          <div className="space-y-2">
            {ROLES.map(r => (
              <label key={r.value} className={`flex items-start gap-3 p-3.5 border rounded-2xl cursor-pointer transition-all select-none ${
                form.rol === r.value ? 'bg-primary/10 border-primary shadow-xs' : 'border-outline-variant/60 hover:bg-surface-container-low'
              }`}>
                <input type="radio" name="rol" value={r.value}
                  checked={form.rol === r.value}
                  onChange={e => handleChange('rol', e.target.value)}
                  className="mt-1 text-primary focus:ring-primary h-4 w-4" />
                <div>
                  <div className="text-sm font-bold font-display text-primary">{r.label}</div>
                  <div className="text-xs text-on-surface-variant mt-0.5 font-sans">{r.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Preferencias de Notificaciones">
          <div className="space-y-2.5 px-4 py-3 border border-outline-variant/60 rounded-2xl bg-surface-container-low">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={form.recibe_alertas_inmediatas}
                onChange={e => handleChange('recibe_alertas_inmediatas', e.target.checked)}
                className="rounded text-primary focus:ring-primary h-4 w-4" />
              <span className="text-xs font-bold text-on-surface">Alertas inmediatas cuando se cruce un umbral de volatilidad</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={form.recibe_resumen_diario}
                onChange={e => handleChange('recibe_resumen_diario', e.target.checked)}
                className="rounded text-primary focus:ring-primary h-4 w-4" />
              <span className="text-xs font-bold text-on-surface">Resumen diario consolidado por correo</span>
            </label>
          </div>
        </Field>
        <Field label="Estado del Acceso">
          <label className="flex items-center gap-3 px-4 py-3 border border-outline-variant/60 rounded-2xl cursor-pointer bg-surface-container-low select-none font-bold text-xs text-primary hover:bg-surface-container transition-colors">
            <input type="checkbox" checked={form.activo}
              onChange={e => handleChange('activo', e.target.checked)}
              className="rounded text-primary focus:ring-primary h-4 w-4" />
            <span>{form.activo ? 'ACCESO ACTIVO (Inicia sesión sin restricción)' : 'ACCESO INACTIVO (Bloqueo temporal)'}</span>
          </label>
        </Field>
        <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/60">
          <button type="button" onClick={onClose}
            className="m3-btn-outline h-9 px-4 text-xs">Cancelar</button>
          <button type="submit" disabled={saving}
            className="m3-btn-primary h-9 px-5 text-xs">
            {saving ? 'Guardando...' : isNew ? 'Invitar' : 'Guardar Cambios'}
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
