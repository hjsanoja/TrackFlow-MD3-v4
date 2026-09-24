import { useMemo, useState } from 'react';

// Piezas de formulario M3 compartidas (Productos, Competencia).

// Normaliza para comparar sin mayusculas ni tildes.
export const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function FormSection({ titulo, icono, children }) {
  return (
    <fieldset className="m3-form-section">
      <legend className="m3-form-section-title">
        <span className="material-symbols-outlined" aria-hidden="true">{icono}</span>
        {titulo}
      </legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

export function Field({ label, hint, error, aviso, requerido, children }) {
  return (
    <div className={`m3-field ${error ? 'has-error' : ''}`}>
      <label className="m3-field-label">
        {label}{requerido && <span className="text-error" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="m3-field-support text-error" role="alert">{error}</p>
      ) : aviso ? (
        <p className="m3-field-support m3-field-warning">{aviso}</p>
      ) : hint ? (
        <p className="m3-field-support">{hint}</p>
      ) : null}
    </div>
  );
}

// Opciones cerradas y pocas (unidad de negocio, tipo): todas a la vista, un
// clic. Sin nada elegido por defecto.
export function ChoiceChips({ valor, onChange, opciones, nombre }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {opciones.map(([v, texto]) => {
        const activo = normalizar(valor) === normalizar(v);
        return (
          <label key={v} className={`m3-choice-chip ${activo ? 'is-selected' : ''}`}>
            <input type="radio" name={nombre} value={v} checked={activo} onChange={() => onChange(v)} className="sr-only" />
            {activo && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
            {texto}
          </label>
        );
      })}
    </div>
  );
}

// Campo con lista desplegable propia. El <datalist> del navegador filtra por
// lo ya escrito: con "La Sante" puesto solo ofrecia "La Sante" y parecia que
// no se podia elegir otra cosa. Aqui, al abrir, se ven todas las opciones; se
// filtra solo cuando el usuario escribe algo distinto.
export function ComboField({ value, onChange, opciones = [], cargando = false, permitirNuevo = false, placeholder = '' }) {
  const [abierto, setAbierto] = useState(false);
  const [escrito, setEscrito] = useState(false);
  const [activo, setActivo] = useState(-1);
  const listaId = useMemo(() => `combo-${Math.random().toString(36).slice(2, 9)}`, []);

  const filtradas = useMemo(() => {
    const q = normalizar(value);
    const lista = escrito && q ? opciones.filter(o => normalizar(o).includes(q)) : opciones;
    return lista.slice(0, 80);
  }, [opciones, value, escrito]);

  const existe = opciones.some(o => normalizar(o) === normalizar(value));

  const elegir = (v) => {
    onChange(v);
    setAbierto(false);
    setEscrito(false);
    setActivo(-1);
  };

  const alPulsar = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAbierto(true); setActivo(i => Math.min(i + 1, filtradas.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActivo(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && abierto && activo >= 0 && filtradas[activo]) { e.preventDefault(); elegir(filtradas[activo]); }
    else if (e.key === 'Escape' && abierto) { e.stopPropagation(); setAbierto(false); }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={abierto}
        aria-controls={listaId}
        aria-autocomplete="list"
        onChange={e => { onChange(e.target.value); setEscrito(true); setAbierto(true); setActivo(-1); }}
        onFocus={() => { setAbierto(true); setEscrito(false); }}
        onClick={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 120)}
        onKeyDown={alPulsar}
        className="m3-input pr-10"
        autoComplete="off"
      />
      <span className="material-symbols-outlined m3-combo-arrow" aria-hidden="true">arrow_drop_down</span>
      {abierto && (
        <ul id={listaId} role="listbox" className="m3-combo-list">
          {cargando && opciones.length === 0 && <li className="m3-combo-empty">Cargando opciones…</li>}
          {filtradas.map((o, i) => (
            <li key={o} role="option" aria-selected={normalizar(o) === normalizar(value)}
              onMouseDown={e => { e.preventDefault(); elegir(o); }}
              className={`m3-combo-option ${i === activo ? 'is-active' : ''} ${normalizar(o) === normalizar(value) ? 'is-selected' : ''}`}>
              {o}
              {normalizar(o) === normalizar(value) && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
            </li>
          ))}
          {!cargando && filtradas.length === 0 && !permitirNuevo && <li className="m3-combo-empty">Sin coincidencias</li>}
          {permitirNuevo && value.trim() && !existe && (
            <li className="m3-combo-empty">Se creará «{value.trim()}» al guardar</li>
          )}
        </ul>
      )}
    </div>
  );
}
