import MargenPorCadena from '../components/MargenPorCadena';

// Margen por cadena: tu PSL, el precio teorico de la cadena (PSL x factor),
// el precio real ahi y el GAP frente a los laboratorios que elijas.
export default function MargenCadena() {
  return (
    <div className="space-y-5 text-on-background pb-12 animate-fade-in-slide font-sans">
      <div className="border-b border-surface-variant pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary text-3xl" aria-hidden="true">price_change</span>
          <h1 className="text-2xl lg:text-3xl font-display font-extrabold text-on-background tracking-tight">Margen por cadena</h1>
        </div>
        <p className="text-xs text-on-surface-variant">Cuánto le suma cada cadena a tu PSL y cómo queda tu precio ahí frente a los laboratorios que elijas.</p>
      </div>
      <MargenPorCadena />
    </div>
  );
}
