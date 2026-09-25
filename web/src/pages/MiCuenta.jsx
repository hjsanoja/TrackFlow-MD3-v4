import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import { FormSection, Field } from '../components/formulario';
import { registrarAcceso, mensajeAuth } from '../utils/accesos';
import { AVAILABLE_MENUS, etiquetaEvento, fechaHora } from '../utils/usuarios';

// Mi cuenta: cada usuario ve sus datos, cambia su nombre, elige que correos
// recibe, cambia su contraseña y ve sus ultimos accesos. El rol, los menus y
// el estado solo los cambia un administrador (fn_actualizar_mi_cuenta).
export default function MiCuenta({ user, userDoc, onActualizado }) {
  const { addToast } = useToast();
  const esAdmin = userDoc?.rol === 'administrador';

  const [datos, setDatos] = useState({
    nombre: userDoc?.nombre || '',
    alertas: Boolean(userDoc?.recibe_alertas_inmediatas),
    resumen: Boolean(userDoc?.recibe_resumen_diario),
  });
  const [guardandoDatos, setGuardandoDatos] = useState(false);

  const [clave, setClave] = useState({ actual: '', nueva: '', repetir: '' });
  const [verClave, setVerClave] = useState(false);
  const [errorClave, setErrorClave] = useState('');
  const [guardandoClave, setGuardandoClave] = useState(false);

  const [accesos, setAccesos] = useState(null);

  useEffect(() => {
    if (!isSupabaseActive() || !user?.email) { setAccesos([]); return; }
    supabase.from('accesos').select('evento, fecha, agente')
      .eq('email', user.email.toLowerCase())
      .order('fecha', { ascending: false }).limit(10)
      .then(({ data, error }) => setAccesos(error ? [] : data || []));
  }, [user?.email]);

  const cambiado = datos.nombre.trim() !== (userDoc?.nombre || '') ||
    datos.alertas !== Boolean(userDoc?.recibe_alertas_inmediatas) ||
    datos.resumen !== Boolean(userDoc?.recibe_resumen_diario);

  const guardarDatos = async (e) => {
    e.preventDefault();
    if (!datos.nombre.trim()) { addToast('El nombre no puede quedar vacío.', 'error'); return; }
    setGuardandoDatos(true);
    const { error } = await supabase.rpc('fn_actualizar_mi_cuenta', {
      p_nombre: datos.nombre.trim(),
      p_recibe_alertas: datos.alertas,
      p_recibe_resumen: datos.resumen,
    });
    setGuardandoDatos(false);
    if (error) { addToast(`No se pudo guardar: ${error.message}`, 'error'); return; }
    onActualizado?.({ ...userDoc, nombre: datos.nombre.trim(), recibe_alertas_inmediatas: datos.alertas, recibe_resumen_diario: datos.resumen });
    addToast('Tus datos quedaron guardados.', 'success');
  };

  const cambiarClave = async (e) => {
    e.preventDefault();
    setErrorClave('');
    if (!clave.actual) { setErrorClave('Escribe tu contraseña actual.'); return; }
    if (clave.nueva.length < 8) { setErrorClave('La nueva debe tener al menos 8 caracteres.'); return; }
    if (clave.nueva !== clave.repetir) { setErrorClave('Las dos contraseñas nuevas no coinciden.'); return; }
    setGuardandoClave(true);
    // Primero se comprueba la actual: asi nadie la cambia desde una sesion
    // que otra persona dejo abierta.
    const { error: errActual } = await supabase.auth.signInWithPassword({ email: user.email, password: clave.actual });
    if (errActual) {
      setGuardandoClave(false);
      setErrorClave(/invalid login/i.test(errActual.message || '') ? 'La contraseña actual no es correcta.' : mensajeAuth(errActual));
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: clave.nueva });
    setGuardandoClave(false);
    if (error) { setErrorClave(mensajeAuth(error)); return; }
    await registrarAcceso('clave_cambiada');
    setClave({ actual: '', nueva: '', repetir: '' });
    addToast('Contraseña cambiada.', 'success');
  };

  const menus = esAdmin
    ? AVAILABLE_MENUS
    : AVAILABLE_MENUS.filter(m => (userDoc?.menus_permitidos || ['/', '/mapa-calor']).includes(m.id));

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans max-w-3xl">
      <div className="border-b border-surface-variant pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary text-3xl">manage_accounts</span>
          <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Mi cuenta</h1>
        </div>
        <p className="text-xs text-on-surface-variant">Tus datos, los correos que recibes y tu contraseña.</p>
      </div>

      <form onSubmit={guardarDatos} className="space-y-4">
        <FormSection titulo="Tus datos" icono="badge">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Nombre" requerido>
              <input type="text" value={datos.nombre} onChange={e => setDatos(d => ({ ...d, nombre: e.target.value }))} className="m3-input" />
            </Field>
            <Field label="Correo" hint="Es tu usuario para entrar; solo lo cambia un administrador.">
              <input type="email" value={user?.email || ''} disabled className="m3-input" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="m3-label-medium text-on-surface-variant mr-1">{esAdmin ? 'Administrador · acceso a todo' : 'Usuario de consulta · puedes ver:'}</span>
            {!esAdmin && menus.map(m => (
              <span key={m.id} className="m3-chip-menu">
                <span className="material-symbols-outlined" aria-hidden="true">{m.icon}</span>{m.label}
              </span>
            ))}
          </div>
        </FormSection>

        <FormSection titulo="Correos que recibes" icono="mail">
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" className="m3-switch" checked={datos.alertas}
              onChange={e => setDatos(d => ({ ...d, alertas: e.target.checked }))} />
            <span><strong>Alertas inmediatas</strong> · cuando un competidor cambia mucho su precio</span>
          </label>
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" className="m3-switch" checked={datos.resumen}
              onChange={e => setDatos(d => ({ ...d, resumen: e.target.checked }))} />
            <span><strong>Resumen diario</strong> · un correo por la mañana con lo que cambió</span>
          </label>
        </FormSection>

        <div className="flex justify-end">
          <button type="submit" disabled={!cambiado || guardandoDatos} className="m3-btn-primary h-10 px-6">
            {guardandoDatos ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </form>

      <form onSubmit={cambiarClave} className="space-y-4" noValidate>
        <FormSection titulo="Cambiar contraseña" icono="password">
          <Field label="Contraseña actual">
            <input type={verClave ? 'text' : 'password'} value={clave.actual} autoComplete="current-password"
              onChange={e => setClave(c => ({ ...c, actual: e.target.value }))} className="m3-input" />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Contraseña nueva" hint="Mínimo 8 caracteres.">
              <input type={verClave ? 'text' : 'password'} value={clave.nueva} autoComplete="new-password"
                onChange={e => setClave(c => ({ ...c, nueva: e.target.value }))} className="m3-input" />
            </Field>
            <Field label="Repite la nueva">
              <input type={verClave ? 'text' : 'password'} value={clave.repetir} autoComplete="new-password"
                onChange={e => setClave(c => ({ ...c, repetir: e.target.value }))} className="m3-input" />
            </Field>
          </div>
          <label className="m3-switch-label">
            <input type="checkbox" role="switch" className="m3-switch" checked={verClave} onChange={e => setVerClave(e.target.checked)} />
            <span>Mostrar contraseñas</span>
          </label>
          {errorClave && (
            <div className="m3-form-alert" role="alert">
              <span className="material-symbols-outlined" aria-hidden="true">error</span>
              <span className="flex-1">{errorClave}</span>
            </div>
          )}
        </FormSection>
        <div className="flex justify-end">
          <button type="submit" disabled={guardandoClave} className="m3-btn-tonal">
            <span className="material-symbols-outlined">lock_reset</span>
            {guardandoClave ? 'Cambiando…' : 'Cambiar contraseña'}
          </button>
        </div>
      </form>

      <FormSection titulo="Tus últimos accesos" icono="history">
        {accesos === null ? (
          <div className="h-16 rounded-xl m3-skeleton" />
        ) : accesos.length === 0 ? (
          <p className="m3-body-medium text-on-surface-variant">Todavía no hay accesos registrados.</p>
        ) : (
          <ul className="divide-y divide-outline-variant">
            {accesos.map((a, i) => (
              <li key={i} className="flex items-center gap-3 py-2 m3-body-medium">
                <span className="material-symbols-outlined text-on-surface-variant" aria-hidden="true">{etiquetaEvento(a.evento).icono}</span>
                <span className="flex-1">{etiquetaEvento(a.evento).texto}</span>
                <span className="text-on-surface-variant tabular-nums">{fechaHora(a.fecha)}</span>
              </li>
            ))}
          </ul>
        )}
      </FormSection>
    </div>
  );
}
