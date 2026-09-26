// Boton segmentado de Material 3 (seleccion unica): para elegir entre 2 a 5
// opciones fijas que se ven todas a la vez (precio de lista u oferta, $ o
// Bs...). La elegida lleva check y fondo tonal. Flechas izquierda/derecha
// mueven la seleccion.
export default function Segmentado({ etiqueta, rotulo, valor, onChange, opciones }) {
  const mover = (e, i) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const siguiente = opciones[(i + (e.key === 'ArrowRight' ? 1 : opciones.length - 1)) % opciones.length];
    onChange(siguiente[0]);
    e.currentTarget.parentElement.children[opciones.indexOf(siguiente)]?.focus();
  };
  const grupo = (
    <div className="m3-segmentado" role="radiogroup" aria-label={etiqueta} title={etiqueta}>
      {opciones.map(([v, texto, titulo], i) => {
        const activo = String(v) === String(valor);
        return (
          <button key={v} type="button" role="radio" aria-checked={activo} tabIndex={activo ? 0 : -1}
            className={activo ? 'is-activo' : ''} onClick={() => onChange(v)} onKeyDown={e => mover(e, i)} title={titulo}>
            {activo && <span className="material-symbols-outlined" aria-hidden="true">check</span>}
            {texto}
          </button>
        );
      })}
    </div>
  );
  // Rotulo corto a la izquierda cuando las opciones solas no se explican.
  if (!rotulo) return grupo;
  return (
    <span className="m3-segmentado-con-rotulo">
      <span className="m3-segmentado-rotulo" aria-hidden="true">{rotulo}</span>
      {grupo}
    </span>
  );
}
