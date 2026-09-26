import ModalWrapper from './ModalWrapper';

// Detalle de un indicador o de una barra del Dashboard: la lista de productos
// (o de cambios de precio) que hay detras del numero. Cada fila abre la ficha
// del producto.
//
// columnas: [{ titulo, celda: fila => nodo, alinear: 'right' | 'left' }]
export default function DetalleLista({ titulo, subtitulo, icono, filas, columnas, claveFila, onFila, vacio, onVerEnTabla, onClose, ancho = 'max-w-3xl' }) {
  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title={titulo}
      subtitle={subtitulo}
      icon={icono}
      maxWidth={ancho}
      footer={(
        <>
          {onVerEnTabla && filas.length > 0 && (
            <button type="button" onClick={onVerEnTabla} className="m3-btn-text">
              <span className="material-symbols-outlined text-base">table_rows</span>
              <span>Ver en la tabla</span>
            </button>
          )}
          <button type="button" onClick={onClose} className="m3-btn-primary">Cerrar</button>
        </>
      )}
    >
      {filas.length === 0 ? (
        <div className="py-10 text-center text-on-surface-variant flex flex-col items-center gap-2">
          <span className="material-symbols-outlined text-3xl" aria-hidden="true">check_circle</span>
          <div className="m3-body-large">{vacio || 'No hay productos en este grupo.'}</div>
        </div>
      ) : (
        <div className="overflow-auto max-h-[60vh] rounded-2xl border border-outline-variant">
          <table className="m3-table m3-table-detalle m3-table-apilada">
            <thead className="m3-sticky-header">
              <tr>
                {columnas.map(c => (
                  <th key={c.titulo} className={c.alinear === 'right' ? 'text-right' : ''}>{c.titulo}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map(f => (
                <tr key={claveFila(f)} onClick={() => onFila(f)} className="cursor-pointer"
                  tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onFila(f); }}>
                  {columnas.map(c => (
                    <td key={c.titulo} data-label={c.titulo} className={c.alinear === 'right' ? 'text-right whitespace-nowrap' : ''}>{c.celda(f)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filas.length > 0 && (
        <p className="m3-body-small text-on-surface-variant mt-3">
          {filas.length} {filas.length === 1 ? 'fila' : 'filas'} · toca una para ver la ficha del producto.
        </p>
      )}
    </ModalWrapper>
  );
}
