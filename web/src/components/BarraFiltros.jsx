// Barra de filtros comun (Dashboard, Mapa de Calor, ficha): dos filas
// alineadas, cada una con su rotulo.
//   Filtrar  -> chips que acotan la lista (unidad, tipo, cadenas...).
//   Comparar -> como se calcula (lista u oferta, empaque o unidad, $ o Bs...).
// `limpiar` ({ visible, onClick }) va junto al rotulo "Filtrar": asi aparecer
// o desaparecer no empuja los chips.
export default function BarraFiltros({ etiqueta = 'Filtros', filtrar, comparar, limpiar }) {
  return (
    <section className="m3-barra-filtros" aria-label={etiqueta}>
      {filtrar && (
        <div className={`m3-barra-filtros-fila ${limpiar ? 'con-limpiar' : ''}`}>
          <div className="m3-barra-filtros-rotulo">
            <span>Filtrar</span>
            {limpiar && (
              <button type="button" onClick={limpiar.onClick} className={`m3-barra-filtros-limpiar ${limpiar.visible ? '' : 'invisible'}`}
                aria-hidden={!limpiar.visible} tabIndex={limpiar.visible ? 0 : -1} title="Quitar todos los filtros">
                Limpiar
              </button>
            )}
          </div>
          <div className="m3-barra-filtros-items">{filtrar}</div>
        </div>
      )}
      {comparar && (
        <div className="m3-barra-filtros-fila">
          <span className="m3-barra-filtros-rotulo">Comparar</span>
          <div className="m3-barra-filtros-items">{comparar}</div>
        </div>
      )}
    </section>
  );
}
