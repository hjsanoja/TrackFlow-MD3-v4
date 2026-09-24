import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import StatCard from '../components/StatCard';
import Select from '../components/Select';

/**
 * Separa la devaluación de la subida real de precio.
 *
 * El panel dice "Calox subió 50%". Pero si la tasa BCV pasó de 100 a 125 en
 * ese periodo, en dólares pasó de 10 a 12: subió un 20% real y el otro 25% fue
 * la moneda. Sin separarlo, cada movimiento de la tasa se lee como si fuera
 * una decisión comercial del competidor.
 *
 * El caso que más se escapa es el contrario: quien MANTIENE su precio en
 * bolívares mientras la tasa sube está bajando su precio real. Es una jugada
 * agresiva que hoy aparece como "sin cambios".
 */
export default function DevaluacionReal() {
  const [filas, setFilas] = useState([]);
  const [resumen, setResumen] = useState([]);
  const [ventana, setVentana] = useState(30);
  const [lectura, setLectura] = useState('todos');
  const [cargando, setCargando] = useState(true);
  const { addToast } = useToast();

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setCargando(false); return; }
    setCargando(true);
    try {
      const [{ data: d, error: e1 }, { data: r, error: e2 }] = await Promise.all([
        supabase.from('v_descomposicion_precio').select('*').limit(3000),
        supabase.from('v_resumen_devaluacion').select('*'),
      ]);
      if (e1) throw e1;
      setFilas(d || []);
      if (!e2) setResumen(r || []);
    } catch (err) {
      console.error(err);
      addToast(`No se pudo cargar: ${err.message}. ¿Ejecutaste fase14_devaluacion_vs_precio.sql?`, 'error');
    } finally {
      setCargando(false);
    }
  }, [addToast]);

  useEffect(() => { cargar(); }, [cargar]);

  const resumenVentana = useMemo(
    () => resumen.find(r => r.ventana_dias === ventana),
    [resumen, ventana]
  );

  const visibles = useMemo(() => {
    const base = filas.filter(f => f.ventana_dias === ventana && f.lectura !== 'sin_referencia');
    const filtradas = lectura === 'todos' ? base : base.filter(f => f.lectura === lectura);
    // De mayor a menor subida real: arriba lo que de verdad encareció
    return [...filtradas].sort((a, b) => (b.variacion_real_pct ?? 0) - (a.variacion_real_pct ?? 0));
  }, [filas, ventana, lectura]);

  const LECTURAS = {
    subio_real: 'Subieron de verdad',
    bajo_real: 'Bajaron de verdad',
    solo_devaluacion: 'Solo siguieron la tasa',
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-headline-sm font-display font-bold text-on-surface">Devaluación vs Subida Real</h2>
        <p className="text-body-sm text-on-surface-variant mt-1 max-w-3xl">
          Un precio que sube en bolívares no siempre sube de verdad. Aquí se descuenta el
          movimiento de la tasa BCV para ver qué parte fue decisión comercial. Lo contrario
          también cuenta: quien mantiene su precio en bolívares mientras la tasa sube, está
          bajando su precio real.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="m3-segmented">
          {[7, 30].map(d => (
            <button key={d} onClick={() => setVentana(d)}
              className={`m3-segmented-item ${ventana === d ? 'active' : ''}`}>
              {d} días
            </button>
          ))}
        </div>
        <Select value={lectura} onChange={e => setLectura(e.target.value)}
          className="m3-select m3-select-dense max-w-[260px]">
          <option value="todos">Todos los movimientos</option>
          {Object.entries(LECTURAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <button onClick={cargar} className="m3-btn-outline h-9 px-4 text-label-lg ml-auto">
          <span className="material-symbols-outlined text-[18px] mr-1">refresh</span>
          Actualizar
        </button>
      </div>

      {resumenVentana && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label={`Devaluación en ${ventana} días`}
            value={`${resumenVentana.devaluacion_mediana_pct ?? 0}%`}
            hint="Movimiento de la tasa BCV"
            icon="currency_exchange"
            tono="primary"
          />
          <StatCard
            label="El panel diría"
            value={`${resumenVentana.variacion_bs_promedio_pct ?? 0}%`}
            hint="Promedio de variación en bolívares"
            icon="receipt_long"
          />
          <StatCard
            label="Subida Real Promedio"
            value={`${resumenVentana.variacion_real_promedio_pct ?? 0}%`}
            hint="Lo que queda al descontar la moneda"
            icon="insights"
            tono={(resumenVentana.variacion_real_promedio_pct ?? 0) > 0 ? 'warning' : 'positive'}
          />
          <StatCard
            label="Bajaron en Silencio"
            value={resumenVentana.bajaron_sin_mover_el_bolivar ?? 0}
            hint="Sin tocar el precio en Bs, pero más baratos"
            icon="visibility_off"
            tono={(resumenVentana.bajaron_sin_mover_el_bolivar ?? 0) > 0 ? 'negative' : 'neutral'}
          />
        </div>
      )}

      {cargando ? (
        <div className="flex items-center justify-center py-20">
          <span className="material-symbols-outlined animate-spin text-3xl text-primary">progress_activity</span>
        </div>
      ) : visibles.length === 0 ? (
        <div className="m3-card-outlined p-12 text-center">
          <span className="material-symbols-outlined text-5xl text-outline">query_stats</span>
          <p className="text-title-md font-bold text-on-surface mt-3">Sin datos para esta ventana</p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Hacen falta al menos {ventana} días de capturas para poder comparar.
          </p>
        </div>
      ) : (
        <div className="m3-card-outlined">
          <div className="overflow-auto max-h-[600px]">
            <table className="m3-table m3-table-comfortable">
              <thead className="m3-sticky-header">
                <tr>
                  <th className="min-w-[240px]">Producto</th>
                  <th>Cadena</th>
                  <th className="text-right">El panel diría</th>
                  <th className="text-right">De eso, moneda</th>
                  <th className="text-right">Subida real</th>
                  <th>Lectura</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map(f => (
                  <tr key={`${f.publicacion_id}-${f.ventana_dias}`}>
                    <td>
                      <div className="m3-cell-clamp font-semibold" title={f.producto_nombre}>
                        {f.producto_nombre}
                      </div>
                      <div className="m3-cell-clamp text-label-md text-on-surface-variant font-mono"
                           title={`${f.id_producto_propio} · ${f.laboratorio}`}>
                        {f.id_producto_propio} · {f.laboratorio}
                      </div>
                    </td>
                    <td className="text-label-md">{f.cadena_id}</td>
                    <td className="text-right font-mono text-on-surface-variant">
                      {fmt(f.variacion_bs_pct)}
                    </td>
                    <td className="text-right font-mono text-on-surface-variant">
                      {fmt(f.devaluacion_pct)}
                    </td>
                    <td className={`text-right font-mono font-bold ${
                      (f.variacion_real_pct ?? 0) > 2 ? 'text-error'
                      : (f.variacion_real_pct ?? 0) < -2 ? 'text-[color:var(--md-sys-color-data-positive)]'
                      : 'text-on-surface-variant'
                    }`}>
                      {fmt(f.variacion_real_pct)}
                    </td>
                    <td>
                      <Etiqueta lectura={f.lectura} enBs={f.variacion_bs_pct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function fmt(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function Etiqueta({ lectura, enBs }) {
  // El caso interesante: bajó de verdad sin tocar el bolívar.
  const silencioso = lectura === 'bajo_real' && enBs != null && Math.abs(Number(enBs)) < 2;

  const config = silencioso
    ? { texto: 'Bajó en silencio', clase: 'bg-error-container text-on-error-container', icono: 'visibility_off' }
    : lectura === 'subio_real'
      ? { texto: 'Subió de verdad', clase: 'bg-tertiary-container text-on-tertiary-container', icono: 'trending_up' }
      : lectura === 'bajo_real'
        ? { texto: 'Bajó de verdad', clase: 'bg-secondary-container text-on-secondary-container', icono: 'trending_down' }
        : { texto: 'Solo la tasa', clase: 'bg-surface-container-high text-on-surface-variant', icono: 'currency_exchange' };

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-label-md font-semibold whitespace-nowrap ${config.clase}`}>
      <span className="material-symbols-outlined text-[14px]">{config.icono}</span>
      {config.texto}
    </span>
  );
}
