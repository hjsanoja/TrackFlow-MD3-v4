import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StatCard from '../StatCard';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { useData } from '../../context/DataContext';
import { useToast } from '../../context/ToastContext';
import { useBcvRate } from '../../hooks/useBcvRate';
import { supabase, isSupabaseActive } from '../../supabase';
import { normalizar } from '../formulario';
import { describirPresentacion } from '../../utils/presentacion';
import { haceCuanto, fechaHora } from '../../utils/usuarios';
import { exportToCSV } from '../../utils/exportUtils';
import { parseCSV, getRowValue, leerArchivoCsv } from '../../utils/csvParser';
import { EstadoAnalisis } from './Estados';

// Precio minimo permitido (fase 46): el precio mas bajo al que aceptas que
// una cadena venda TU producto, en dolares. Se fija aqui, producto por
// producto o con un CSV (id_interno, precio_minimo_usd). Alerta cuando el
// precio de venta de tu enlace (la oferta si hay, si no el de lista) queda
// por debajo. No es el PVP: el PVP sigue sin entrar en ningun calculo.
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const usd = (v) => (v == null || isNaN(v) ? '—' : `$${Number(v).toFixed(2)}`);
const numero = (t) => {
  const v = Number(String(t ?? '').trim().replace(/\s|\$/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 10000) / 10000 : null;
};

async function correoActual() {
  try { return (await supabase.auth.getSession()).data.session?.user?.email || null; } catch { return null; }
}

export default function PrecioMinimo() {
  const { productos = [], productosCompetencia = [], cadenas = [] } = useData() || {};
  const { addToast } = useToast();
  const bcv = useBcvRate();
  const [minimos, setMinimos] = useState(new Map());   // producto_id -> minimo_usd
  const [alertas, setAlertas] = useState([]);
  const [estado, setEstado] = useState({ cargando: true, error: null, faltaSql: false });
  const [mostrar, setMostrar] = useState('todos');       // todos | con_minimo | sin_minimo | debajo
  const [busqueda, setBusqueda] = useState('');
  const [guardando, setGuardando] = useState(null);
  const archivoRef = useRef(null);

  const nombreCadena = useMemo(() => {
    const m = new Map((cadenas || []).map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setEstado({ cargando: false, error: null, faltaSql: false }); return; }
    setEstado(e => ({ ...e, cargando: true }));
    const [m, a] = await Promise.all([
      supabase.from('precio_minimo').select('producto_id, minimo_usd'),
      supabase.from('v_precio_minimo_alertas').select('*').order('dif_pct', { ascending: true }),
    ]);
    const error = m.error || a.error;
    setMinimos(new Map((m.data || []).filter(r => r.minimo_usd > 0).map(r => [r.producto_id, Number(r.minimo_usd)])));
    setAlertas(a.data || []);
    setEstado({ cargando: false, error: error && !faltaVista(error) ? error : null, faltaSql: Boolean(error && faltaVista(error)) });
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  // Tus enlaces con precio hoy: el precio de venta (oferta o lista) en cada cadena.
  const ventaPorProducto = useMemo(() => {
    const m = new Map();
    if (!bcv.rate) return m;
    for (const e of productosCompetencia) {
      if (!e.activo || String(e.tipo).toLowerCase() !== 'propio') continue;
      const bs = e.ultimo_precio_desc_bs || e.ultimo_precio_full_bs;
      if (!(bs > 0)) continue;
      const id = String(e.id_producto_propio).trim();
      if (!m.has(id)) m.set(id, []);
      m.get(id).push({ cadena: e.cadena, usd: bs / bcv.rate });
    }
    return m;
  }, [productosCompetencia, bcv.rate]);

  const alertasPorProducto = useMemo(() => {
    const m = new Map();
    for (const a of alertas) m.set(String(a.id_producto_propio), (m.get(String(a.id_producto_propio)) || 0) + 1);
    return m;
  }, [alertas]);

  const filas = useMemo(() => {
    const t = normalizar(busqueda);
    return productos.filter(p => p.activo && p.db_id != null)
      .map(p => {
        const ventas = ventaPorProducto.get(String(p.id_interno).trim()) || [];
        const masBaja = ventas.length ? ventas.reduce((a, b) => (b.usd < a.usd ? b : a)) : null;
        return { p, minimo: minimos.get(p.db_id) ?? null, masBaja, debajo: alertasPorProducto.get(String(p.id_interno)) || 0 };
      })
      .filter(f => (mostrar === 'todos'
        || (mostrar === 'con_minimo' && f.minimo != null)
        || (mostrar === 'sin_minimo' && f.minimo == null)
        || (mostrar === 'debajo' && f.debajo > 0))
        && (!t || normalizar(`${f.p.id_interno} ${f.p.nombre} ${f.p.principio_activo || ''}`).includes(t)))
      .sort((a, b) => b.debajo - a.debajo || (a.p.nombre || '').localeCompare(b.p.nombre || ''));
  }, [productos, minimos, ventaPorProducto, alertasPorProducto, mostrar, busqueda]);

  const guardar = async (p, texto) => {
    const nuevo = String(texto).trim() === '' ? null : numero(texto);
    if (String(texto).trim() !== '' && nuevo == null) { addToast('Escribe un precio en dólares, por ejemplo 2.50', 'warning'); return false; }
    if (nuevo === (minimos.get(p.db_id) ?? null)) return true;
    setGuardando(p.db_id);
    const { error } = await supabase.from('precio_minimo').upsert(
      { producto_id: p.db_id, minimo_usd: nuevo, actualizado: new Date().toISOString(), actualizado_por: await correoActual() },
      { onConflict: 'producto_id' });
    setGuardando(null);
    if (error) { addToast(`No se pudo guardar: ${error.message}`, 'error'); return false; }
    setMinimos(prev => { const m = new Map(prev); if (nuevo == null) m.delete(p.db_id); else m.set(p.db_id, nuevo); return m; });
    addToast(nuevo == null ? `Sin precio mínimo: ${p.nombre}` : `Precio mínimo de ${p.nombre}: ${usd(nuevo)}`, 'success');
    cargar();
    return true;
  };

  const exportar = () => {
    const datos = productos.filter(p => p.activo).map(p => ({
      id_interno: p.id_interno, nombre: p.nombre, precio_minimo_usd: minimos.get(p.db_id) ?? '',
    }));
    exportToCSV('precio_minimo', [
      { key: 'id_interno', label: 'id_interno' }, { key: 'nombre', label: 'nombre' }, { key: 'precio_minimo_usd', label: 'precio_minimo_usd' },
    ], datos);
  };

  const importar = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const { texto } = await leerArchivoCsv(file);
      const rows = parseCSV(texto);
      const porId = new Map(productos.map(p => [String(p.id_interno).trim(), p]));
      const cambios = [];
      const desconocidos = [];
      for (const r of rows) {
        const id = getRowValue(r, 'id_interno', 'ID', 'id');
        const valor = getRowValue(r, 'precio_minimo_usd', 'precio minimo', 'minimo', 'precio_minimo');
        if (!id || valor === '') continue;          // celda vacia = no cambiar
        const p = porId.get(String(id).trim());
        const v = numero(valor);
        if (!p || v == null) { desconocidos.push(id); continue; }
        cambios.push({ producto_id: p.db_id, minimo_usd: v });
      }
      if (!cambios.length) { addToast('El archivo no trae precios mínimos para cargar (columnas id_interno y precio_minimo_usd).', 'warning'); return; }
      const quien = await correoActual();
      const ahora = new Date().toISOString();
      const { error } = await supabase.from('precio_minimo')
        .upsert(cambios.map(c => ({ ...c, actualizado: ahora, actualizado_por: quien })), { onConflict: 'producto_id' });
      if (error) throw error;
      addToast(`${cambios.length} precios mínimos cargados${desconocidos.length ? ` · ${desconocidos.length} filas no reconocidas` : ''}.`, 'success');
      cargar();
    } catch (err) {
      addToast(`No se pudo cargar el archivo: ${err.message}`, 'error');
    }
  };

  const conMinimo = productos.filter(p => p.activo && minimos.has(p.db_id)).length;

  return (
    <div className="space-y-4">
      <EstadoAnalisis cargando={estado.cargando} faltaSql={estado.faltaSql} fase="la fase 46" error={estado.error} hayFilas>
        <section className="grid grid-cols-2 lg:grid-cols-3 gap-3" aria-label="Resumen">
          <StatCard compacto label="Por debajo del mínimo" value={alertas.length} icon="gpp_maybe" tono={alertas.length ? 'negative' : 'positive'}
            hint={alertas.length ? `En ${new Set(alertas.map(a => a.id_producto_propio)).size} productos` : 'Todas las cadenas lo respetan'} />
          <StatCard compacto label="Productos con mínimo" value={`${conMinimo} de ${productos.filter(p => p.activo).length}`} icon="price_check" tono="neutral"
            hint="Los demás no se vigilan" onClick={() => setMostrar('con_minimo')} />
          <StatCard compacto label="Sin mínimo" value={productos.filter(p => p.activo).length - conMinimo} icon="edit" tono="neutral"
            hint="Fíjalo en la tabla o con un CSV" onClick={() => setMostrar('sin_minimo')} />
        </section>

        {alertas.length > 0 && (
          <section className="m3-data-table" aria-label="Cadenas por debajo del mínimo">
            <div className="m3-data-table-titulo">
              <h2 className="m3-title-medium text-on-surface">Cadenas vendiendo tu producto por debajo del mínimo</h2>
              <p className="m3-body-small text-on-surface-variant">Última lectura de tu enlace en cada cadena. Precio de venta = la oferta si hay; si no, el de lista.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="m3-table m3-table-apilada">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Cadena</th>
                    <th className="text-right">Vende a</th>
                    <th className="text-right">Tu mínimo</th>
                    <th className="text-right">Diferencia</th>
                    <th>Desde</th>
                    <th><span className="sr-only">Abrir</span></th>
                  </tr>
                </thead>
                <tbody>
                  {alertas.map(a => (
                    <tr key={a.publicacion_id}>
                      <td>
                        <div className="m3-cell-primary m3-cell-clamp max-w-[18rem]" title={a.producto_nombre}>{a.producto_nombre}</div>
                        <div className="m3-cell-secondary">{a.id_producto_propio}</div>
                      </td>
                      <td data-label="Cadena">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><CadenaBadge cadena={a.cadena_id} tamano="xs" title="" />{nombreCadena(a.cadena_id)}</span>
                      </td>
                      <td className="text-right tabular-nums whitespace-nowrap" data-label="Vende a">
                        {usd(a.venta_usd)}
                        {a.precio_desc_bs != null && <div className="m3-cell-secondary">en oferta</div>}
                      </td>
                      <td className="text-right tabular-nums whitespace-nowrap" data-label="Tu mínimo">{usd(a.minimo_usd)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap text-error font-medium" data-label="Diferencia">
                        {String(a.dif_pct).replace('.', ',').replace('-', '−')} %
                      </td>
                      <td className="whitespace-nowrap" data-label="Desde" title={fechaHora(a.desde)}>{haceCuanto(a.desde)}</td>
                      <td>
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir la página en la tienda" aria-label="Abrir en la tienda">
                          <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="m3-data-table" aria-label="Tus precios mínimos">
          <div className="m3-data-table-titulo flex flex-col md:flex-row md:items-center gap-3">
            <div className="min-w-0">
              <h2 className="m3-title-medium text-on-surface">Tus precios mínimos</h2>
              <p className="m3-body-small text-on-surface-variant">Escribe el mínimo en dólares y pulsa Enter (vacío = no vigilar). Para muchos a la vez: Exportar, llenar la columna precio_minimo_usd y Cargar CSV.</p>
            </div>
            <div className="flex items-center gap-2 md:ml-auto">
              <button type="button" onClick={exportar} className="m3-btn-outline" title="Descargar la lista con los mínimos actuales">
                <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>Exportar
              </button>
              <button data-edita type="button" onClick={() => archivoRef.current?.click()} className="m3-btn-tonal" title="Subir un CSV con id_interno y precio_minimo_usd">
                <span className="material-symbols-outlined text-base" aria-hidden="true">upload</span>Cargar CSV
              </button>
              <input ref={archivoRef} type="file" accept=".csv,text/csv" className="hidden" onChange={importar} />
            </div>
          </div>
          <div className="m3-data-table-toolbar flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, nombre o molécula" aria-label="Buscar producto" />
            </label>
            <FiltroChip etiqueta="Mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
              opciones={[['todos', 'Mostrar: todos'], ['debajo', 'Por debajo del mínimo'], ['con_minimo', 'Con mínimo'], ['sin_minimo', 'Sin mínimo']]} />
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant">{filas.length} productos</span>
              <InfoGrafico alinear="derecha" titulo="Precio mínimo permitido"
                que="El precio más bajo al que aceptas que una cadena venda TU producto. Si el precio de venta de tu enlace queda por debajo, sale arriba como alerta."
                formula={[
                  'Precio de venta = la oferta si hay; si no, el de lista, en dólares a la tasa del día',
                  'Alerta: precio de venta < tu mínimo − 0,5 %',
                  'Las lecturas marcadas como dudosas no cuentan',
                ]}
                lectura="No es el PVP: el PVP sigue sin entrar en ningún cálculo. «Hoy lo más bajo» te ayuda a fijar un mínimo realista." />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right" title="Tu precio de venta más bajo hoy entre las cadenas">Hoy lo más bajo</th>
                  <th className="text-right">Precio mínimo (USD)</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map(f => (
                  <tr key={f.p.id_interno}>
                    <td>
                      <div className="m3-cell-primary m3-cell-clamp max-w-[20rem]" title={f.p.nombre}>{f.p.nombre}</div>
                      <div className="m3-cell-secondary">{[f.p.id_interno, f.p.concentracion, describirPresentacion(f.p)].filter(v => v && v !== '—').join(' · ')}</div>
                    </td>
                    <td className="text-right tabular-nums whitespace-nowrap" data-label="Hoy lo más bajo">
                      {f.masBaja ? <>{usd(f.masBaja.usd)}<div className="m3-cell-secondary">{nombreCadena(f.masBaja.cadena)}</div></> : <span className="text-on-surface-variant">Sin tu enlace</span>}
                    </td>
                    <td className="text-right" data-label="Precio mínimo (USD)">
                      <CampoMinimo key={`${f.p.db_id}-${f.minimo ?? ''}`} valor={f.minimo} ocupado={guardando === f.p.db_id} onGuardar={t => guardar(f.p, t)} />
                    </td>
                    <td data-label="Estado">
                      {f.minimo == null ? <span className="m3-body-small text-on-surface-variant">No se vigila</span>
                        : f.debajo ? <span className="m3-etiqueta is-error">{f.debajo} {f.debajo === 1 ? 'cadena' : 'cadenas'} por debajo</span>
                          : <span className="m3-etiqueta">Todas lo respetan</span>}
                    </td>
                  </tr>
                ))}
                {filas.length === 0 && <tr><td colSpan={4} className="text-center text-on-surface-variant py-8">Ningún producto con estos filtros.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </EstadoAnalisis>
    </div>
  );
}

function CampoMinimo({ valor, ocupado, onGuardar }) {
  const [texto, setTexto] = useState(valor == null ? '' : String(valor));
  const enviar = async () => {
    const ok = await onGuardar(texto);
    if (!ok) setTexto(valor == null ? '' : String(valor));
  };
  return (
    <>
      <span className="solo-en-lectura tabular-nums">{valor == null ? '—' : usd(valor)}</span>
      <label data-edita className="relative inline-flex items-center">
        <span className="absolute left-3 text-on-surface-variant pointer-events-none" aria-hidden="true">$</span>
        <input type="text" inputMode="decimal" value={texto} placeholder="—" disabled={ocupado}
          onChange={e => setTexto(e.target.value)} onBlur={enviar}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTexto(valor == null ? '' : String(valor)); } }}
          className="m3-input w-28 pl-7 text-right tabular-nums" aria-label="Precio mínimo en dólares" />
      </label>
    </>
  );
}
