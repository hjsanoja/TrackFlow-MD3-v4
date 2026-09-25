import { useState } from 'react';
import { supabase } from '../supabase';
import { registrarAcceso, urlDelPanel, mensajeAuth } from '../utils/accesos';

// Inicio de sesion con correo y contraseña, y "¿Olvidaste tu contraseña?":
// Supabase manda un enlace; al abrirlo, App muestra "Crea tu contraseña nueva".
export default function Login() {
  const [modo, setModo] = useState('entrar'); // 'entrar' | 'recuperar' | 'enviado'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!import.meta.env.VITE_SUPABASE_URL) {
      setError('Error de configuración: falta VITE_SUPABASE_URL.');
      return;
    }
    setLoading(true);
    try {
      const { data, error: sbError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (sbError || !data?.user) {
        setError(mensajeAuth(sbError || 'No se recibió una sesión válida.'));
        setLoading(false);
        return;
      }
      registrarAcceso('ingreso');
      // App.jsx recibe la sesion y comprueba que el usuario este activo.
    } catch (err) {
      setError(mensajeAuth(err));
      setLoading(false);
    }
  };

  const handleRecuperar = async (e) => {
    e.preventDefault();
    setError('');
    const correo = email.trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(correo)) { setError('Escribe tu correo.'); return; }
    setLoading(true);
    const { error: sbError } = await supabase.auth.resetPasswordForEmail(correo, { redirectTo: urlDelPanel() });
    setLoading(false);
    // Por seguridad no se dice si el correo existe o no.
    if (sbError && /rate limit|too many/i.test(sbError.message || '')) { setError(mensajeAuth(sbError)); return; }
    setModo('enviado');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
      <div className="w-full max-w-md bg-surface-container-lowest rounded-[28px] border border-outline-variant p-8 sm:p-10 space-y-8">
        <div className="text-center space-y-2">
          <div className="mx-auto w-16 h-16 rounded-[20px] bg-primary flex items-center justify-center">
            <span className="material-symbols-outlined text-on-primary text-3xl select-none">monitoring</span>
          </div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">TrackFlow</h1>
          <p className="m3-body-medium text-on-surface-variant">Inteligencia de precios</p>
        </div>

        {modo === 'enviado' ? (
          <div className="space-y-5">
            <div className="flex gap-3 p-4 rounded-2xl bg-primary-container text-on-primary-container">
              <span className="material-symbols-outlined" aria-hidden="true">mark_email_read</span>
              <p className="m3-body-medium">
                Si <strong>{email.trim().toLowerCase()}</strong> tiene acceso, te llegará un correo con un enlace para crear una contraseña nueva.
                Revisa también la carpeta de spam.
              </p>
            </div>
            <button type="button" onClick={() => { setModo('entrar'); setError(''); }} className="m3-btn-text w-full justify-center">
              <span className="material-symbols-outlined">arrow_back</span>
              Volver a iniciar sesión
            </button>
          </div>
        ) : (
          <form onSubmit={modo === 'entrar' ? handleSubmit : handleRecuperar} className="space-y-5" noValidate>
            {modo === 'recuperar' && (
              <p className="m3-body-medium text-on-surface-variant">
                Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva.
              </p>
            )}
            <label className="m3-field">
              <span className="m3-field-label">Correo electrónico</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="m3-input" placeholder="usuario@empresa.com" autoComplete="email" autoFocus />
            </label>

            {modo === 'entrar' && (
              <label className="m3-field">
                <span className="m3-field-label">Contraseña</span>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} required value={password}
                    onChange={(e) => setPassword(e.target.value)} className="m3-input pr-12"
                    placeholder="••••••••" autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPassword(v => !v)}
                    className="m3-icon-btn m3-icon-btn-sm absolute right-2 top-1/2 -translate-y-1/2"
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                    <span className="material-symbols-outlined">{showPassword ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </label>
            )}

            {error && (
              <div className="m3-form-alert" role="alert">
                <span className="material-symbols-outlined" aria-hidden="true">error</span>
                <span className="flex-1">{error}</span>
              </div>
            )}

            <button type="submit" disabled={loading} className="w-full m3-btn-primary h-11 justify-center">
              {loading ? (
                <>
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  {modo === 'entrar' ? 'Entrando…' : 'Enviando…'}
                </>
              ) : modo === 'entrar' ? (
                <>
                  Entrar
                  <span className="material-symbols-outlined">login</span>
                </>
              ) : (
                <>
                  Enviar enlace
                  <span className="material-symbols-outlined">send</span>
                </>
              )}
            </button>

            <button type="button" onClick={() => { setModo(modo === 'entrar' ? 'recuperar' : 'entrar'); setError(''); }}
              className="m3-btn-text w-full justify-center">
              {modo === 'entrar' ? '¿Olvidaste tu contraseña?' : 'Volver a iniciar sesión'}
            </button>
          </form>
        )}

        <p className="pt-5 border-t border-outline-variant text-center m3-body-small text-on-surface-variant">
          Acceso restringido a personal autorizado.
        </p>
      </div>
    </div>
  );
}
