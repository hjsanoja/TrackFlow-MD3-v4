import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';
import { supabase } from '../supabase';

export default function Login() {
  const [email, setEmail] = useState('admin@trackflow.com');
  const [password, setPassword] = useState('demo1234');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleDemoLogin = () => {
    const rawName = email.split('@')[0] || '';
    const nameToUse = (!rawName || rawName === 'admin' || rawName.toLowerCase().includes('administrador')) ? 'Hernando Sanoja' : rawName;
    const demoDoc = {
      email: email.trim() || 'admin@trackflow.com',
      nombre: nameToUse,
      rol: 'administrador',
      activo: true
    };
    localStorage.setItem('trackflow_demo_user', JSON.stringify(demoDoc));
    window.location.reload();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const hasSupabase = Boolean(import.meta.env.VITE_SUPABASE_URL);

    // 1. Intentar inicio de sesión con Supabase Auth si está configurado
    if (hasSupabase) {
      try {
        const { data, error: sbError } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password: password,
        });

        if (!sbError && data?.user) {
          setLoading(false);
          return;
        }
      } catch (err) {
        console.warn('Fallback por aviso de Supabase Auth:', err?.message);
      }
    }

    // 2. Fallback a Firebase Auth si está disponible
    if (auth) {
      try {
        await signInWithEmailAndPassword(auth, email, password);
        setLoading(false);
        return;
      } catch (err) {
        console.warn('Firebase login attempt failed, switching to local session mode:', err?.message);
      }
    }

    // 3. Fallback a Sesión Demo
    handleDemoLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
      <div className="w-full max-w-md bg-white rounded-[32px] border border-outline-variant p-10 shadow-sm space-y-8">
        <div className="text-center space-y-2">
          {/* Elegant Logo / Icon Header */}
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
              placeholder="admin@trackflow.com"
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
                <span>Iniciando...</span>
              </>
            ) : (
              <>
                <span>Acceder al Sistema</span>
                <span className="material-symbols-outlined text-base leading-none">login</span>
              </>
            )}
          </button>
        </form>

        {/* Developer attribution & Version */}
        <div className="pt-5 border-t border-outline-variant text-center flex flex-col items-center gap-1.5">
          <span className="text-[11px] text-on-surface-variant font-mono tracking-wide">
            Desarrollador: <span className="font-bold text-primary">Hernando Sanoja</span>
          </span>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] text-primary/90 font-mono font-bold uppercase tracking-widest bg-primary-container px-2.5 py-0.5 rounded-full border border-primary/10">
              M3 Expressive Activo
            </span>
            <span className="text-[10px] text-on-surface-variant/70 font-mono">
              V7.4.0 · Material 3 Expressive & Física Cinemática
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

