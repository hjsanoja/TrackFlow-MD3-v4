import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { VERSION, ETIQUETA_VERSION } from '../utils/version';

// Recorrido de bienvenida: se abre solo la primera vez que alguien entra (por
// correo y version, guardado en este navegador) y desde Ayuda o Mi cuenta.
const EVENTO = 'trackflow:bienvenida';
export const abrirBienvenida = () => window.dispatchEvent(new Event(EVENTO));

const PASOS = [
  { icono: 'waving_hand', titulo: 'Bienvenido a TrackFlow', texto: 'Cada día un robot lee los precios de tus productos y los de la competencia en las farmacias en línea. Aquí los ves ordenados.' },
  { icono: 'dashboard', titulo: 'Dashboard', texto: 'La foto del día: en cuántos productos estás más barato, parejo o más caro que el mercado, y qué cambió desde tu última visita.', ir: '/' },
  { icono: 'linear_scale', titulo: 'Rango de precios', texto: 'Todos los precios del mercado de cada producto, del más barato al más caro, y un punto con el tuyo.', ir: '/mapa-calor' },
  { icono: 'grid_on', titulo: 'Mapa de calor', texto: 'Tu precio en cada cadena. Azul es donde ese producto está más barato; rojo, donde está más caro.', ir: '/mapa-cadenas' },
  { icono: 'help', titulo: '¿Dudas?', texto: 'El botón «Ayuda» de arriba explica cada pantalla, y el botón i junto a cada gráfico dice cómo leerlo.' },
];

export default function Bienvenida({ email, menus }) {
  const navigate = useNavigate();
  const [paso, setPaso] = useState(null); // null = cerrado
  const clave = `trackflow.bienvenida.${VERSION}.${String(email || '').toLowerCase()}`;
  // Solo los pasos de menus que la persona puede abrir.
  const pasos = PASOS.filter(p => !p.ir || !menus || menus.includes(p.ir));

  useEffect(() => {
    try { if (email && !localStorage.getItem(clave)) setPaso(0); } catch { /* sin almacenamiento */ }
    const abrir = () => setPaso(0);
    window.addEventListener(EVENTO, abrir);
    return () => window.removeEventListener(EVENTO, abrir);
  }, [clave, email]);

  if (paso === null) return null;
  const cerrar = () => { try { localStorage.setItem(clave, '1'); } catch { /* nada */ } setPaso(null); };
  const p = pasos[paso];
  const ultimo = paso === pasos.length - 1;

  return createPortal(
    <div className="m3-modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) cerrar(); }}>
      <div className="m3-bienvenida" role="dialog" aria-modal="true" aria-labelledby="bienvenida-titulo">
        <div className="m3-bienvenida-icono"><span className="material-symbols-outlined" aria-hidden="true">{p.icono}</span></div>
        <h2 id="bienvenida-titulo" className="m3-headline-small text-on-surface">{p.titulo}</h2>
        <p className="m3-body-large text-on-surface-variant">{p.texto}</p>
        {paso === 0 && <span className="m3-etiqueta is-primary self-center">v{VERSION} · {ETIQUETA_VERSION}</span>}
        <div className="m3-bienvenida-puntos" aria-label={`Paso ${paso + 1} de ${pasos.length}`}>
          {pasos.map((_, i) => <i key={i} className={i === paso ? 'is-activo' : ''} />)}
        </div>
        <div className="flex items-center gap-2 w-full">
          <button type="button" onClick={cerrar} className="m3-btn-text mr-auto">Saltar</button>
          {p.ir && <button type="button" onClick={() => navigate(p.ir)} className="m3-btn-text">Abrir</button>}
          {paso > 0 && <button type="button" onClick={() => setPaso(paso - 1)} className="m3-btn-outline h-10 px-4">Atrás</button>}
          <button type="button" onClick={() => (ultimo ? cerrar() : setPaso(paso + 1))} className="m3-btn-primary h-10 px-5">
            {ultimo ? 'Empezar' : 'Siguiente'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
