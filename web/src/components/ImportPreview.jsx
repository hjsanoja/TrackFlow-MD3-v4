import ModalWrapper from './ModalWrapper';

/**
 * Informe de validación de un CSV, antes de escribir nada.
 *
 * Antes la importación escribía directo y al terminar solo decía cuántas
 * filas habían entrado. Si algo iba mal, no había forma de saber qué fila ni
 * por qué. Aquí se ve el recuento, cada problema con su número de fila y su
 * motivo, y solo entonces se decide si continuar.
 */
export default function ImportPreview({ informe, nombreArchivo, onConfirmar, onCancelar, importando }) {
  if (!informe) return null;

  const { errores, avisos, filasValidas, total } = informe;
  const hayBloqueantes = errores.length > 0;
  const puedeImportar = filasValidas.length > 0;

  return (
    <ModalWrapper
      isOpen={true}
      onClose={onCancelar}
      title="Revisión del archivo"
      icon={hayBloqueantes ? 'error' : avisos.length ? 'warning' : 'task_alt'}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onCancelar} className="m3-btn-outline h-10 px-5 text-label-lg">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={!puedeImportar || importando}
            className="m3-btn-primary h-10 px-5 text-label-lg disabled:opacity-38 disabled:cursor-not-allowed"
          >
            {importando
              ? 'Importando...'
              : `Importar ${filasValidas.length} ${filasValidas.length === 1 ? 'fila' : 'filas'}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-body-sm text-on-surface-variant">
          <span className="font-mono font-bold text-on-surface">{nombreArchivo}</span>
        </p>

        {/* Recuento */}
        <div className="grid grid-cols-3 gap-3">
          <div className="m3-card-filled p-3 text-center">
            <div className="text-title-lg font-bold text-on-surface">{total}</div>
            <div className="text-label-sm text-on-surface-variant">Filas leídas</div>
          </div>
          <div className="m3-card-filled p-3 text-center">
            <div className="text-title-lg font-bold text-[color:var(--md-sys-color-data-positive)]">
              {filasValidas.length}
            </div>
            <div className="text-label-sm text-on-surface-variant">Se importarán</div>
          </div>
          <div className="m3-card-filled p-3 text-center">
            <div className={`text-title-lg font-bold ${errores.length ? 'text-error' : 'text-on-surface-variant'}`}>
              {errores.length}
            </div>
            <div className="text-label-sm text-on-surface-variant">Con error</div>
          </div>
        </div>

        {hayBloqueantes && (
          <Lista
            titulo={`${errores.length} ${errores.length === 1 ? 'fila no se importará' : 'filas no se importarán'}`}
            icono="error"
            tono="error"
            items={errores}
          />
        )}

        {avisos.length > 0 && (
          <Lista
            titulo={`${avisos.length} ${avisos.length === 1 ? 'aviso' : 'avisos'} (no impiden importar)`}
            icono="info"
            tono="warning"
            items={avisos}
          />
        )}

        {!hayBloqueantes && avisos.length === 0 && (
          <div className="flex items-center gap-2 text-body-sm text-[color:var(--md-sys-color-data-positive)]">
            <span className="material-symbols-outlined text-[20px]">task_alt</span>
            El archivo no tiene problemas.
          </div>
        )}

        {!puedeImportar && (
          <p className="text-body-sm text-error">
            Ninguna fila se puede importar. Corrige el archivo y vuelve a subirlo.
          </p>
        )}
      </div>
    </ModalWrapper>
  );
}

function Lista({ titulo, icono, tono, items }) {
  const color = tono === 'error' ? 'text-error' : 'text-[color:var(--md-sys-color-tertiary)]';
  // Se muestran las primeras 50: más allá, la lista deja de ser útil y lo que
  // toca es corregir el archivo de origen.
  const visibles = items.slice(0, 50);

  return (
    <div className="m3-card-outlined">
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant ${color}`}>
        <span className="material-symbols-outlined text-[20px]">{icono}</span>
        <span className="text-label-lg font-bold">{titulo}</span>
      </div>
      <div className="max-h-56 overflow-auto divide-y divide-outline-variant/40">
        {visibles.map((e, i) => (
          <div key={i} className="px-4 py-2 flex items-start gap-3 text-body-sm">
            <span className="font-mono text-label-md text-on-surface-variant shrink-0 pt-0.5 w-16">
              {e.fila > 0 ? `Fila ${e.fila}` : '—'}
            </span>
            <span className="min-w-0">
              {e.campo && <span className="font-semibold text-on-surface">{e.campo}: </span>}
              <span className="text-on-surface-variant">{e.mensaje}</span>
            </span>
          </div>
        ))}
        {items.length > visibles.length && (
          <div className="px-4 py-2 text-label-md text-on-surface-variant">
            y {items.length - visibles.length} más…
          </div>
        )}
      </div>
    </div>
  );
}
