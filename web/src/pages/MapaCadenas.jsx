import MapaPorCadena from '../components/MapaPorCadena';

// Mapa de calor (menu principal): tu precio de cada producto en cada cadena,
// coloreado por filas frente a tu precio mas bajo. Antes vivia en Experimental.
export default function MapaCadenas() {
  return (
    <div className="space-y-5 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="border-b border-surface-variant pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary text-3xl" aria-hidden="true">grid_on</span>
          <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Mapa de calor</h1>
        </div>
        <p className="text-xs text-on-surface-variant">Tu precio de cada producto en cada cadena: dónde lo venden más barato y cuánto más caro está en las demás.</p>
      </div>
      <MapaPorCadena />
    </div>
  );
}
