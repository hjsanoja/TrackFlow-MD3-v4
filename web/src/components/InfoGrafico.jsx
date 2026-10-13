import { useEffect, useId, useRef, useState } from 'react';

// Boton (i) junto al titulo de un grafico: la explicacion, la formula, como
// leerlo y un ejemplo quedan a un toque, sin ocupar espacio fijo. La ayuda de
// toda la pantalla esta en el boton "Ayuda" de la barra de arriba.
export default function InfoGrafico({ titulo, que, formula, lectura, ejemplo, alinear = 'izquierda' }) {
  const [abierto, setAbierto] = useState(false);
  const raiz = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!raiz.current?.contains(e.target)) setAbierto(false); };
    // En captura y deteniendo: Escape cierra solo esta ayuda, no la ficha o
    // el modal que la contiene.
    const tecla = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setAbierto(false); } };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla, true);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', tecla, true); };
  }, [abierto]);

  const formulas = formula ? [].concat(formula) : [];
  return (
    <span ref={raiz} className="m3-info-grafico">
      <button type="button" className="m3-info-grafico-btn" onClick={() => setAbierto(a => !a)}
        aria-expanded={abierto} aria-controls={id} title="Cómo se calcula y cómo se lee" aria-label={`Cómo se calcula y cómo se lee: ${titulo}`}>
        <span className="material-symbols-outlined" aria-hidden="true">info</span>
      </button>
      {abierto && (
        <div id={id} role="dialog" aria-label={titulo} className={`m3-info-grafico-panel ${alinear === 'derecha' ? 'is-derecha' : ''}`}>
          <div className="flex items-start gap-2">
            <div className="m3-title-small text-on-surface flex-1">{titulo}</div>
            <button type="button" onClick={() => setAbierto(false)} className="m3-icon-btn m3-icon-btn-sm -mt-1 -mr-2" aria-label="Cerrar">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          {que && <p>{que}</p>}
          {formulas.length > 0 && (
            <div className="m3-info-grafico-formula">
              <div className="m3-label-small text-on-surface-variant">Cómo se calcula</div>
              {formulas.map(f => <code key={f}>{f}</code>)}
            </div>
          )}
          {lectura && (
            <div>
              <div className="m3-label-small text-on-surface-variant">Cómo leerlo</div>
              <p>{lectura}</p>
            </div>
          )}
          {ejemplo && (
            <div className="m3-info-grafico-ejemplo">
              <div className="m3-label-small text-on-surface-variant">Ejemplo</div>
              <p>{ejemplo}</p>
            </div>
          )}
          <p className="m3-body-small">¿Más dudas? Toca «Ayuda» arriba.</p>
        </div>
      )}
    </span>
  );
}
