import { useEffect, useId, useRef, useState } from 'react';

// Boton (i) junto al titulo de un grafico: la explicacion, la formula y como
// leerlo quedan a un toque, sin ocupar espacio fijo sobre el grafico.
export default function InfoGrafico({ titulo, que, formula, lectura, alinear = 'izquierda' }) {
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
          <div className="m3-title-small text-on-surface">{titulo}</div>
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
        </div>
      )}
    </span>
  );
}
