import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseActive } from '../../supabase';
import { useToast } from '../../context/ToastContext';
import { useData } from '../../context/DataContext';
import { useDimensiones } from '../../hooks/useDimensiones';
import { FormSection, Field } from '../formulario';
import Select from '../Select';

// Alertas a la medida (fase 54): cada usuario arma sus reglas y le llegan por
// correo al terminar cada corrida del robot (scraper/correos.py), si tiene
// «Alertas inmediatas» encendido. No se borran: se pausan.
const TIPOS = [
  ['baja', 'Un competidor BAJA su precio más de'],
  ['sube', 'Un competidor SUBE su precio más de'],
  ['mas_barato', 'Un competidor queda más barato que yo más de'],
];
const VACIA = { tipo: 'baja', umbral: '5', producto_id: '', cadena_id: '', laboratorio: '' };
const faltaTabla = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

export default function MisAlertas({ recibeAlertas }) {
  const { addToast } = useToast();
  const { productos = [], cadenas = [] } = useData() || {};
  const { laboratorios = [] } = useDimensiones();
  const [alertas, setAlertas] = useState(null);
  const [sinFase, setSinFase] = useState(false);
  const [form, setForm] = useState(VACIA);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setAlertas([]); return; }
    const { data: sesion } = await supabase.auth.getUser();
    const correo = String(sesion?.user?.email || '').toLowerCase();
    const { data, error } = await supabase.from('alertas_usuario').select('*').ilike('email', correo).order('creado', { ascending: false });
    if (error) {
      if (faltaTabla(error)) setSinFase(true);
      setAlertas([]);
      return;
    }
    setAlertas(data || []);
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const nombreProducto = useMemo(() => new Map(productos.map(p => [String(p.id_interno), p.nombre])), [productos]);
  const nombreCadena = (id) => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id;
  const describir = (a) => {
    const tipo = TIPOS.find(t => t[0] === a.tipo)?.[1] || a.tipo;
    return `${a.laboratorio ? tipo.replace('Un competidor', a.laboratorio) : tipo} ${Number(a.umbral).toLocaleString('es-VE')} %`;
  };
  const donde = (a) => [
    a.producto_id ? (nombreProducto.get(String(a.producto_id)) || a.producto_id) : 'Todos tus productos',
    a.cadena_id ? nombreCadena(a.cadena_id) : 'todas las cadenas',
  ].join(' · ');

  const crear = async (e) => {
    e.preventDefault();
    const umbral = Number(String(form.umbral).replace(',', '.'));
    if (!(umbral > 0 && umbral <= 100)) { addToast('El porcentaje debe estar entre 0 y 100.', 'error'); return; }
    setGuardando(true);
    const { error } = await supabase.from('alertas_usuario').insert({
      tipo: form.tipo, umbral,
      producto_id: form.producto_id || null, cadena_id: form.cadena_id || null, laboratorio: form.laboratorio.trim() || null,
    });
    setGuardando(false);
    if (error) { addToast(`No se pudo crear la alerta: ${error.message}`, 'error'); return; }
    setForm(VACIA);
    addToast('Alerta creada.', 'success');
    cargar();
  };

  const alternar = async (a) => {
    const { error } = await supabase.from('alertas_usuario').update({ activa: !a.activa }).eq('id', a.id);
    if (error) { addToast(`No se pudo cambiar la alerta: ${error.message}`, 'error'); return; }
    setAlertas(lista => lista.map(x => (x.id === a.id ? { ...x, activa: !a.activa } : x)));
  };

  return (
    <FormSection titulo="Mis alertas de precio" icono="notifications_active">
      {sinFase ? (
        <p className="m3-body-medium text-on-surface-variant">Falta correr <code>sql/fase54_correos_y_alertas.sql</code> en Supabase.</p>
      ) : (
        <>
          {!recibeAlertas && (
            <p className="m3-body-small text-on-surface-variant">
              Para que te lleguen por correo, enciende <strong>Alertas inmediatas</strong> arriba y guarda.
            </p>
          )}
          <form onSubmit={crear} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Avísame cuando…">
              <Select value={form.tipo} onChange={e => setForm(f => ({ ...f, tipo: e.target.value }))}>
                {TIPOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Porcentaje (%)">
              <input inputMode="decimal" value={form.umbral} onChange={e => setForm(f => ({ ...f, umbral: e.target.value }))} className="m3-input" />
            </Field>
            <Field label="Laboratorio competidor" hint="Vacío: cualquiera.">
              <input list="tf-alerta-labs" value={form.laboratorio} onChange={e => setForm(f => ({ ...f, laboratorio: e.target.value }))} className="m3-input" placeholder="Ej.: Genven" />
              <datalist id="tf-alerta-labs">{laboratorios.map(l => <option key={l} value={l} />)}</datalist>
            </Field>
            <Field label="Cadena">
              <Select value={form.cadena_id} onChange={e => setForm(f => ({ ...f, cadena_id: e.target.value }))}>
                <option value="">Todas las cadenas</option>
                {cadenas.filter(c => c.activo !== false).map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </Select>
            </Field>
            <Field label="Tu producto">
              <Select value={form.producto_id} onChange={e => setForm(f => ({ ...f, producto_id: e.target.value }))}>
                <option value="">Todos tus productos</option>
                {[...productos].filter(p => p.activo !== false).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
                  .map(p => <option key={p.id_interno} value={p.id_interno}>{p.nombre} ({p.id_interno})</option>)}
              </Select>
            </Field>
            <div className="flex items-end justify-end">
              <button type="submit" disabled={guardando} className="m3-btn-tonal">
                <span className="material-symbols-outlined">add_alert</span>
                {guardando ? 'Creando…' : 'Crear alerta'}
              </button>
            </div>
          </form>

          {alertas === null ? (
            <div className="h-16 rounded-xl m3-skeleton" />
          ) : alertas.length === 0 ? (
            <p className="m3-body-medium text-on-surface-variant">Todavía no tienes alertas. Ejemplo: «Genven baja más de 5 % en Farmatodo».</p>
          ) : (
            <ul className="divide-y divide-outline-variant rounded-2xl border border-outline-variant">
              {alertas.map(a => (
                <li key={a.id} className={`flex items-center gap-3 px-4 py-3 ${a.activa ? '' : 'opacity-60'}`}>
                  <span className="material-symbols-outlined text-primary" aria-hidden="true">
                    {a.tipo === 'sube' ? 'trending_up' : a.tipo === 'baja' ? 'trending_down' : 'price_check'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="m3-body-medium text-on-surface">{describir(a)}</div>
                    <div className="m3-body-small text-on-surface-variant">{donde(a)}{a.activa ? '' : ' · en pausa'}</div>
                  </div>
                  <button type="button" onClick={() => alternar(a)} className="m3-btn-text">
                    {a.activa ? 'Pausar' : 'Activar'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FormSection>
  );
}
