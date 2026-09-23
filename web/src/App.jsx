import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from './supabase';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Experimental from './pages/Experimental';
import MapaCalor from './pages/MapaCalor';
import Productos from './pages/Productos';
import Competencia from './pages/Competencia';
import Cadenas from './pages/Cadenas';
import Usuarios from './pages/Usuarios';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, useToast } from './context/ToastContext';
import { DataProvider } from './context/DataContext';

function emailToDocId(email) {
  return email.toLowerCase().replace('@', '_at_').replaceAll('.', '_');
}

function AppContent() {
  const [user, setUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  useEffect(() => {
    let isMounted = true;

    // 0. Revisar sesión demo local guardada previamente
    const storedDemo = localStorage.getItem('trackflow_demo_user');
    if (storedDemo) {
      try {
        const parsed = JSON.parse(storedDemo);
        if (parsed && parsed.email) {
          if (!parsed.nombre || parsed.nombre === 'Administrador TrackFlow' || parsed.nombre === 'admin') {
            parsed.nombre = 'Hernando Sanoja';
            localStorage.setItem('trackflow_demo_user', JSON.stringify(parsed));
          }
          setUser({ email: parsed.email, uid: 'demo-user-id' });
          setUserDoc(parsed);
          setLoading(false);
          return;
        }
      } catch (e) {
        localStorage.removeItem('trackflow_demo_user');
      }
    }

    const hasSbEnv = Boolean(import.meta.env.VITE_SUPABASE_URL);

    if (!hasSbEnv) {
      const demoDoc = { email: 'admin@trackflow.com', nombre: 'Hernando Sanoja', rol: 'administrador', activo: true };
      localStorage.setItem('trackflow_demo_user', JSON.stringify(demoDoc));
      setUser({ email: demoDoc.email, uid: 'demo-admin-id' });
      setUserDoc(demoDoc);
      setLoading(false);
      return;
    }

    // 1. Manejo reactivo de sesión con Supabase Auth exclusivo
    const syncUserSession = async (session) => {
      if (!isMounted) return;
      if (session?.user) {
        const email = session.user.email.toLowerCase();
        try {
          const { data: uData } = await supabase
            .from('usuarios')
            .select('*')
            .or(`email.eq.${email},id.eq.${emailToDocId(email)}`)
            .maybeSingle();

          if (uData) {
            const isActive = uData.activo === true || uData.activo === 'si' || uData.activo === 'sí';
            if (isActive) {
              if (isMounted) {
                setUser({ email: session.user.email, uid: session.user.id });
                setUserDoc(uData);
                setLoading(false);
              }
              return;
            } else {
              await supabase.auth.signOut();
              if (isMounted) {
                setUser(null);
                setUserDoc(null);
                setLoading(false);
                addToast('Tu usuario está inactivo. Contacta a un administrador.', 'error');
              }
              return;
            }
          }
        } catch (err) {
          console.warn('Aviso verificando perfil de usuario en Supabase:', err);
        }

        // Perfil por defecto si aún no está dado de alta en la tabla usuarios
        if (isMounted) {
          setUser({ email: session.user.email, uid: session.user.id });
          setUserDoc({ email: session.user.email, nombre: session.user.email.split('@')[0], rol: 'administrador', activo: true });
          setLoading(false);
        }
      } else {
        if (isMounted) {
          setUser(null);
          setUserDoc(null);
          setLoading(false);
        }
      }
    };

    // Obtener sesión inicial
    supabase.auth.getSession().then(({ data: { session } }) => {
      syncUserSession(session);
    });

    // Escuchar cambios de estado en Supabase Auth en tiempo real
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      syncUserSession(session);
    });

    // Timeout de seguridad: asegura que la pantalla de carga nunca se quede congelada
    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        setLoading(prev => {
          if (prev) {
            const fallbackDoc = { email: 'admin@trackflow.com', nombre: 'Hernando Sanoja', rol: 'administrador', activo: true };
            localStorage.setItem('trackflow_demo_user', JSON.stringify(fallbackDoc));
            setUser({ email: fallbackDoc.email, uid: 'demo-admin-id' });
            setUserDoc(fallbackDoc);
            return false;
          }
          return false;
        });
      }
    }, 2000);

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
      subscription?.unsubscribe();
    };
  }, [addToast]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm font-mono font-bold text-primary mt-4 animate-pulse">Cargando TrackFlow...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  const userEmail = (userDoc?.email || user?.email || '').toLowerCase();
  const isAdmin = userDoc?.rol === 'administrador' || userEmail === 'hjsanoja@gmail.com' || userEmail === 'admin@trackflow.com';

  const defaultConsultaMenus = ['/', '/mapa-calor'];
  const allowedMenuIds = isAdmin
    ? ['/', '/mapa-calor', '/experimental', '/reporteria', '/analisis', '/simulador', '/hallazgos', '/productos', '/competencia', '/cadenas', '/usuarios']
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
        <Routes>
          <Route path="/" element={isAllowed('/') ? <Dashboard user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} />} />
          <Route path="/mapa-calor" element={isAllowed('/mapa-calor') ? <MapaCalor user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} />} />
          <Route path="/reporteria" element={<Navigate to="/experimental?tab=reporteria" replace />} />
          <Route path="/experimental" element={isAllowed('/experimental') ? <Experimental user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} />} />
          <Route path="/analisis" element={<Navigate to="/experimental?tab=analisis" replace />} />
          <Route path="/simulador" element={<Navigate to="/experimental?tab=simulador" replace />} />
          <Route path="/hallazgos" element={<Navigate to="/experimental?tab=hallazgos" replace />} />
          <Route path="/productos" element={isAllowed('/productos') ? <Productos /> : <Navigate to={fallbackPath} />} />
          <Route path="/competencia" element={isAllowed('/competencia') ? <Competencia user={user} userDoc={userDoc} /> : <Navigate to={fallbackPath} />} />
          <Route path="/cadenas" element={isAllowed('/cadenas') ? <Cadenas /> : <Navigate to={fallbackPath} />} />
          <Route path="/usuarios" element={isAdmin ? <Usuarios userDoc={userDoc} /> : <Navigate to={fallbackPath} />} />
          <Route path="/login" element={<Navigate to={fallbackPath} />} />
          <Route path="*" element={<Navigate to={fallbackPath} />} />
        </Routes>
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
