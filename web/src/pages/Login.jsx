import { useState } from 'react';
import { supabase } from '../supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

    // Validación estricta de configuración de entorno
    if (!supabaseUrl) {
      setError('Error de configuración: La variable VITE_SUPABASE_URL no está definida en el entorno.');
      setLoading(false);
      return;
    }

    try {
      const { data, error: sbError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password,
      });

      if (sbError) {
        setError(sbError.message || 'Error al autenticar credenciales en Supabase.');
        setLoading(false);
        return;
      }

      if (!data?.user) {
        setError('No se recibió una sesión válida del servidor de autenticación.');
        setLoading(false);
        return;
      }

      // El listener en App.jsx procesará la sesión y validará autorización en la tabla usuarios
    } catch (err) {
      setError(err?.message || 'Error inesperado al conectar con Supabase Auth.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
      <div className="w-full max-w-md bg-white rounded-[32px] border border-outline-variant p-10 shadow-sm space-y-8">
        <div className="text-center space-y-2">
          {/* Logo TrackFlow */}
          <div className="mx-auto w-16 h-16 rounded-[20px] bg-primary flex items-center justify-center shadow-inner">
            <span className="material-symbols-outlined text-secondary-container text-3xl select-none">monitoring</span>
          </div>
          <h1 className="text-3xl font-display font-extrabold text-primary tracking-tight">TrackFlow</h1>
          <p className="text-xs font-mono font-bold uppercase tracking-wider text-on-surface-variant">Inteligencia de Precios</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1">
            <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">Correo Electrónico</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="m3-input"
              placeholder="usuario@empresa.com"
              autoComplete="email"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-mono font-bold uppercase tracking-wider text-primary">Contraseña</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="m3-input pr-11"
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-on-surface-variant hover:text-primary transition-colors focus:outline-none"
              >
                <span className="material-symbols-outlined text-xl select-none">
                  {showPassword ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs font-semibold text-error bg-error-container border border-error/20 px-4 py-2.5 rounded-xl flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm leading-none">error</span>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full m3-btn-primary h-11 text-xs uppercase font-mono tracking-wider shadow-elevation-1"
          >
            {loading ? (
              <>
                <span className="material-symbols-outlined text-base leading-none animate-spin">autorenew</span>
                <span>Iniciando sesión...</span>
              </>
            ) : (
              <>
                <span>Acceder al Sistema</span>
                <span className="material-symbols-outlined text-base leading-none">login</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-5 border-t border-outline-variant text-center flex flex-col items-center gap-1.5">
          <span className="text-[11px] text-on-surface-variant font-mono tracking-wide">
            TrackFlow · Acceso Restringido a Personal Autorizado
          </span>
          <span className="text-[10px] text-on-surface-variant/70 font-mono">
            Autenticación Administrada por Supabase Auth
          </span>
        </div>
      </div>
    </div>
  );
}
