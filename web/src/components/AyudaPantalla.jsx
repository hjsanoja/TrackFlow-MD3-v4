import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { ayudaDe, GLOSARIO } from '../utils/ayudaMenus';
import { abrirBienvenida } from './Bienvenida';

// Boton "Ayuda" de la barra de arriba: explica la pantalla abierta (para que
// sirve, que mirar, una pregunta tipica) y las palabras que se repiten.
export default function AyudaPantalla() {
  const { pathname } = useLocation();
  const [abierta, setAbierta] = useState(false);
  const a = ayudaDe(pathname);

  useEffect(() => {
    if (!abierta) return undefined;
    const tecla = (e) => { if (e.key === 'Escape') setAbierta(false); };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [abierta]);

  return (
    <>
      <button type="button" onClick={() => setAbierta(true)} className="m3-btn-text h-9 px-3" title="Cómo usar esta pantalla" aria-haspopup="dialog">
        <span className="material-symbols-outlined" aria-hidden="true">help</span>
        <span className="hidden sm:inline">Ayuda</span>
      </button>
      {abierta && createPortal(
        <div className="m3-modal-scrim m3-sheet-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) setAbierta(false); }}>
          <aside className="m3-side-sheet" role="dialog" aria-modal="true" aria-labelledby="ayuda-titulo">
            <header className="flex items-start gap-3 px-6 pt-6 pb-2">
              <div className="min-w-0 flex-1">
                <div className="m3-label-medium text-on-surface-variant">Ayuda</div>
                <h2 id="ayuda-titulo" className="m3-headline-small text-on-surface">{a.titulo}</h2>
              </div>
              <button type="button" onClick={() => setAbierta(false)} className="m3-icon-btn" aria-label="Cerrar la ayuda">
                <span className="material-symbols-outlined">close</span>
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
              <p className="m3-body-large text-on-surface">{a.para}</p>
              <section>
                <h3 className="m3-title-small text-on-surface mb-2">Qué mirar</h3>
                <ol className="m3-ayuda-pasos">
                  {a.pasos.map((p, i) => <li key={i}>{p}</li>)}
                </ol>
              </section>
              {a.pregunta && (
                <section className="m3-ayuda-ejemplo">
                  <span className="material-symbols-outlined" aria-hidden="true">lightbulb</span>
                  <p><strong className="font-medium">Pregunta típica: </strong>{a.pregunta}</p>
                </section>
              )}
              <section>
                <h3 className="m3-title-small text-on-surface mb-2">Palabras que se repiten</h3>
                <dl className="space-y-2 m3-body-medium">
                  {GLOSARIO.map(([t, d]) => (
                    <div key={t}><dt className="font-medium text-on-surface">{t}</dt><dd className="text-on-surface-variant">{d}</dd></div>
                  ))}
                </dl>
              </section>
              <div className="flex flex-wrap gap-2 pt-2 border-t border-outline-variant">
                <button type="button" onClick={() => { setAbierta(false); abrirBienvenida(); }} className="m3-btn-outline">
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">tour</span>
                  Ver el recorrido de bienvenida
                </button>
              </div>
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
