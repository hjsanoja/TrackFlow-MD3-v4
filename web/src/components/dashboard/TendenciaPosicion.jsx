import { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import Select from '../Select';
import { supabase, isSupabaseActive } from '../../supabase';
import { leerColor, pct, textoMeta } from './comun';

const PERIODOS = [[7, 'Últimos 7 días'], [15, 'Últimos 15 días'], [30, 'Últimos 30 días'], [90, 'Últimos 90 días']];

const diaCorto = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { day: 'numeric', month: 'short' });
const diaLargo = (f) => new Date(`${f}T12:00:00`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });

// Tendencia de tu posicion: la diferencia tipica (mediana) de tu precio con el
// promedio de la competencia, dia por dia. La calcula Postgres
// (fn_tendencia_posicion, fase 28); al navegador llegan ~90 puntos.
export default function TendenciaPosicion({ productos, conDescuento, porUnidad, cadena, meta, tg, onDia }) {
  const [dias, setDias] = useState(() => {
    try { return [7, 15, 30, 90].includes(Number(localStorage.getItem('dashboard.tendencia.dias'))) ? Number(localStorage.getItem('dashboard.tendencia.dias')) : 7; } catch { return 7; }
  });
  const [estado, setEstado] = useState({ cargando: true, filas: [], error: null });
  // La lista de productos cambia de identidad en cada filtro: se compara por texto.
  const claveProductos = productos ? productos.join(',') : '';

  useEffect(() => {
    if (!isSupabaseActive()) { setEstado({ cargando: false, filas: [], error: null }); return undefined; }
    let vigente = true;
    setEstado(e => ({ ...e, cargando: true }));
    supabase.rpc('fn_tendencia_posicion', {
      p_dias: dias,
      p_con_descuento: conDescuento,
      p_por_unidad: porUnidad,
      p_cadena: cadena || null,
      p_productos: productos,
    }).then(({ data, error }) => {
      if (!vigente) return;
      setEstado({ cargando: false, filas: error ? [] : (data || []).map(f => ({ ...f, mediana: Number(f.mediana) })), error });
    });
    return () => { vigente = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias, conDescuento, porUnidad, cadena, claveProductos]);

  const cambiarDias = (v) => {
    setDias(v);
    try { localStorage.setItem('dashboard.tendencia.dias', String(v)); } catch { /* sin almacenamiento */ }
  };

  const { filas, cargando, error } = estado;
  const primera = filas[0];
  const ultima = filas.at(-1);
  const color = leerColor('--md-sys-color-primary', '#0F2C59');
  const dominio = useMemo(() => {
    const valores = [...filas.map(f => f.mediana), 0, meta];
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    const margen = Math.max(2, (max - min) * 0.15);
    return [Math.floor(min - margen), Math.ceil(max + margen)];
  }, [filas, meta]);

  const faltaSql = error && /fn_tendencia_posicion|function|404|PGRST202/i.test(`${error.message} ${error.code}`);

  return (
    <div className="m3-dash-card">
      <header className="m3-dash-card-header">
        <div className="min-w-0">
          <h2 className="m3-title-medium text-on-surface">Tendencia de tu posición</h2>
          <p className="m3-body-small text-on-surface-variant">
            Tu precio frente al promedio de la competencia, día a día. Por encima de 0 eres más caro; por debajo, más barato. Toca un día.
          </p>
        </div>
        <Select value={String(dias)} onChange={e => cambiarDias(Number(e.target.value))} aria-label="Periodo de la tendencia"
          className="m3-filter-chip shrink-0" leadingIcon="date_range">
          {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </Select>
      </header>

      {ultima && primera && primera !== ultima && (
        <p className="m3-body-small text-on-surface mb-1">
          {diaCorto(primera.fecha)}: <strong className="font-medium">{pct(primera.mediana)}</strong>
          <span className="text-on-surface-variant"> → </span>
          hoy: <strong className="font-medium">{pct(ultima.mediana)}</strong>
          <span className="text-on-surface-variant">
            {' · '}{ultima.mediana < primera.mediana - 0.5 ? 'te has abaratado frente a la competencia' : ultima.mediana > primera.mediana + 0.5 ? 'te has encarecido frente a la competencia' : 'sin cambios grandes'}
          </span>
        </p>
      )}

      {cargando && filas.length === 0 ? (
        <div className="h-44 rounded-2xl m3-skeleton" aria-busy="true" />
      ) : faltaSql ? (
        <div className="h-44 flex flex-col items-center justify-center gap-2 text-on-surface-variant text-center px-6">
          <span className="material-symbols-outlined text-3xl" aria-hidden="true">database</span>
          <span className="m3-body-medium">Falta correr la fase 28 en Supabase para ver la tendencia.</span>
        </div>
      ) : filas.length < 2 ? (
        <div className="h-44 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
          <span className="material-symbols-outlined text-3xl" aria-hidden="true">show_chart</span>
          <span className="m3-body-medium">Aún no hay días suficientes con tu precio y el de la competencia.</span>
        </div>
      ) : (
        <div className={`h-44 ${cargando ? 'opacity-60' : ''}`} role="img" aria-label={`Tendencia: hoy ${pct(ultima?.mediana)} frente al promedio`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={filas} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}
              onClick={(e) => { if (e?.activeLabel) onDia(e.activeLabel); }} style={{ cursor: 'pointer' }}>
              <CartesianGrid vertical={false} stroke={tg.rejilla} strokeOpacity={0.6} />
              <XAxis dataKey="fecha" tickFormatter={diaCorto} tick={{ fill: tg.eje, fontSize: 11 }} tickLine={false}
                axisLine={{ stroke: tg.rejilla }} minTickGap={24} />
              <YAxis domain={dominio} tickFormatter={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} %`} tick={{ fill: tg.eje, fontSize: 11 }}
                tickLine={false} axisLine={false} width={52} />
              <ReferenceLine y={0} stroke={tg.eje} strokeOpacity={0.55}
                label={{ value: 'Promedio', position: 'insideTopRight', fill: tg.eje, fontSize: 11 }} />
              {meta !== 0 && (
                <ReferenceLine y={meta} stroke={color} strokeDasharray="4 4" strokeOpacity={0.7}
                  label={{ value: 'Tu meta', position: 'insideBottomRight', fill: tg.eje, fontSize: 11 }} />
              )}
              <Tooltip content={<TooltipDia meta={meta} />} cursor={{ stroke: tg.eje, strokeOpacity: 0.3 }} />
              <Line type="monotone" dataKey="mediana" stroke={color} strokeWidth={2} dot={false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: tg.superficie }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function TooltipDia({ active, payload, meta }) {
  if (!active || !payload?.length) return null;
  const f = payload[0].payload;
  return (
    <div className="m3-chart-tooltip">
      <div className="font-medium first-letter:uppercase">{diaLargo(f.fecha)}</div>
      <div>Tu precio: <strong className="font-medium">{pct(f.mediana)}</strong> frente al promedio</div>
      <div className="text-on-surface-variant">Eres el más barato en {f.mas_baratos} de {f.productos} productos</div>
      {meta !== 0 && <div className="text-on-surface-variant">Tu meta: {textoMeta(meta)}</div>}
      <div className="text-on-surface-variant">Toca para ver cada producto</div>
    </div>
  );
}

export { diaLargo };
