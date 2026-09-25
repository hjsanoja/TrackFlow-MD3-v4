import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from './supabase';
import Login from './pages/Login';
import NuevaContrasena from './components/NuevaContrasena';

// El enlace de "recuperar contraseña" llega con type=recovery en la URL.
// Se mira al cargar, antes de que Supabase limpie la direccion.
const LLEGO_POR_RECUPERACION = typeof window !== 'undefined' &&
  /type=recovery/.test(`${window.location.hash}${window.location.search}`);
const esActivo = (u) => Boolean(u) && (u.activo === true || u.activo === 'si' || u.activo === 'sí');

// Carga bajo demanda: cada pantalla viaja en su propio archivo y solo se
// descarga al entrar en ella. Antes todo el panel iba en un unico bundle de
// 1,79 MB que habia que bajar entero para ver el Dashboard.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Experimental = lazy(() => import('./pages/Experimental'));
const MapaCalor = lazy(() => import('./pages/MapaCalor'));
const Productos = lazy(() => import('./pages/Productos'));
const Competencia = lazy(() => import('./pages/Competencia'));
const Cadenas = lazy(() => import('./pages/Cadenas'));
const Usuarios = lazy(() => import('./pages/Usuarios'));
const Dimensiones = lazy(() => import('./pages/Dimensiones'));
const MiCuenta = lazy(() => import('./pages/MiCuenta'));

import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, useToast } from './context/ToastContext';
import { DataProvider } from './context/DataContext';

function AppContent() {
  const [user, setUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [recuperando, setRecuperando] = useState(LLEGO_POR_RECUPERACION);
  const { addToast } = useToast();

  const syncUserSession = useCallback(async (session) => {
    if (!session?.user) {
      setUser(null);
      setUserDoc(null);
      setLoading(false);
      return;
    }

    const email = session.user.email?.toLowerCase();
    if (!email) {
      await supabase.auth.signOut();
      setUser(null);
      setUserDoc(null);
      setLoading(false);
      setAuthError('La cuenta no tiene un correo electrónico asociado.');
      return;
    }

    try {
      // Filtrar estrictamente por columna email con .eq()
      const { data: uData, error: dbError } = await supabase
        .from('usuarios')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (dbError) {
        throw dbError;
      }

      // Si el usuario no existe en la tabla usuarios o no está activo, rechazar acceso
      const isActive = esActivo(uData);
      if (!uData || !isActive) {
        await supabase.auth.signOut();
        setUser(null);
        setUserDoc(null);
        setLoading(false);
        const motivo = !uData 
          ? 'Usuario no autorizado: no estás registrado en el sistema.' 
          : 'Usuario no autorizado: tu cuenta se encuentra inactiva.';
        setAuthError(motivo);
        addToast(motivo, 'error');
        return;
      }

      // Usuario autorizado y activo según la base de datos
      setUser({ email: session.user.email, uid: session.user.id });
      setUserDoc(uData);
      setAuthError(null);
      setLoading(false);
    } catch (err) {
      console.error('Error al validar autorización del usuario:', err);
      setAuthError('Error de conexión al verificar permisos de usuario.');
      setLoading(false);
    }
  }, [addToast]);

  const checkInitialSession = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      await syncUserSession(session);
    } catch (err) {
      console.error('Error al obtener sesión inicial:', err);
      setAuthError('No se pudo verificar la sesión. Por favor reintenta.');
      setLoading(false);
    }
  }, [syncUserSession]);

  useEffect(() => {
    let isMounted = true;

    checkInitialSession();

    // Suscribirse a cambios de sesión en Supabase Auth
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isMounted) return;
      if (event === 'PASSWORD_RECOVERY') setRecuperando(true);
      // Renovar el token no cambia al usuario: no hace falta volver a leerlo.
      if (event === 'TOKEN_REFRESHED') return;
      await syncUserSession(session);
    });

    // Timeout de cortesía para advertir problemas de red si la sesión demora más de 10 segundos
    const networkTimeout = setTimeout(() => {
      if (isMounted) {
        setLoading((prevLoading) => {
          if (prevLoading) {
            setAuthError('La conexión con el servidor de autenticación está demorando más de lo esperado.');
            return false;
          }
          return false;
        });
      }
    }, 10000);

    return () => {
      isMounted = false;
      clearTimeout(networkTimeout);
      subscription?.unsubscribe();
    };
  }, [checkInitialSession, syncUserSession]);

  // Si un administrador desactiva o elimina a alguien, esa persona sale del
  // panel en unos minutos (o al volver a la pestaña), sin esperar a que
  // recargue. Tambien recoge cambios de rol o de menus.
  useEffect(() => {
    if (!user?.email) return undefined;
    let vigente = true;
    const revisar = async () => {
      const { data, error } = await supabase.from('usuarios').select('*').eq('email', user.email.toLowerCase()).maybeSingle();
      if (!vigente || error) return;
      if (!esActivo(data)) {
        await supabase.auth.signOut();
        setUser(null);
        setUserDoc(null);
        setAuthError(data ? 'Tu acceso fue desactivado por un administrador.' : 'Tu usuario fue eliminado del sistema.');
        return;
      }
      setUserDoc(prev => (JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
    };
    const alVolver = () => { if (document.visibilityState === 'visible') revisar(); };
    const t = setInterval(revisar, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', alVolver);
    return () => { vigente = false; clearInterval(t); document.removeEventListener('visibilitychange', alVolver); };
  }, [user?.email]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-mono font-bold text-primary mt-4 animate-pulse">Verificando credenciales...</p>
      </div>
    );
  }

  // Si ocurrió un error de red o timeout durante la verificación inicial
  if (authError && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4 text-on-background">
        <div className="w-full max-w-md bg-surface-container-lowest rounded-[28px] border border-outline-variant p-8 text-center space-y-6">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-error-container text-error flex items-center justify-center">
            <span className="material-symbols-outlined text-3xl">lock_person</span>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-display font-bold text-primary">Acceso Denegado</h2>
            <p className="text-xs text-on-surface-variant font-mono">{authError}</p>
          </div>
          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={() => {
                setAuthError(null);
                checkInitialSession();
              }}
              className="m3-btn-primary h-11 text-xs uppercase font-mono tracking-wider"
            >
              Reintentar Conexión
            </button>
            <a
              href="/login"
              onClick={() => setAuthError(null)}
              className="text-xs font-mono font-bold text-primary hover:underline py-2"
            >
              Ir a la pantalla de inicio de sesión
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (recuperando && user) {
    return (
      <NuevaContrasena
        email={user.email}
        onListo={() => {
          setRecuperando(false);
          window.history.replaceState(null, '', window.location.pathname);
          addToast('Contraseña guardada. Ya puedes usar la nueva al entrar.', 'success');
        }}
        onCancelar={() => { setRecuperando(false); window.history.replaceState(null, '', window.location.pathname); }}
      />
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // El rol se toma EXCLUSIVAMENTE de la tabla usuarios
  const isAdmin = userDoc?.rol === 'administrador';

  const defaultConsultaMenus = ['/', '/mapa-calor'];
  const allowedMenuIds = isAdmin
    ? ['/', '/mapa-calor', '/experimental', '/reporteria', '/analisis', '/simulador', '/hallazgos', '/productos', '/competencia', '/cadenas', '/dimensiones', '/usuarios']
    : (Array.isArray(userDoc?.menus_permitidos) && userDoc.menus_permitidos.length > 0)
      ? userDoc.menus_permitidos
      : defaultConsultaMenus;

  const isAllowed = (path) => {
    if (isAdmin) return true;
    if (path === '/experimental') {
      return allowedMenuIds.includes('/experimental') || 
             allowedMenuIds.includes('/reporteria') || 
             allowedMenuIds.includes('/analisis') || 
             allowedMenuIds.includes('/simulador') || 
             allowedMenuIds.includes('/hallazgos');
    }
    return allowedMenuIds.includes(path);
  };

  const fallbackPath = allowedMenuIds.includes('/') ? '/' : (allowedMenuIds[0] || '/mapa-calor');

  return (
    <DataProvider user={user}>
      <Layout user={user} userDoc={userDoc}>
        <Suspense fallback={
          <div className="flex items-center justify-center py-24">
            <span className="material-symbols-outlined animate-spin text-4xl text-primary">progress_activity</span>
          </div>
        }>
        <Routes>
          <Route path="/" element={isAllowed('/') ? <Dashboard user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/mapa-calor" element={isAllowed('/mapa-calor') ? <MapaCalor user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/reporteria" element={<Navigate to="/experimental?tab=reporteria" replace />} />
          <Route path="/experimental" element={isAllowed('/experimental') ? <Experimental user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/analisis" element={<Navigate to="/experimental?tab=analisis" replace />} />
          <Route path="/simulador" element={<Navigate to="/experimental?tab=simulador" replace />} />
          <Route path="/hallazgos" element={<Navigate to="/experimental?tab=hallazgos" replace />} />
          <Route path="/productos" element={isAllowed('/productos') ? <Productos /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/competencia" element={isAllowed('/competencia') ? <Competencia user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/cadenas" element={isAllowed('/cadenas') ? <Cadenas /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/dimensiones" element={isAllowed('/dimensiones') ? <Dimensiones /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/usuarios" element={isAdmin ? <Usuarios userDoc={userDoc} /> : <Navigate to={fallbackPath} replace />} />
          <Route path="/mi-cuenta" element={<MiCuenta user={user} userDoc={userDoc} onActualizado={setUserDoc} />} />
          <Route path="/login" element={<Navigate to={fallbackPath} replace />} />
          <Route path="*" element={<Navigate to={fallbackPath} replace />} />
        </Routes>
        </Suspense>
      </Layout>
    </DataProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}
