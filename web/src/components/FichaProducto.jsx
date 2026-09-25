import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Ficha de un producto propio en un panel lateral (side sheet de M3).
 *
 * Reune en un solo lugar lo que antes habia que buscar en tres pantallas:
 * los datos del catalogo, el PVP frente al precio mas bajo de la
 * competencia y los enlaces que vigila el scraper con su ultimo precio.
 * Para editar o ver el historial de precios se sale desde aqui.
 */

const usd = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(2)}` : '—');

// Precio que se compara: el de oferta si lo hay, si no el de lista.
export const precioEnlaceUsd = (e) => Number(e.ultimo_precio_desc_usd) || Number(e.ultimo_precio_full_usd) || 0;

// El precio mas bajo entre los enlaces de la competencia (no los propios).
export function competidorMasBarato(enlaces) {
  return (enlaces || [])
    .filter(e => String(e.tipo || '').toLowerCase() !== 'propio' && precioEnlaceUsd(e) > 0)
    .reduce((min, e) => (!min || precioEnlaceUsd(e) < precioEnlaceUsd(min) ? e : min), null);
}

function haceCuanto(fecha) {
  if (!fecha) return 'sin capturas';
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  if (!Number.isFinite(dias)) return 'sin capturas';
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  return new Date(fecha).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Dato({ etiqueta, valor }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2">
      <dt className="m3-body-medium text-on-surface-variant">{etiqueta}</dt>
      <dd className="m3-body-medium text-on-surface break-words">{valor || '—'}</dd>
    </div>
  );
}

export default function FichaProducto({ producto: p, enlaces = [], presentacion, onClose, onEditar, onDuplicar, onAnalisis, onAlternarActivo, onVincular, esCaido = () => false }) {
  // Esc cierra, como cualquier dialogo.
  useEffect(() => {
    const alPulsar = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onClose]);

  const masBarato = competidorMasBarato(enlaces);
  const pvp = Number(p.pvp_propio_usd) || 0;
  const minimo = masBarato ? precioEnlaceUsd(masBarato) : 0;
  const diferencia = pvp > 0 && minimo > 0 ? ((pvp - minimo) / minimo) * 100 : null;
  const tipo = (p.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico';

  const ordenados = [...enlaces].sort((a, b) => {
    const pa = precioEnlaceUsd(a) || Infinity;
    const pb = precioEnlaceUsd(b) || Infinity;
    return pa - pb;
  });

  // En un portal: dentro de la pagina, un ancestro con transform (la
  // animacion de entrada) descoloca cualquier position: fixed.
  return createPortal(
    <div className="m3-modal-scrim m3-sheet-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="m3-side-sheet" role="dialog" aria-modal="true" aria-labelledby="ficha-titulo">
        <header className="flex items-start gap-3 px-6 pt-6 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id="ficha-titulo" className="m3-headline-small text-on-surface break-words">{p.nombre}</h2>
            <div className="m3-body-medium text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2">
              <span className="font-mono">{p.id_interno}</span>
              <span aria-hidden="true">·</span>
              <span>{p.unidad_negocio || '—'}</span>
              <span aria-hidden="true">·</span>
              <span>{tipo}</span>
              <span aria-hidden="true">·</span>
              <span className={`m3-status ${p.activo ? 'is-on' : ''}`}>{p.activo ? 'Activo' : 'De baja'}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="m3-icon-btn" aria-label="Cerrar ficha">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
          <section aria-labelledby="ficha-precio">
            <h3 id="ficha-precio" className="m3-title-small text-on-surface-variant mb-2">Precio</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">PVP propio</span>
                <span className="m3-title-large text-on-surface">{usd(pvp)}</span>
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Competencia mín.</span>
                <span className="m3-title-large text-on-surface">{usd(minimo)}</span>
                {masBarato && <span className="m3-body-small text-on-surface-variant truncate">{masBarato.cadena}</span>}
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Diferencia</span>
                <span className={`m3-title-large ${diferencia === null ? 'text-on-surface' : diferencia > 0 ? 'text-error' : 'text-on-surface'}`}>
                  {diferencia === null ? '—' : `${diferencia > 0 ? '+' : ''}${diferencia.toFixed(0)}%`}
                </span>
                {diferencia !== null && (
                  <span className="m3-body-small text-on-surface-variant">{diferencia > 0 ? 'más caro' : diferencia < 0 ? 'más barato' : 'igual'}</span>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="ficha-datos">
            <h3 id="ficha-datos" className="m3-title-small text-on-surface-variant mb-1">Ficha</h3>
            <dl className="divide-y divide-outline-variant">
              <Dato etiqueta="Molécula" valor={p.principio_activo} />
              <Dato etiqueta="Dosis" valor={p.concentracion} />
              <Dato etiqueta="Presentación" valor={presentacion} />
              <Dato etiqueta="Laboratorio" valor={p.laboratorio} />
              <Dato etiqueta="Categoría" valor={p.categoria} />
              <Dato etiqueta="Código de barras" valor={p.codigo_barra} />
            </dl>
          </section>

          <section aria-labelledby="ficha-enlaces">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 id="ficha-enlaces" className="m3-title-small text-on-surface-variant">
                Enlaces que vigila el scraper ({enlaces.length})
              </h3>
              {onVincular && (
                <button type="button" onClick={onVincular} className="m3-btn-text" title="Vincular una URL de este producto o de un competidor">
                  <span className="material-symbols-outlined">add_link</span>
                  Vincular enlace
                </button>
              )}
            </div>
            {ordenados.length === 0 ? (
              <div className="m3-banner">
                <span className="material-symbols-outlined" aria-hidden="true">link_off</span>
                <span className="m3-body-medium">Sin enlaces: no hay precios de la competencia para este producto. Usa "Vincular enlace".</span>
              </div>
            ) : (
              <ul className="space-y-1">
                {ordenados.map((e, i) => {
                  const propio = String(e.tipo || '').toLowerCase() === 'propio';
                  return (
                    <li key={e.id || i} className="m3-ficha-enlace">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="m3-cell-primary">{e.cadena || '—'}</span>
                          {propio && <span className="m3-chip-propio">Propio</span>}
                          {e.tiene_descuento && <span className="m3-chip-oferta">Oferta</span>}
                          {esCaido(e) && <span className="m3-chip-caido" title="Más de 7 días sin precio: puede que la tienda haya cambiado o retirado la URL">Sin precio reciente</span>}
                        </div>
                        <div className="m3-cell-secondary" title={e.ultimo_nombre || e.marca || ''}>
                          {e.ultimo_nombre || e.marca || 'Sin nombre capturado'}
                          {e.laboratorio && !propio ? ` · ${e.laboratorio}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="m3-cell-primary tabular-nums">{usd(precioEnlaceUsd(e))}</div>
                        <div className="m3-cell-secondary">{haceCuanto(e.ultimo_scrape)}</div>
                      </div>
                      {e.url && (
                        <a href={e.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn"
                          title="Abrir en la tienda" aria-label={`Abrir ${e.cadena} en una pestaña nueva`}>
                          <span className="material-symbols-outlined">open_in_new</span>
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-outline-variant">
          <button type="button" onClick={onAlternarActivo} className="m3-btn-text mr-auto">
            <span className="material-symbols-outlined">{p.activo ? 'archive' : 'unarchive'}</span>
            {p.activo ? 'Dar de baja' : 'Reactivar'}
          </button>
          <button type="button" onClick={onDuplicar} className="m3-btn-text" title="Crear otra presentación a partir de esta ficha">
            <span className="material-symbols-outlined">content_copy</span>
            Duplicar
          </button>
          <button type="button" onClick={onAnalisis} className="m3-btn-tonal" disabled={enlaces.length === 0}>
            <span className="material-symbols-outlined">monitoring</span>
            Análisis de precios
          </button>
          <button type="button" onClick={onEditar} className="m3-btn-primary h-10">
            <span className="material-symbols-outlined text-base">edit</span>
            Editar
          </button>
        </footer>
      </aside>
    </div>,
    document.body
  );
}
