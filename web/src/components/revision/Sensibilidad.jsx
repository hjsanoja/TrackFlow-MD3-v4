import { useEffect, useState } from 'react';
import ModalWrapper from '../ModalWrapper';
import Segmentado from '../Segmentado';
import { supabase } from '../../supabase';
import { useToast } from '../../context/ToastContext';

// Cuándo se marca una captura como dudosa (config_calidad): salto de precio,
// parecido del nombre y si se revisan dosis y tamaño. "Probar" cuenta, con
// fn_probar_sensibilidad (fase 35), cuántas capturas recientes se marcarían;
// "Guardar" vale para las capturas nuevas y "Guardar y marcar" marca también
// las recientes que ahora quedarían fuera (nunca desmarca).
const faltaSql = (e) => /PGRST202|42883|function|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const pct = (v) => `${Math.round(v)} %`;

export default function Sensibilidad({ onClose, onAplicado }) {
  const { addToast } = useToast();
  const [valores, setValores] = useState(null);
  const [dias, setDias] = useState(30);
  const [resultado, setResultado] = useState(null);
  const [probando, setProbando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [sinFase35, setSinFase35] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('config_calidad').select('clave, valor');
      const v = Object.fromEntries((data || []).map(r => [r.clave, Number(r.valor)]));
      setValores({
        variacion: Math.round((v.umbral_variacion_precio ?? 0.4) * 100),
        similitud: Math.round((v.umbral_similitud_nombre ?? 0.4) * 100),
        presentacion: (v.validar_presentacion ?? 1) > 0,
      });
    })();
  }, []);

  const cambiar = (clave, valor) => { setValores(v => ({ ...v, [clave]: valor })); setResultado(null); };

  const probar = async (aplicar = false) => {
    const { data, error } = await supabase.rpc('fn_probar_sensibilidad', {
      p_umbral_variacion: valores.variacion / 100,
      p_umbral_similitud: valores.similitud / 100,
      p_validar_presentacion: valores.presentacion,
      p_dias: dias,
      p_aplicar: aplicar,
    });
    if (error) {
      if (faltaSql(error)) setSinFase35(true);
      throw error;
    }
    return data;
  };

  const alProbar = async () => {
    setProbando(true);
    try { setResultado(await probar(false)); } catch (err) {
      if (!faltaSql(err)) addToast(`No se pudo probar: ${err.message}`, 'error');
    } finally { setProbando(false); }
  };

  const guardar = async (marcar) => {
    setGuardando(true);
    try {
      const ahora = new Date().toISOString();
      const { error } = await supabase.from('config_calidad').upsert([
        { clave: 'umbral_variacion_precio', valor: valores.variacion / 100, updated_at: ahora },
        { clave: 'umbral_similitud_nombre', valor: valores.similitud / 100, updated_at: ahora },
        { clave: 'validar_presentacion', valor: valores.presentacion ? 1 : 0, updated_at: ahora },
      ], { onConflict: 'clave' });
      if (error) throw error;
      if (marcar) {
        const r = await probar(true);
        addToast(`Sensibilidad guardada y ${r.marcadas_ahora} ${r.marcadas_ahora === 1 ? 'captura marcada' : 'capturas marcadas'} para revisar.`, 'success');
        onAplicado?.();
      } else {
        addToast('Sensibilidad guardada: vale para las capturas nuevas.', 'success');
      }
      onClose();
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally { setGuardando(false); }
  };

  return (
    <ModalWrapper isOpen onClose={onClose} title="Sensibilidad del control" icon="tune" maxWidth="max-w-xl"
      subtitle="Cuándo el robot marca una captura como dudosa"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 w-full">
          <button type="button" onClick={onClose} className="m3-btn-text">Cancelar</button>
          <button type="button" onClick={() => guardar(false)} disabled={!valores || guardando} className="m3-btn-outline h-10 px-4">Guardar</button>
          {resultado?.nuevas > 0 && (
            <button type="button" onClick={() => guardar(true)} disabled={guardando} className="m3-btn-primary h-10 px-4"
              title="Guarda y además marca para revisar las capturas recientes que ahora quedarían fuera">
              Guardar y marcar {resultado.nuevas}
            </button>
          )}
        </div>
      }>
      {!valores ? (
        <div className="h-48 m3-skeleton rounded-2xl" aria-busy="true" />
      ) : (
        <div className="space-y-5">
          <Deslizador etiqueta="Salto de precio máximo" ayuda="Se marca si el precio sube o baja más que esto frente a la última lectura buena del enlace."
            valor={valores.variacion} min={10} max={100} onChange={v => cambiar('variacion', v)} />
          <Deslizador etiqueta="Parecido mínimo del nombre" ayuda="Se marca si el nombre leído en la tienda se parece menos que esto al registrado."
            valor={valores.similitud} min={10} max={90} onChange={v => cambiar('similitud', v)} />
          <label className="m3-switch-label items-start">
            <input type="checkbox" role="switch" checked={valores.presentacion} onChange={e => cambiar('presentacion', e.target.checked)} className="m3-switch mt-0.5" />
            <span>
              <span className="m3-title-small text-on-surface block">Revisar dosis y tamaño</span>
              <span className="m3-body-small text-on-surface-variant">
                Se marca si la tienda muestra otra dosis o tamaño que el registrado, por ejemplo «Losartán 50 mg x 30» cuando el producto es «x 10».
                Solo compara lo que se puede leer en los dos nombres.
              </span>
            </span>
          </label>

          <div className="m3-dash-card space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Segmentado etiqueta="Capturas a probar" rotulo="Probar con" valor={dias} onChange={v => { setDias(Number(v)); setResultado(null); }}
                opciones={[[7, '7 días'], [30, '30 días'], [90, '90 días']]} />
              <button type="button" onClick={alProbar} disabled={probando || sinFase35} className="m3-btn-tonal ml-auto">
                <span className={`material-symbols-outlined ${probando ? 'animate-spin' : ''}`} aria-hidden="true">{probando ? 'progress_activity' : 'science'}</span>
                {probando ? 'Probando…' : 'Probar'}
              </button>
            </div>
            {sinFase35 ? (
              <p className="m3-body-medium text-on-surface-variant">Ejecuta <strong>fase35_calidad_presentacion.sql</strong> en Supabase para probar y para revisar dosis y tamaño.</p>
            ) : resultado ? (
              <div className="space-y-2">
                <p className="m3-body-medium text-on-surface">
                  De <strong>{resultado.evaluadas.toLocaleString('es-VE')}</strong> capturas de los últimos {dias} días se marcarían{' '}
                  <strong>{resultado.marcarian.toLocaleString('es-VE')}</strong>
                  {resultado.evaluadas > 0 && ` (${pct((resultado.marcarian / resultado.evaluadas) * 100)})`}. Hoy están marcadas {resultado.marcadas_hoy.toLocaleString('es-VE')}.
                </p>
                <ul className="grid grid-cols-3 gap-2 text-center">
                  <Cifra rotulo="Por salto de precio" valor={resultado.por_precio} />
                  <Cifra rotulo="Por nombre" valor={resultado.por_nombre} />
                  <Cifra rotulo="Por dosis o tamaño" valor={resultado.por_presentacion} />
                </ul>
                <p className="m3-body-small text-on-surface-variant">
                  {resultado.nuevas > 0
                    ? `${resultado.nuevas.toLocaleString('es-VE')} no están marcadas hoy: con «Guardar y marcar» pasan a pendientes. Una captura puede tener más de un motivo.`
                    : 'No hay capturas nuevas que marcar. Una captura puede tener más de un motivo.'}
                </p>
              </div>
            ) : (
              <p className="m3-body-small text-on-surface-variant">Prueba los valores antes de guardarlos: cuenta cuántas capturas recientes se marcarían, sin cambiar nada.</p>
            )}
          </div>
        </div>
      )}
    </ModalWrapper>
  );
}

function Deslizador({ etiqueta, ayuda, valor, min, max, onChange }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3">
        <span className="m3-title-small text-on-surface">{etiqueta}</span>
        <span className="m3-title-medium tabular-nums text-primary">{pct(valor)}</span>
      </span>
      <input type="range" min={min} max={max} step={5} value={valor} onChange={e => onChange(Number(e.target.value))}
        className="m3-deslizador" aria-label={etiqueta} />
      <span className="m3-body-small text-on-surface-variant">{ayuda}</span>
    </label>
  );
}

function Cifra({ rotulo, valor }) {
  return (
    <li className="rounded-xl bg-surface-container px-2 py-2">
      <div className="m3-title-medium tabular-nums text-on-surface">{Number(valor).toLocaleString('es-VE')}</div>
      <div className="m3-label-small text-on-surface-variant">{rotulo}</div>
    </li>
  );
}
