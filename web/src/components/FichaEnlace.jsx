import CadenaBadge from './CadenaBadge';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, isSupabaseActive } from '../supabase';
import { publicacionIdDe } from '../utils/dbClient';
import { enlaceCaido, describirPresentacion } from '../utils/presentacion';
import { limpiarNombreCapturado } from '../context/DataContext';

/**
 * Ficha de un enlace de competencia (side sheet), hermana de FichaProducto:
 * el precio de hoy frente al PVP propio, los datos del enlace y sus ultimas
 * capturas. Desde aqui se abre la tienda, se lanza el robot, se corrige el
 * precio a mano o se edita.
 */

const usd = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(2)}` : '—');
const bs = (n) => (Number(n) > 0 ? `Bs ${Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');

function haceCuanto(fecha) {
  if (!fecha) return 'sin capturas';
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  if (!Number.isFinite(dias)) return 'sin capturas';
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  return new Date(fecha).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Dato({ etiqueta, children }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2">
      <dt className="m3-body-medium text-on-surface-variant">{etiqueta}</dt>
      <dd className="m3-body-medium text-on-surface break-words min-w-0">{children || '—'}</dd>
    </div>
  );
}

export default function FichaEnlace({
  enlace: e, producto, nombreCadena, precioUsd, onClose, onEditar, onPrecioManual, onRobot, robotOcupado, onAlternarActivo,
  leyendo = false, fallos = null, duplicado = false,
}) {
  const [historial, setHistorial] = useState(null);

  useEffect(() => {
    const alPulsar = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [onClose]);

  // Ultimas capturas de esta publicacion (fact_precios admite SELECT).
  useEffect(() => {
    let vigente = true;
    const pubId = publicacionIdDe(e);
    if (!isSupabaseActive() || !pubId) { setHistorial([]); return undefined; }
    supabase
      .from('fact_precios')
      .select('id, fecha_captura, precio_full_bs, precio_desc_bs, tasa_bcv, origen, estado, sospechoso, nombre_capturado')
      .eq('publicacion_id', pubId)
      .order('fecha_captura', { ascending: false })
      .limit(15)
      .then(({ data }) => { if (vigente) setHistorial(data || []); });
    return () => { vigente = false; };
  }, [e]);

  const pvp = Number(producto?.pvp_propio_usd) || 0;
  const precio = precioUsd(e);
  const diferencia = pvp > 0 && precio > 0 ? ((pvp - precio) / precio) * 100 : null;
  const propio = e.tipo === 'propio';
  const caido = enlaceCaido(e);

  return createPortal(
    <div className="m3-modal-scrim m3-sheet-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <aside className="m3-side-sheet" role="dialog" aria-modal="true" aria-labelledby="ficha-enlace-titulo">
        <header className="flex items-start gap-3 px-6 pt-6 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id="ficha-enlace-titulo" className="m3-headline-small text-on-surface break-words">
              {propio ? (producto?.nombre || e.marca) : (e.marca || 'Competidor')}
            </h2>
            <div className="m3-body-medium text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2">
              <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={e.cadena} tamano="xs" title="" />{nombreCadena(e.cadena)}</span>
              <span aria-hidden="true">·</span>
              <span>{propio ? 'Mi producto' : 'Competidor'}</span>
              <span aria-hidden="true">·</span>
              <span className={`m3-status ${e.activo ? 'is-on' : ''}`}>{e.activo ? 'Activo' : 'De baja'}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="m3-icon-btn" aria-label="Cerrar ficha">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
          {leyendo && (
            <div className="m3-banner m3-banner-info" role="status">
              <span className="material-symbols-outlined animate-spin" aria-hidden="true">sync</span>
              <span className="m3-body-medium">El robot está leyendo este enlace. El precio nuevo aparece al terminar.</span>
            </div>
          )}
          {fallos && fallos.fallos_seguidos > 0 && (
            <div className="m3-banner" role="status">
              <span className="material-symbols-outlined" aria-hidden="true">link_off</span>
              <span className="m3-body-medium min-w-0 break-words">
                <strong>El robot falló {fallos.fallos_seguidos} {fallos.fallos_seguidos === 1 ? 'vez' : 'veces seguidas'}</strong>
                {fallos.ultimo_error ? `: ${fallos.ultimo_error}` : '.'}
                {fallos.fallos_seguidos >= 3 && ' Abre la URL: si la tienda cambió o quitó la página, edita el enlace con la dirección nueva o dalo de baja.'}
              </span>
            </div>
          )}
          {duplicado && (
            <div className="m3-banner" role="status">
              <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
              <span className="m3-body-medium">Hay otro enlace de este mismo competidor en {nombreCadena(e.cadena)} para este producto. Si es la misma página, elimina uno.</span>
            </div>
          )}
          <section aria-labelledby="fe-precio">
            <h3 id="fe-precio" className="m3-title-small text-on-surface-variant mb-2">Precio</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">En la tienda</span>
                <span className="m3-title-large text-on-surface">{usd(precio)}</span>
                <span className="m3-body-small text-on-surface-variant truncate">
                  {bs(e.ultimo_precio_desc_bs || e.ultimo_precio_full_bs)}
                </span>
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Tu PVP</span>
                <span className="m3-title-large text-on-surface">{usd(pvp)}</span>
              </div>
              <div className="m3-ficha-kpi">
                <span className="m3-label-medium text-on-surface-variant">Diferencia</span>
                <span className={`m3-title-large ${diferencia !== null && diferencia > 0 ? 'text-error' : 'text-on-surface'}`}>
                  {diferencia === null ? '—' : `${diferencia > 0 ? '+' : ''}${diferencia.toFixed(0)}%`}
                </span>
                {diferencia !== null && (
                  <span className="m3-body-small text-on-surface-variant">{diferencia > 0 ? 'tu PVP es más caro' : diferencia < 0 ? 'tu PVP es más barato' : 'igual'}</span>
                )}
              </div>
            </div>
            {e.tiene_descuento && (
              <p className="m3-body-small text-on-surface-variant mt-2">
                <span className="m3-chip-oferta mr-1">Oferta</span>
                Precio normal {bs(e.ultimo_precio_full_bs)}{e.tipo_promo ? ` · ${e.tipo_promo}` : ''}
              </p>
            )}
          </section>

          <section aria-labelledby="fe-datos">
            <h3 id="fe-datos" className="m3-title-small text-on-surface-variant mb-1">Enlace</h3>
            <dl className="divide-y divide-outline-variant">
              <Dato etiqueta="Producto">
                {producto ? `${producto.id_interno} · ${producto.nombre}${producto.concentracion ? ` ${producto.concentracion}` : ''} · ${describirPresentacion(producto)}` : e.id_producto_propio}
              </Dato>
              {!propio && <Dato etiqueta="Laboratorio">{e.laboratorio}</Dato>}
              {/* El que leyo el robot en la pagina (no el que se le puso al
                  competidor): si no se parece, el enlace apunta a otro producto. */}
              <Dato etiqueta="Nombre en la tienda">
                {historial === null ? 'Cargando…' : (limpiarNombreCapturado(historial.find(h => h.nombre_capturado)?.nombre_capturado) || 'El robot aún no lo ha leído')}
              </Dato>
              <Dato etiqueta="Última captura">
                <span className={caido ? 'm3-count-stale' : ''}>{haceCuanto(e.ultimo_scrape)}</span>
                {caido && e.activo && <span className="m3-chip-caido ml-2">Sin precio reciente</span>}
              </Dato>
              <Dato etiqueta="URL">
                <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{e.url}</a>
              </Dato>
            </dl>
          </section>

          <section aria-labelledby="fe-historial">
            <h3 id="fe-historial" className="m3-title-small text-on-surface-variant mb-2">Últimas capturas</h3>
            {historial === null ? (
              <p className="m3-body-medium text-on-surface-variant">Cargando…</p>
            ) : historial.length === 0 ? (
              <div className="m3-banner">
                <span className="material-symbols-outlined" aria-hidden="true">schedule</span>
                <span className="m3-body-medium">Todavía no hay capturas: el robot aún no leyó este enlace.</span>
              </div>
            ) : (
              <ul className="space-y-1">
                {historial.map(h => {
                  const precioBs = Number(h.precio_desc_bs) || Number(h.precio_full_bs) || 0;
                  const enUsd = precioBs && h.tasa_bcv ? precioBs / Number(h.tasa_bcv) : 0;
                  return (
                    <li key={h.id} className="m3-ficha-enlace">
                      <div className="min-w-0 flex-1">
                        <div className="m3-cell-primary">
                          {new Date(h.fecha_captura).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </div>
                        <div className="m3-cell-secondary">
                          {h.origen === 'manual' ? 'Cargado a mano' : h.estado !== 'ok' ? `Sin precio (${h.estado})` : h.sospechoso ? 'Sospechosa' : 'Robot'}
                        </div>
                      </div>
                      <div className="text-right shrink-0 pr-2">
                        <div className="m3-cell-primary tabular-nums">{usd(enUsd)}</div>
                        <div className="m3-cell-secondary tabular-nums">{bs(precioBs)}{Number(h.precio_desc_bs) > 0 && Number(h.precio_desc_bs) < Number(h.precio_full_bs) ? ' · oferta' : ''}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-outline-variant">
          <button type="button" onClick={onAlternarActivo} className="m3-btn-text mr-auto">
            <span className="material-symbols-outlined">{e.activo ? 'archive' : 'unarchive'}</span>
            {e.activo ? 'Dar de baja' : 'Reactivar'}
          </button>
          <button type="button" onClick={onRobot} disabled={robotOcupado || !e.activo} className="m3-icon-btn"
            title={leyendo ? 'Leyendo el precio…' : robotOcupado ? 'Ya hay una lectura del robot en curso' : e.activo ? 'Leer el precio ahora con el robot' : 'Reactiva el enlace para usar el robot'}
            aria-label="Leer el precio con el robot">
            <span className={`material-symbols-outlined ${leyendo ? 'animate-spin' : ''}`}>{leyendo ? 'sync' : 'smart_toy'}</span>
          </button>
          <button type="button" onClick={onPrecioManual} className="m3-btn-tonal">
            <span className="material-symbols-outlined">edit_note</span>
            Precio manual
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
