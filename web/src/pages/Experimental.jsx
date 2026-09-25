import { useSearchParams } from 'react-router-dom';
import DevaluacionReal from './DevaluacionReal';
import RevisionCapturas from './RevisionCapturas';
import Simulador from './Simulador';
import CanibalizacionInterna from '../components/CanibalizacionInterna';
import BrechaHistoricaUsd from '../components/BrechaHistoricaUsd';
import MapaPorCadena from '../components/MapaPorCadena';

// Herramientas en prueba. Lo que ya existe en otros menus salio de aqui:
// Reporteria (la tabla "Precios por cadena" del Dashboard con Exportar),
// Analisis (indicadores, "¿Donde esta tu precio?" y "Mas caros que el minimo")
// y Hallazgos (esas mismas alertas, la vista por molecula y los cambios).
const TABS = [
  { id: 'revision', nombre: 'Revisión de capturas', icono: 'rule', desc: 'Capturas que el control de calidad marcó como dudosas y aún nadie ha revisado.' },
  { id: 'devaluacion', nombre: 'Devaluación vs subida real', icono: 'currency_exchange', desc: 'Separa cuánto de una subida de precio fue la tasa BCV y cuánto una decisión de la cadena.' },
  { id: 'canibalizacion', nombre: 'Canibalización de marcas', icono: 'compare_arrows', desc: 'Tus genéricos y tus marcas de la misma molécula: brechas invertidas o demasiado cortas.' },
  { id: 'brecha_usd', nombre: 'Brechas USD diarias', icono: 'payments', desc: 'La brecha de cada producto día a día, con la tasa oficial de cada día.' },
  { id: 'mapa_cadenas', nombre: 'Mapa por cadena', icono: 'grid_on', desc: 'Productos × cadenas: en qué cadenas eres más caro o más barato, celda por celda.' },
  { id: 'simulador', nombre: 'Simulador de precios', icono: 'calculate', desc: 'Qué pasaría con tu posición si subes o bajas tus precios.' },
];

export default function Experimental({ user, userDoc }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const pedida = searchParams.get('tab');
  const activa = TABS.some(t => t.id === pedida) ? pedida : 'canibalizacion';
  const tab = TABS.find(t => t.id === activa);

  return (
    <div className="space-y-6 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-surface-variant pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary text-3xl">science</span>
            <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Experimental</h1>
          </div>
          <p className="text-xs text-on-surface-variant">Herramientas en prueba antes de pasar a su propio menú. {tab.desc}</p>
        </div>
      </div>

      <nav className="m3-tabs" aria-label="Herramientas experimentales">
        {TABS.map(t => (
          <button key={t.id} type="button" onClick={() => setSearchParams({ tab: t.id })} aria-current={activa === t.id ? 'page' : undefined}
            className={`m3-tab ${activa === t.id ? 'is-active' : ''}`}>
            <span className="material-symbols-outlined" aria-hidden="true">{t.icono}</span>
            {t.nombre}
          </button>
        ))}
      </nav>

      <div>
        {activa === 'revision' && <RevisionCapturas />}
        {activa === 'devaluacion' && <DevaluacionReal />}
        {activa === 'canibalizacion' && <CanibalizacionInterna user={user} userDoc={userDoc} />}
        {activa === 'brecha_usd' && <BrechaHistoricaUsd user={user} userDoc={userDoc} />}
        {activa === 'mapa_cadenas' && <MapaPorCadena />}
        {activa === 'simulador' && <Simulador user={user} userDoc={userDoc} />}
      </div>
    </div>
  );
}
