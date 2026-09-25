import { useState } from 'react';
import { supabase } from '../supabase';
import { registrarAcceso, mensajeAuth } from '../utils/accesos';

// Pantalla a la que lleva el enlace de "recuperar contraseña": la sesion ya
// esta abierta (la trae el enlace), falta elegir la contraseña nueva.
export default function NuevaContrasena({ email, onListo, onCancelar }) {
  const [clave, setClave] = useState('');
  const [repetir, setRepetir] = useState('');
  const [ver, setVer] = useState(false);
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setError('');
    if (clave.length < 8) { setError('Usa al menos 8 caracteres.'); return; }
    if (clave !== repetir) { setError('Las dos contraseñas no coinciden.'); return; }
    setGuardando(true);
    const { error: err } = await supabase.auth.updateUser({ password: clave });
    setGuardando(false);
    if (err) { setError(mensajeAuth(err)); return; }
    await registrarAcceso('clave_cambiada');
    onListo();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
      <form onSubmit={enviar} className="w-full max-w-md bg-surface-container-lowest rounded-[28px] border border-outline-variant p-8 space-y-6">
        <div className="space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-primary-container text-on-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined">lock_reset</span>
          </div>
          <h1 className="m3-headline-small text-on-surface">Crea tu contraseña nueva</h1>
          {email && <p className="m3-body-medium text-on-surface-variant">Para {email}</p>}
        </div>

        <label className="m3-field">
          <span className="m3-field-label">Contraseña nueva</span>
          <div className="relative">
            <input type={ver ? 'text' : 'password'} value={clave} onChange={e => setClave(e.target.value)}
              className="m3-input pr-12" autoComplete="new-password" autoFocus required minLength={8} />
            <button type="button" onClick={() => setVer(v => !v)} className="m3-icon-btn m3-icon-btn-sm absolute right-2 top-1/2 -translate-y-1/2"
              aria-label={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
              <span className="material-symbols-outlined">{ver ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
          <span className="m3-field-support">Mínimo 8 caracteres.</span>
        </label>

        <label className="m3-field">
          <span className="m3-field-label">Repite la contraseña</span>
          <input type={ver ? 'text' : 'password'} value={repetir} onChange={e => setRepetir(e.target.value)}
            className="m3-input" autoComplete="new-password" required />
        </label>

        {error && (
          <div className="m3-form-alert" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            <span className="flex-1">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {onCancelar && <button type="button" onClick={onCancelar} className="m3-btn-text">Cancelar</button>}
          <button type="submit" disabled={guardando} className="m3-btn-primary h-10 px-6">
            {guardando ? 'Guardando…' : 'Guardar y entrar'}
          </button>
        </div>
      </form>
    </div>
  );
}
