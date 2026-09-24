import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import StatCard from '../components/StatCard';

/**
 * Bandeja de revisión de capturas sospechosas.
 *
 * El esquema marca las capturas dudosas desde la Fase 1: un trigger compara el
 * nombre leído contra el del catálogo y la variación de precio contra el
 * umbral de config_calidad. Pero nadie las veía nunca, así que un precio mal
 * leído entraba igual en los promedios, las brechas y el índice de
 * competitividad.
 *
 * Dos acciones, y lo que significan:
 *   "Es válida"  -> vuelve a entrar en los análisis
 *   "Es errónea" -> queda descartada, pero el dato crudo se conserva
 */
export default function RevisionCapturas() {
  const [capturas, setCapturas] = useState([]);
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(null);
  const [filtroMotivo, setFiltroMotivo] = useState('todos');
  const { addToast } = useToast();

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setCargando(false); return; }
    setCargando(true);
    try {
      const [{ data: filas, error: e1 }, { data: res, error: e2 }] = await Promise.all([
        supabase.from('v_capturas_sospechosas').select('*').order('fecha_captura', { ascending: false }).limit(500),
        supabase.from('v_calidad_datos').select('*').maybeSingle(),
      ]);
      if (e1) throw e1;
      setCapturas(filas || []);
      if (!e2) setResumen(res);
    } catch (err) {
      console.error('Error cargando la bandeja de revisión:', err);
      addToast(`No se pudo cargar la bandeja: ${err.message}`, 'error');
    } finally {
      setCargando(false);
    }
  }, [addToast]);

  useEffect(() => { cargar(); }, [cargar]);

  const revisar = async (captura, esValida) => {
    setProcesando(captura.captura_id);
    try {
      // Solo se pueden tocar estos campos: fase12 concede permiso a nivel de
      // columna, así que un intento de cambiar el precio lo rechaza Postgres.
      const { data, error } = await supabase
        .from('fact_precios')
        .update({ revisado_manual: true, sospechoso: !esValida })
        .eq('id', captura.captura_id)
        .select('id');

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('No se guardó el cambio. Ejecuta fase12_bandeja_revision.sql en Supabase.');
      }

      setCapturas(prev => prev.filter(c => c.captura_id !== captura.captura_id));
      addToast(
        esValida
          ? 'Captura confirmada: vuelve a contar en los análisis.'
          : 'Captura descartada: deja de afectar los análisis.',
        'success'
      );
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally {
      setProcesando(null);
    }
  };

  const visibles = useMemo(
    () => filtroMotivo === 'todos' ? capturas : capturas.filter(c => c.motivo_sospecha === filtroMotivo),
    [capturas, filtroMotivo]
  );

  const MOTIVOS = {
    nombre: 'El nombre leído no coincide',
    variacion_precio: 'Salto de precio fuera del umbral',
    ambos: 'Nombre y precio',
    legacy: 'Dato migrado sin verificar',
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-headline-sm font-display font-bold text-on-surface">Revisión de Capturas</h2>
        <p className="text-body-sm text-on-surface-variant mt-1 max-w-3xl">
          El scraper marca las capturas dudosas cuando el nombre leído no se parece al del
          catálogo o el precio da un salto fuera del umbral. Hasta revisarlas, quedan fuera de
          los promedios y las brechas.
        </p>
      </div>

      {resumen && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Pendientes de Revisar"
            value={resumen.pendientes}
            hint="Hoy no entran en los análisis"
            icon="rule"
            tono={resumen.pendientes > 0 ? 'warning' : 'positive'}
          />
          <StatCard
            label="Datos Limpios"
            value={`${resumen.porcentaje_limpio ?? 0}%`}
            hint={`${resumen.capturas_totales} capturas en total`}
            icon="verified"
            tono="primary"
          />
          <StatCard
            label="Ya Revisadas"
            value={resumen.revisadas}
            hint={`${resumen.descartadas} descartadas por erróneas`}
            icon="fact_check"
          />
          <StatCard
            label="Por Salto de Precio"
            value={(resumen.por_precio || 0) + (resumen.por_ambos || 0)}
            hint={`${resumen.por_nombre || 0} por nombre que no coincide`}
            icon="trending_up"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-label-lg text-on-surface-variant">Motivo:</label>
        <select
          value={filtroMotivo}
          onChange={e => setFiltroMotivo(e.target.value)}
          className="m3-select m3-select-dense max-w-[280px]"
        >
          <option value="todos">Todos ({capturas.length})</option>
          {Object.entries(MOTIVOS).map(([k, v]) => {
            const n = capturas.filter(c => c.motivo_sospecha === k).length;
            return n > 0 ? <option key={k} value={k}>{v} ({n})</option> : null;
          })}
        </select>
        <button onClick={cargar} className="m3-btn-outline h-9 px-4 text-label-lg ml-auto">
          <span className="material-symbols-outlined text-[18px] mr-1">refresh</span>
          Actualizar
        </button>
      </div>

      {cargando ? (
        <div className="flex items-center justify-center py-20 text-on-surface-variant">
          <span className="material-symbols-outlined animate-spin text-3xl text-primary">progress_activity</span>
        </div>
      ) : visibles.length === 0 ? (
        <div className="m3-card-outlined p-12 text-center">
          <span className="material-symbols-outlined text-5xl text-[color:var(--md-sys-color-data-positive)]">task_alt</span>
          <p className="text-title-md font-bold text-on-surface mt-3">No hay nada que revisar</p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Todas las capturas pasaron el control de calidad o ya fueron revisadas.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibles.map(c => (
            <FilaCaptura
              key={c.captura_id}
              captura={c}
              motivo={MOTIVOS[c.motivo_sospecha] || c.motivo_sospecha}
              procesando={procesando === c.captura_id}
              onRevisar={revisar}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilaCaptura({ captura: c, motivo, procesando, onRevisar }) {
  const variacion = Number(c.variacion_pct);
  const hayVariacion = Number.isFinite(variacion);

  return (
    <div className="m3-card-outlined p-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-label-md font-bold text-[color:var(--md-sys-color-tertiary)] uppercase">{motivo}</span>
            <span className="text-label-sm text-on-surface-variant font-mono">
              {c.cadena_id} · {new Date(c.fecha_captura).toLocaleString('es-VE')}
            </span>
          </div>
          <div className="text-title-sm font-bold text-on-surface mt-1 truncate" title={c.producto_nombre}>
            {c.producto_nombre}
          </div>
          <div className="text-label-md text-on-surface-variant font-mono truncate" title={c.id_producto_propio}>
            {c.id_producto_propio} · {c.laboratorio}
          </div>

          {/* El nombre leído, cuando no se parece al del catálogo */}
          {c.nombre_capturado && c.nombre_capturado !== c.producto_nombre && (
            <div className="mt-2 text-body-sm">
              <span className="text-on-surface-variant">Se leyó: </span>
              <span className="text-error font-medium">"{c.nombre_capturado}"</span>
              {c.similitud_nombre != null && (
                <span className="text-label-md text-on-surface-variant font-mono ml-2">
                  {Math.round(c.similitud_nombre * 100)}% de parecido
                </span>
              )}
            </div>
          )}
        </div>

        {/* Precio anterior contra el capturado: el contexto para juzgar */}
        <div className="flex items-center gap-4 shrink-0">
          {c.precio_anterior_bs != null && (
            <div className="text-right">
              <div className="text-label-sm text-on-surface-variant uppercase">Anterior</div>
              <div className="text-body-lg font-mono text-on-surface-variant">
                Bs {Number(c.precio_anterior_bs).toLocaleString('es-VE')}
              </div>
            </div>
          )}
          <span className="material-symbols-outlined text-on-surface-variant">arrow_forward</span>
          <div className="text-right">
            <div className="text-label-sm text-on-surface-variant uppercase">Capturado</div>
            <div className="text-body-lg font-mono font-bold text-error">
              Bs {Number(c.precio_bs).toLocaleString('es-VE')}
            </div>
            {hayVariacion && (
              <div className={`text-label-md font-mono font-bold ${variacion > 0 ? 'text-error' : 'text-[color:var(--md-sys-color-data-positive)]'}`}>
                {variacion > 0 ? '+' : ''}{variacion.toLocaleString('es-VE')}%
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <a
            href={c.url} target="_blank" rel="noopener noreferrer"
            className="m3-btn-outline h-9 px-3 text-label-lg"
            title="Abrir la página en la tienda para comprobarlo"
          >
            <span className="material-symbols-outlined text-[18px]">open_in_new</span>
          </a>
          <button
            onClick={() => onRevisar(c, false)}
            disabled={procesando}
            className="m3-btn-danger-outline h-9 px-3 text-label-lg"
            title="Descartar: deja de contar en los análisis"
          >
            Es errónea
          </button>
          <button
            onClick={() => onRevisar(c, true)}
            disabled={procesando}
            className="m3-btn-primary h-9 px-3 text-label-lg"
            title="Confirmar: vuelve a contar en los análisis"
          >
            Es válida
          </button>
        </div>
      </div>
    </div>
  );
}
