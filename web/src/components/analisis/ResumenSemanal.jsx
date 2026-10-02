import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import StatCard from '../StatCard';
import CadenaBadge from '../CadenaBadge';
import InfoGrafico from '../InfoGrafico';
import { useData } from '../../context/DataContext';
import { supabase, isSupabaseActive } from '../../supabase';
import { useConsulta } from '../../utils/cacheConsultas';
import { UMBRAL_CAMBIO, pct } from '../dashboard/comun';

// Resumen de la semana: lo que paso en los ultimos 7 dias, en una pantalla.
// Junta lo que ya calculan otras pestanas; lo que falte (una fase sin correr)
// simplemente no sale.
//   - Cambios de precio en dolares (fn_cambios_desde, fase 28), tuyos y de la competencia
//   - Agotados nuevos y los que volvieron (v_disponibilidad, fase 46)
//   - Cadenas que rompieron tu precio minimo esta semana (fase 46)
//   - Tu posicion por cadena hoy frente a hace 7 dias (fase 45)
//   - Decisiones de revision de la semana (fase 47)
const DIAS = 7;
const hace = (d) => new Date(Date.now() - d * 864e5);
const diaCorto = (f) => new Date(f).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });

async function leer(promesa) {
  try { const { data, error } = await promesa; return error ? null : data || []; } catch { return null; }
}

const SIN_DATOS = {};

// Las cinco lecturas del resumen, juntas (cada una puede faltar: null).
async function cargarResumen() {
  const desde = hace(DIAS).toISOString();
  const [cambios, disponibilidad, minimos, posicion, decisiones] = await Promise.all([
    leer(supabase.rpc('fn_cambios_desde', { p_desde: desde })),
    leer(supabase.from('v_disponibilidad').select('*')),
    leer(supabase.from('v_precio_minimo_alertas').select('*')),
    leer(supabase.rpc('fn_posicion_por_cadena', { p_dias: DIAS + 1, p_con_descuento: false, p_por_unidad: false })),
    leer(supabase.from('revision_historial').select('accion, usuario, fecha').gte('fecha', desde)),
  ]);
  return { data: { cambios, disponibilidad, minimos, posicion, decisiones }, error: null };
}

export default function ResumenSemanal() {
  const { productosCompetencia = [], cadenas = [] } = useData() || {};
  const navigate = useNavigate();
  // Queda en memoria: al volver a Experimental sale al instante.
  const { datos: leidos } = useConsulta('resumen:semanal', cargarResumen, { activa: isSupabaseActive() });
  const datos = isSupabaseActive() ? leidos : SIN_DATOS;

  const nombreCadena = useMemo(() => {
    const m = new Map((cadenas || []).map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);
  const enlacePorPub = useMemo(() => {
    const m = new Map();
    for (const e of productosCompetencia) if (e.publicacion_id != null && !m.has(e.publicacion_id)) m.set(e.publicacion_id, e);
    return m;
  }, [productosCompetencia]);

  const r = useMemo(() => {
    if (!datos) return null;
    const limite = hace(DIAS);
    // Cambios de precio en dolares (cada precio a la tasa de su dia).
    const cambios = (datos.cambios || []).map(f => {
      const e = enlacePorPub.get(f.publicacion_id);
      if (!e || !(f.antes_full_bs > 0) || !(f.antes_tasa > 0) || !(f.ahora_tasa > 0)) return null;
      const cambio = ((f.ahora_full_bs / f.ahora_tasa) / (f.antes_full_bs / f.antes_tasa) - 1) * 100;
      return Math.abs(cambio) > UMBRAL_CAMBIO ? { e, cambio, propio: String(e.tipo).toLowerCase() === 'propio' } : null;
    }).filter(Boolean).sort((a, b) => Math.abs(b.cambio) - Math.abs(a.cambio));
    const disp = datos.disponibilidad || [];
    const agotadosNuevos = disp.filter(d => d.estado === 'agotado' && new Date(d.desde) >= limite);
    const volvieron = disp.filter(d => d.estado === 'volvio');
    const minimosNuevos = (datos.minimos || []).filter(a => new Date(a.desde) >= limite);
    // Posicion por cadena: primer dia y ultimo de la serie.
    const pos = datos.posicion || [];
    const fechas = [...new Set(pos.map(p => p.fecha))].sort();
    const porCadena = new Map();
    for (const p of pos) {
      if (!porCadena.has(p.cadena_id)) porCadena.set(p.cadena_id, {});
      if (p.fecha === fechas[0]) porCadena.get(p.cadena_id).antes = p;
      if (p.fecha === fechas.at(-1)) porCadena.get(p.cadena_id).ahora = p;
    }
    const posicion = [...porCadena.entries()].filter(([, v]) => v.ahora)
      .map(([cadena, v]) => ({ cadena, ahora: v.ahora.mas_caro, de: v.ahora.productos, antes: v.antes?.mas_caro ?? null, baratoAhora: v.ahora.mas_barato, baratoAntes: v.antes?.mas_barato ?? null }))
      .sort((a, b) => (b.ahora - (b.antes ?? b.ahora)) - (a.ahora - (a.antes ?? a.ahora)));
    const decisiones = datos.decisiones || [];
    return {
      cambios,
      tuyosSuben: cambios.filter(c => c.propio && c.cambio > 0),
      tuyosBajan: cambios.filter(c => c.propio && c.cambio < 0),
      compSuben: cambios.filter(c => !c.propio && c.cambio > 0),
      compBajan: cambios.filter(c => !c.propio && c.cambio < 0),
      agotadosNuevos, volvieron, minimosNuevos, minimosTotal: (datos.minimos || []).length,
      posicion, desdeFecha: fechas[0], hastaFecha: fechas.at(-1),
      decisiones: { total: decisiones.length, validas: decisiones.filter(d => d.accion === 'valida').length, erroneas: decisiones.filter(d => d.accion === 'erronea').length },
      faltan: Object.entries(datos).filter(([, v]) => v == null).map(([k]) => k),
    };
  }, [datos, enlacePorPub]);

  if (!r) return <div className="h-64 rounded-3xl m3-skeleton" aria-busy="true" />;

  const ListaCambios = ({ titulo, filas, vacio }) => (
    <div className="m3-dash-card">
      <h3 className="m3-title-small text-on-surface mb-2">{titulo} <span className="text-on-surface-variant">({filas.length})</span></h3>
      {filas.length === 0 ? <p className="m3-body-small text-on-surface-variant">{vacio}</p> : (
        <ul className="space-y-1.5">
          {filas.slice(0, 6).map(c => (
            <li key={`${c.e.publicacion_id}_${c.e.id}`} className="flex items-center gap-2 m3-body-small">
              <CadenaBadge cadena={c.e.cadena} tamano="xs" title={nombreCadena(c.e.cadena)} />
              <span className="flex-1 min-w-0 truncate text-on-surface" title={c.e.marca}>{c.propio ? `${c.e.marca}` : `${c.e.marca} · frente a tu ${c.e.id_producto_propio}`}</span>
              <span className={`tabular-nums font-medium ${c.cambio > 0 ? 'text-error' : 'text-primary'}`}>{pct(c.cambio)}</span>
            </li>
          ))}
          {filas.length > 6 && <li className="m3-body-small text-on-surface-variant">y {filas.length - 6} más</li>}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="m3-body-medium text-on-surface-variant flex-1">
          Lo que pasó en los últimos {DIAS} días{r.desdeFecha ? ` (del ${diaCorto(`${r.desdeFecha}T12:00:00`)} a hoy)` : ''}. Toca un número para ir a su pantalla.
        </p>
        <InfoGrafico alinear="derecha" titulo="Resumen de la semana"
          que="Junta en una pantalla lo que ya calculan otras pestañas, para los últimos 7 días."
          formula={[
            'Cambios: precio de lista en dólares, cada uno a la tasa de su día; cuenta desde 0,5 %',
            'Agotados nuevos: se agotaron en estos 7 días · Volvieron: tienen existencia de nuevo',
            'Más caro por cadena: productos donde eres el más caro dentro de la cadena, hoy frente a hace 7 días',
          ]}
          lectura="Rojo: algo que te perjudica (tu precio sube, la competencia baja, te quedas el más caro). Azul: lo contrario." />
      </div>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen">
        <StatCard compacto label="Tus precios cambiaron" value={r.tuyosSuben.length + r.tuyosBajan.length} icon="swap_vert" tono="neutral"
          hint={`${r.tuyosSuben.length} subieron · ${r.tuyosBajan.length} bajaron`} />
        <StatCard compacto label="La competencia cambió" value={r.compSuben.length + r.compBajan.length} icon="storefront" tono={r.compBajan.length ? 'warning' : 'neutral'}
          hint={`${r.compSuben.length} subieron · ${r.compBajan.length} bajaron`} />
        <StatCard compacto label="Se agotaron" value={r.agotadosNuevos.length} icon="remove_shopping_cart" tono={r.agotadosNuevos.some(a => a.es_propio) ? 'negative' : 'neutral'}
          hint={`${r.agotadosNuevos.filter(a => a.es_propio).length} tuyos · ${r.volvieron.length} volvieron`} onClick={() => navigate('/experimental?tab=agotados')} />
        <StatCard compacto label="Bajo tu mínimo" value={r.minimosNuevos.length} icon="gpp_maybe" tono={r.minimosNuevos.length ? 'negative' : 'neutral'}
          hint={`Nuevos esta semana · ${r.minimosTotal} en total`} onClick={() => navigate('/experimental?tab=precio_minimo')} />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Cambios de precio">
        <ListaCambios titulo="Tus precios que subieron" filas={r.tuyosSuben} vacio="Ninguno." />
        <ListaCambios titulo="Tus precios que bajaron" filas={r.tuyosBajan} vacio="Ninguno." />
        <ListaCambios titulo="La competencia que bajó" filas={r.compBajan} vacio="Nadie bajó." />
        <ListaCambios titulo="La competencia que subió" filas={r.compSuben} vacio="Nadie subió." />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="m3-dash-card">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="m3-title-small text-on-surface">Donde eres el más caro, por cadena</h3>
            <button type="button" className="m3-btn-text" onClick={() => navigate('/experimental?tab=por_cadena')}>Ver detalle</button>
          </div>
          {r.posicion.length === 0 ? <p className="m3-body-small text-on-surface-variant">Sin datos (falta la fase 45 o tu enlace junto a la competencia en una misma cadena).</p> : (
            <table className="m3-table">
              <thead><tr><th>Cadena</th><th className="text-right">Hace 7 días</th><th className="text-right">Hoy</th><th className="text-right">Cambio</th></tr></thead>
              <tbody>
                {r.posicion.map(p => {
                  const dif = p.antes == null ? null : p.ahora - p.antes;
                  return (
                    <tr key={p.cadena}>
                      <td><span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={p.cadena} tamano="xs" title="" />{nombreCadena(p.cadena)}</span></td>
                      <td className="text-right tabular-nums">{p.antes ?? '—'}</td>
                      <td className="text-right tabular-nums">{p.ahora} <span className="text-on-surface-variant">de {p.de}</span></td>
                      <td className={`text-right tabular-nums font-medium ${dif > 0 ? 'text-error' : dif < 0 ? 'text-primary' : 'text-on-surface-variant'}`}>
                        {dif == null ? '—' : dif > 0 ? `+${dif}` : dif < 0 ? `−${Math.abs(dif)}` : 'igual'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="m3-dash-card space-y-3">
          <h3 className="m3-title-small text-on-surface">Agotados y revisión</h3>
          <ul className="space-y-1.5 m3-body-small">
            {r.agotadosNuevos.slice(0, 5).map(a => (
              <li key={a.publicacion_id} className="flex items-center gap-2">
                <CadenaBadge cadena={a.cadena_id} tamano="xs" title={nombreCadena(a.cadena_id)} />
                <span className="flex-1 min-w-0 truncate">{a.es_propio ? `Tu ${a.producto_propio_nombre}` : `${a.producto_nombre} (frente a ${a.producto_propio_nombre})`}</span>
                <span className={a.es_propio ? 'text-error font-medium' : 'text-on-surface-variant'}>se agotó</span>
              </li>
            ))}
            {r.agotadosNuevos.length === 0 && <li className="text-on-surface-variant">Nada se agotó esta semana.</li>}
          </ul>
          <p className="m3-body-small text-on-surface">
            <strong className="font-medium">Revisión:</strong>{' '}
            {r.decisiones.total
              ? `${r.decisiones.total} decisiones esta semana (${r.decisiones.validas} válidas, ${r.decisiones.erroneas} erróneas).`
              : 'ninguna decisión esta semana.'}{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => navigate('/experimental?tab=revision')}>Ir a revisar</button>
          </p>
          {r.faltan.length > 0 && (
            <p className="m3-body-small text-on-surface-variant">Algunas partes no se pudieron leer (¿falta correr alguna fase?): {r.faltan.join(', ')}.</p>
          )}
        </div>
      </section>
    </div>
  );
}
