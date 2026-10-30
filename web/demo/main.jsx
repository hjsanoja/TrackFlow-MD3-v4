import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../src/index.css';
import { ToastProvider } from '../src/context/ToastContext';
import Layout from '../src/components/Layout';
import { VERSION } from '../src/utils/version';
import Dashboard from '../src/pages/Dashboard';
import MapaCalor from '../src/pages/MapaCalor';
import MapaCadenas from '../src/pages/MapaCadenas';
import MargenCadena from '../src/pages/MargenCadena';

// Pantallas con datos de ejemplo para grabar los videos (demo/grabar.mjs).
const PANTALLAS = { dashboard: ['/', Dashboard], rango: ['/mapa-calor', MapaCalor], mapa: ['/mapa-cadenas', MapaCadenas], margen: ['/margen-cadena', MargenCadena] };
const [ruta, Pantalla] = PANTALLAS[new URLSearchParams(location.search).get('p')] || PANTALLAS.dashboard;
const userDoc = { email: 'demo@trackflow', nombre: 'Demo', rol: 'consulta', activo: true, menus_permitidos: ['/', '/mapa-calor', '/mapa-cadenas', '/margen-cadena'] };
// Sin el recorrido de bienvenida en los videos.
try { localStorage.setItem(`trackflow.bienvenida.${VERSION}.${userDoc.email}`, '1'); } catch { /* sin almacenamiento */ }
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[ruta]}>
    <ToastProvider>
      <Layout user={{ email: userDoc.email }} userDoc={userDoc}><Pantalla userDoc={userDoc} /></Layout>
    </ToastProvider>
  </MemoryRouter>,
);
