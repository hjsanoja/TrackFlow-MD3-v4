import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Desplegable con menu de Material 3, en lugar del <select> nativo.
 *
 * El menu nativo lo dibuja el sistema operativo: en Windows sale como una
 * lista cuadrada, mas estrecha que el campo y con el azul del sistema. Este
 * abre un menu M3 (superficie tonal, esquinas redondeadas, opcion elegida
 * resaltada con check) al menos tan ancho como el campo.
 *
 * Es un reemplazo directo: acepta los mismos hijos <option> y llama a
 * onChange con un evento de la misma forma ({ target: { value } }, siempre
 * texto, como el nativo), asi que cada pantalla sigue igual.
 */

let contador = 0;

function leerOpciones(children) {
  const opciones = [];
  Children.toArray(children).forEach(hijo => {
    if (!isValidElement(hijo)) return;
    const { value, children: etiqueta, disabled } = hijo.props;
    const texto = Array.isArray(etiqueta) ? etiqueta.join('') : etiqueta;
    opciones.push({
      valor: String(value ?? texto ?? ''),
      etiqueta: texto ?? String(value ?? ''),
      disabled: Boolean(disabled),
    });
  });
  return opciones;
}

export default function Select({
  value,
  onChange,
  children,
  className = 'm3-select',
  disabled = false,
  required = false,
  name,
  id,
  title,
  leadingIcon = null,
  'aria-label': ariaLabel,
  placeholder = 'Elegir…',
}) {
  const opciones = useMemo(() => leerOpciones(children), [children]);
  const valor = String(value ?? '');
  const elegida = opciones.find(o => o.valor === valor);
  // Los chips de filtro no cambian de ancho al cambiar de opcion.
  const anchoFijo = /m3-filter-chip|m3-rows-select/.test(className) && opciones.length <= 60;

  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(-1);
  const [pos, setPos] = useState(null);
  const botonRef = useRef(null);
  const menuRef = useRef(null);
  const listaId = useMemo(() => `m3-select-${++contador}`, []);

  const colocar = useCallback(() => {
    const b = botonRef.current?.getBoundingClientRect();
    if (!b) return;
    const alto = Math.min(320, opciones.length * 48 + 16);
    const abajo = window.innerHeight - b.bottom;
    const haciaArriba = abajo < alto + 8 && b.top > abajo;
    setPos({
      left: Math.max(8, Math.min(b.left, window.innerWidth - Math.max(b.width, 180) - 8)),
      top: haciaArriba ? undefined : b.bottom + 4,
      bottom: haciaArriba ? window.innerHeight - b.top + 4 : undefined,
      minWidth: Math.max(b.width, 180),
    });
  }, [opciones.length]);

  const abrir = () => {
    if (disabled) return;
    colocar();
    setActivo(Math.max(0, opciones.findIndex(o => o.valor === valor)));
    setAbierto(true);
  };
  const cerrar = (devolverFoco = true) => {
    setAbierto(false);
    if (devolverFoco) botonRef.current?.focus();
  };
  const elegir = (o) => {
    if (o.disabled) return;
    if (o.valor !== valor) onChange?.({ target: { value: o.valor, name }, currentTarget: { value: o.valor, name } });
    cerrar();
  };

  // Sigue al campo si se desplaza la pagina; se cierra al pulsar fuera.
  useLayoutEffect(() => {
    if (!abierto) return undefined;
    const alMover = () => colocar();
    const alPulsar = (e) => {
      if (menuRef.current?.contains(e.target) || botonRef.current?.contains(e.target)) return;
      cerrar(false);
    };
    window.addEventListener('scroll', alMover, true);
    window.addEventListener('resize', alMover);
    document.addEventListener('mousedown', alPulsar);
    return () => {
      window.removeEventListener('scroll', alMover, true);
      window.removeEventListener('resize', alMover);
      document.removeEventListener('mousedown', alPulsar);
    };
  }, [abierto, colocar]);

  // La opcion activa siempre a la vista.
  useEffect(() => {
    if (!abierto || activo < 0) return;
    menuRef.current?.querySelector(`[data-indice="${activo}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [abierto, activo]);

  const moverA = (desde, paso) => {
    for (let i = 1; i <= opciones.length; i++) {
      const j = (desde + paso * i + opciones.length) % opciones.length;
      if (!opciones[j].disabled) return j;
    }
    return desde;
  };

  const alTeclear = (e) => {
    if (!abierto) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); abrir(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(); }
    else if (e.key === 'Tab') cerrar(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActivo(a => moverA(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActivo(a => moverA(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActivo(moverA(-1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setActivo(moverA(opciones.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opciones[activo]) elegir(opciones[activo]); }
    else if (e.key.length === 1) {
      // Saltar a la siguiente opcion que empieza por esa letra.
      const letra = e.key.toLowerCase();
      const j = opciones.findIndex((o, i) => i > activo && String(o.etiqueta).toLowerCase().startsWith(letra));
      const k = j >= 0 ? j : opciones.findIndex(o => String(o.etiqueta).toLowerCase().startsWith(letra));
      if (k >= 0) setActivo(k);
    }
  };

  return (
    <>
      <button
        ref={botonRef}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        className={`${className} m3-select-trigger ${abierto ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls={abierto ? listaId : undefined}
        aria-label={ariaLabel}
        onClick={() => (abierto ? cerrar() : abrir())}
        onKeyDown={alTeclear}
      >
        {leadingIcon && <span className="material-symbols-outlined m3-select-lead" aria-hidden="true">{leadingIcon}</span>}
        {anchoFijo ? (
          // Todas las opciones ocupan la misma celda (invisibles salvo la
          // elegida): el campo mide lo que la mas larga y no cambia de ancho
          // al elegir otra, asi no empuja a los de al lado.
          <span className="m3-select-value m3-select-stack">
            {opciones.map((o, i) => (
              <span key={`${o.valor}-${i}`} aria-hidden={o.valor !== valor || undefined} className={o.valor === valor ? '' : 'is-oculta'}>{o.etiqueta}</span>
            ))}
            {!elegida && <span className="is-placeholder">{placeholder}</span>}
          </span>
        ) : (
          <span className={`m3-select-value ${elegida ? '' : 'is-placeholder'}`}>{elegida ? elegida.etiqueta : placeholder}</span>
        )}
        <span className="material-symbols-outlined m3-select-arrow" aria-hidden="true">arrow_drop_down</span>
      </button>
      {/* Para que `required` siga funcionando en los formularios. */}
      {required && (
        <input tabIndex={-1} aria-hidden="true" className="m3-select-required" required value={valor} onChange={() => {}} name={name} />
      )}
      {abierto && pos && createPortal(
        <ul
          ref={menuRef}
          id={listaId}
          role="listbox"
          aria-label={ariaLabel}
          className="m3-menu-list"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.minWidth }}
          onKeyDown={alTeclear}
        >
          {opciones.map((o, i) => {
            const sel = o.valor === valor;
            return (
              <li
                key={`${o.valor}-${i}`}
                data-indice={i}
                role="option"
                aria-selected={sel}
                aria-disabled={o.disabled || undefined}
                className={`m3-menu-option ${sel ? 'is-selected' : ''} ${i === activo ? 'is-active' : ''} ${o.disabled ? 'is-disabled' : ''}`}
                onMouseEnter={() => setActivo(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => elegir(o)}
              >
                <span className="material-symbols-outlined m3-menu-check" aria-hidden="true">{sel ? 'check' : ''}</span>
                <span className="truncate">{o.etiqueta}</span>
              </li>
            );
          })}
        </ul>,
        document.body
      )}
    </>
  );
}
