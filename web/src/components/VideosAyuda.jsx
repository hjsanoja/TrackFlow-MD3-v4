import { useState } from 'react';

// Videos de ayuda (Experimental): se graban solos con datos de ejemplo
// (demo/grabar.mjs) y se guardan en public/videos. Cuando una pantalla cambia,
// se vuelven a grabar con el mismo guion.
const VIDEOS = [
  { id: 'dashboard', titulo: 'Dashboard', icono: 'dashboard', desc: 'Indicadores, gráficos, la tabla de precios por cadena y cómo exportarla.' },
  { id: 'rango', titulo: 'Rango de precios', icono: 'linear_scale', desc: 'Dónde cae tu precio entre el más barato y el más caro del mercado.' },
  { id: 'mapa', titulo: 'Mapa de calor', icono: 'grid_on', desc: 'Tu precio en cada cadena y qué cadena te encarece.' },
  { id: 'margen', titulo: 'Margen por cadena', icono: 'price_change', desc: 'PSL, precio teórico, margen real y GAP frente a los laboratorios.' },
];

export default function VideosAyuda() {
  const [actual, setActual] = useState(VIDEOS[0].id);
  const video = VIDEOS.find(v => v.id === actual);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4">
      <ul className="space-y-2" aria-label="Videos">
        {VIDEOS.map(v => (
          <li key={v.id}>
            <button type="button" onClick={() => setActual(v.id)} aria-current={actual === v.id ? 'true' : undefined}
              className={`w-full text-left flex items-start gap-3 rounded-2xl p-3 border ${actual === v.id ? 'bg-secondary-container border-transparent' : 'border-outline-variant hover:bg-surface-container-low'}`}>
              <span className="material-symbols-outlined text-primary" aria-hidden="true">{v.icono}</span>
              <span className="min-w-0">
                <span className="block m3-title-small text-on-surface">{v.titulo}</span>
                <span className="block m3-body-small text-on-surface-variant">{v.desc}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <section className="m3-dash-card" aria-label={`Video: ${video.titulo}`}>
        <video key={video.id} src={`${import.meta.env.BASE_URL}videos/${video.id}.webm`} controls preload="metadata"
          className="w-full rounded-2xl bg-black aspect-video" />
        <p className="m3-body-small text-on-surface-variant mt-2">
          Videos de unos 40 segundos, sin audio, con subtítulos. Usan datos de ejemplo: los precios no son reales.
        </p>
      </section>
    </div>
  );
}
