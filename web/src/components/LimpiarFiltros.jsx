// "Limpiar filtros" siempre ocupa su lugar: si no hay filtros queda invisible
// en vez de desaparecer, asi los chips no saltan de fila al aplicar uno.
export default function LimpiarFiltros({ visible, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`m3-btn-text ${visible ? '' : 'invisible'}`}
      aria-hidden={!visible} tabIndex={visible ? 0 : -1}>
      Limpiar filtros
    </button>
  );
}
