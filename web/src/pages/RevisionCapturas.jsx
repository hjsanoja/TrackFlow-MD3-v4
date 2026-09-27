import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase, isSupabaseActive } from '../supabase';
import { useToast } from '../context/ToastContext';
import { useData } from '../context/DataContext';
import StatCard from '../components/StatCard';
import BarraFiltros from '../components/BarraFiltros';
import Segmentado from '../components/Segmentado';
import FiltroChip from '../components/FiltroChip';
import CadenaBadge from '../components/CadenaBadge';
import InfoGrafico from '../components/InfoGrafico';
import { normalizar } from '../components/formulario';

/**
 * Bandeja de revisión de capturas sospechosas.
 *
 * Un trigger marca como dudosa la captura cuyo nombre leído no se parece al
 * del catálogo o cuyo precio salta más que el umbral de config_calidad. Hasta
 * revisarla no entra en los promedios ni en las brechas.
 *
 *   "Es válida"  -> revisado_manual, sin marca: vuelve a los análisis
 *   "Es errónea" -> revisado_manual, con marca: fuera, pero el dato se conserva
 *   "Volver a revisar" -> sin revisar y con marca: de nuevo pendiente
 *
 * Las ya revisadas se leen de v_capturas_revision (fase 34). Sin esa fase
 * solo se ven las pendientes, desde v_capturas_sospechosas (fase 12).
 */
const MOTIVOS = {
  nombre: ['El nombre no coincide', 'badge'],
  variacion_precio: ['Salto de precio', 'trending_up'],
  ambos: ['Nombre y precio', 'report'],
  legacy: ['Dato migrado', 'history'],
};
const VISTAS = { pendiente: 'Pendientes', valida: 'Válidas', erronea: 'Erróneas' };
const POR_PAGINA = 30;
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

const bs = (v) => (v == null ? '—' : `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fecha = (v) => (v ? new Date(v).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const cerca = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / b <= 0.05;

// Pista para decidir, a partir de la lectura siguiente del mismo enlace.
function sugerencia(c) {
  const actual = Number(c.precio_bs);
  const ant = c.precio_anterior_bs == null ? null : Number(c.precio_anterior_bs);
  const sig = c.precio_siguiente_bs == null ? null : Number(c.precio_siguiente_bs);
  if (sig != null && ant != null && cerca(sig, ant) && !cerca(actual, ant)) {
    return { tipo: 'erronea', texto: 'La lectura siguiente volvió al precio anterior: parece un error de lectura.' };
  }
  if (sig != null && cerca(sig, actual)) {
    return { tipo: 'valida', texto: 'La lectura siguiente repite este precio: parece un cambio real.' };
  }
  if ((c.motivo_sospecha === 'nombre') && ant != null && cerca(actual, ant)) {
    return { tipo: 'valida', texto: 'El precio es igual al anterior: quizá la tienda solo escribe el nombre distinto.' };
  }
  if (sig == null && 'precio_siguiente_bs' in c) return { tipo: null, texto: 'Aún no hay otra lectura de este enlace después de esta.' };
  return null;
}

export default function RevisionCapturas() {
  const { cadenas = [] } = useData() || {};
  const { addToast } = useToast();
  const [ver, setVer] = useState('pendiente');
  const [capturas, setCapturas] = useState([]);
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [sinFase34, setSinFase34] = useState(false);
  const [procesando, setProcesando] = useState(null);
  const [motivo, setMotivo] = useState('todos');
  const [cadena, setCadena] = useState('todos');
  const [relacion, setRelacion] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const [limite, setLimite] = useState(POR_PAGINA);

  const nombreCadena = useMemo(() => {
    const m = new Map(cadenas.map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);

  const cargarResumen = useCallback(async () => {
    const { data, error } = await supabase.from('v_calidad_datos').select('*').maybeSingle();
    if (!error) setResumen(data);
  }, []);

  const cargar = useCallback(async () => {
    if (!isSupabaseActive()) { setCargando(false); return; }
    setCargando(true);
    try {
      let { data, error } = await supabase.from('v_capturas_revision').select('*')
        .eq('estado_revision', ver).order('fecha_captura', { ascending: false }).limit(500);
      if (error && faltaVista(error)) {
        setSinFase34(true);
        ({ data, error } = ver === 'pendiente'
          ? await supabase.from('v_capturas_sospechosas').select('*').order('fecha_captura', { ascending: false }).limit(500)
          : { data: [], error: null });
      }
      if (error) throw error;
      setCapturas(data || []);
      cargarResumen();
    } catch (err) {
      console.error('Error cargando la bandeja de revisión:', err);
      addToast(`No se pudo cargar la bandeja: ${err.message}`, 'error');
    } finally {
      setCargando(false);
    }
  }, [ver, addToast, cargarResumen]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { setLimite(POR_PAGINA); }, [ver, motivo, cadena, relacion, busqueda]);

  // Guarda la decision. estado: 'valida' | 'erronea' | 'pendiente'.
  const guardar = useCallback(async (c, estado) => {
    const cambios = estado === 'pendiente'
      ? { revisado_manual: false, sospechoso: true }
      : { revisado_manual: true, sospechoso: estado === 'erronea' };
    const { data, error } = await supabase.from('fact_precios').update(cambios).eq('id', c.captura_id).select('id');
    if (error) throw error;
    // Solo se pueden tocar estos campos (permiso de la fase 12).
    if (!data || data.length === 0) throw new Error('No se guardó el cambio. Ejecuta fase12_bandeja_revision.sql en Supabase.');
  }, []);

  const decidir = async (c, estado) => {
    setProcesando(c.captura_id);
    try {
      await guardar(c, estado);
      setCapturas(prev => prev.filter(x => x.captura_id !== c.captura_id));
      cargarResumen();
      const textos = {
        valida: 'Marcada como válida: vuelve a contar en los análisis.',
        erronea: 'Marcada como errónea: deja de afectar los análisis.',
        pendiente: 'Volvió a pendientes.',
      };
      addToast(textos[estado], 'success', {
        accion: {
          texto: 'Deshacer',
          onClick: async () => {
            try {
              await guardar(c, ver);
              cargar();
            } catch (err) { addToast(`No se pudo deshacer: ${err.message}`, 'error'); }
          },
        },
      });
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally {
      setProcesando(null);
    }
  };

  const cadenasEnLista = useMemo(() => [...new Set(capturas.map(c => c.cadena_id))], [capturas]);

  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return capturas.filter(c =>
      (motivo === 'todos' || c.motivo_sospecha === motivo)
      && (cadena === 'todos' || c.cadena_id === cadena)
      && (relacion === 'todos' || (relacion === 'propio') === Boolean(c.es_propio))
      && (!t || normalizar(`${c.id_producto_propio} ${c.producto_nombre} ${c.producto_propio_nombre || ''} ${c.laboratorio} ${c.nombre_capturado || ''}`).includes(t)));
  }, [capturas, motivo, cadena, relacion, busqueda]);

  const hayFiltros = motivo !== 'todos' || cadena !== 'todos' || relacion !== 'todos' || busqueda !== '';
  const limpiar = () => { setMotivo('todos'); setCadena('todos'); setRelacion('todos'); setBusqueda(''); };

  const conteo = (clave) => capturas.filter(c => c.motivo_sospecha === clave).length;

  return (
    <div className="space-y-4">
      {sinFase34 && (
        <div className="m3-dash-card flex items-start gap-3 text-on-surface-variant">
          <span className="material-symbols-outlined text-primary" aria-hidden="true">database</span>
          <p className="m3-body-medium">
            Ejecuta <strong>fase34_revision_capturas.sql</strong> en Supabase para ver las capturas ya revisadas,
            volver a revisarlas y ver la lectura siguiente de cada enlace. Mientras tanto se muestran solo las pendientes.
          </p>
        </div>
      )}

      {resumen && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen">
          <StatCard compacto label="Pendientes" value={resumen.pendientes ?? 0} icon="rule"
            tono={resumen.pendientes > 0 ? 'warning' : 'positive'} hint="Hoy no entran en los análisis"
            onClick={() => setVer('pendiente')} title="Ver las pendientes" />
          <StatCard compacto label="Datos limpios" value={`${String(resumen.porcentaje_limpio ?? 0).replace('.', ',')} %`} icon="verified" tono="primary"
            hint={`De ${Number(resumen.capturas_totales || 0).toLocaleString('es-VE')} capturas`} />
          <StatCard compacto label="Marcadas válidas" icon="check_circle" tono="neutral"
            value={resumen.validas ?? Math.max((resumen.revisadas || 0) - (resumen.descartadas || 0), 0)}
            hint="Volvieron a los análisis" onClick={sinFase34 ? undefined : () => setVer('valida')} title="Ver las válidas" />
          <StatCard compacto label="Marcadas erróneas" value={resumen.descartadas ?? 0} icon="block" tono="neutral"
            hint="Fuera de los análisis" onClick={sinFase34 ? undefined : () => setVer('erronea')} title="Ver las erróneas" />
        </section>
      )}

      <section className="m3-data-table" aria-label="Capturas">
        <div className="m3-data-table-toolbar flex flex-col gap-3">
          <BarraFiltros integrada limpiar={{ visible: hayFiltros, onClick: limpiar }} filtrar={<>
            {!sinFase34 && (
              <Segmentado etiqueta="Qué capturas ver" valor={ver} onChange={setVer}
                opciones={Object.entries(VISTAS).map(([v, t]) => [v, t, v === 'pendiente' ? 'Aún sin revisar' : `Las que marcaste como ${t.toLowerCase().slice(0, -1)}`])} />
            )}
            <FiltroChip etiqueta="Motivo" icono="filter_list" valor={motivo} onChange={setMotivo}
              opciones={[['todos', 'Motivo: todos'], ...Object.entries(MOTIVOS).filter(([k]) => conteo(k) > 0).map(([k, [t]]) => [k, `${t} (${conteo(k)})`])]} />
            <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
              opciones={[['todos', 'Cadena: todas'], ...cadenasEnLista.map(id => [id, nombreCadena(id)])]} />
            <FiltroChip etiqueta="Relación" icono="link" valor={relacion} onChange={setRelacion}
              opciones={[['todos', 'Relación: todas'], ['propio', 'Solo tus enlaces'], ['competencia', 'Solo competencia']]} />
          </>} />
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)}
                placeholder="Buscar por ID, producto, laboratorio o nombre leído" aria-label="Buscar captura" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant mr-2">{visibles.length} de {capturas.length}</span>
              <InfoGrafico alinear="derecha" titulo="Revisión de capturas"
                que="El robot marca una captura como dudosa cuando el nombre leído no se parece al del catálogo o el precio salta más que el umbral. Mientras está pendiente, no cuenta en promedios ni brechas."
                formula={[
                  'Es válida → vuelve a contar en los análisis',
                  'Es errónea → queda fuera, pero el dato se guarda',
                  'Volver a revisar → regresa a pendientes (en Válidas o Erróneas)',
                ]}
                lectura="La pista de cada captura sale de la lectura SIGUIENTE del mismo enlace: si repite el precio, el cambio fue real; si vuelve al anterior, fue un error de lectura. Si el enlace apunta al producto equivocado, usa «Corregir enlace»." />
              <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
                <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
              </button>
            </div>
          </div>
        </div>

        {cargando && capturas.length === 0 ? (
          <div className="h-48 m3-skeleton m-4 rounded-2xl" aria-busy="true" />
        ) : visibles.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 px-6 text-center text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl text-[color:var(--md-sys-color-data-positive)]" aria-hidden="true">
              {hayFiltros ? 'filter_alt_off' : 'task_alt'}
            </span>
            <p className="m3-title-medium text-on-surface">
              {hayFiltros ? 'Ninguna captura con estos filtros' : ver === 'pendiente' ? 'No hay nada que revisar' : `Aún no hay capturas ${VISTAS[ver].toLowerCase()}`}
            </p>
            {!hayFiltros && ver === 'pendiente' && <p className="m3-body-medium">Todas pasaron el control de calidad o ya fueron revisadas.</p>}
          </div>
        ) : (
          <ul className="m3-revision-lista" aria-busy={cargando}>
            {visibles.slice(0, limite).map(c => (
              <FilaCaptura key={c.captura_id} captura={c} ver={ver} nombreCadena={nombreCadena}
                procesando={procesando === c.captura_id} onDecidir={decidir} />
            ))}
          </ul>
        )}
        {visibles.length > limite && (
          <div className="flex justify-center p-3 border-t border-outline-variant">
            <button type="button" className="m3-btn-text" onClick={() => setLimite(l => l + POR_PAGINA)}>
              Mostrar {Math.min(POR_PAGINA, visibles.length - limite)} más
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function FilaCaptura({ captura: c, ver, nombreCadena, procesando, onDecidir }) {
  const variacion = c.variacion_pct == null ? null : Number(c.variacion_pct);
  const [motivoTexto, motivoIcono] = MOTIVOS[c.motivo_sospecha] || [c.motivo_sospecha || 'Dudosa', 'help'];
  const pista = sugerencia(c);
  const nombreDistinto = c.nombre_capturado && normalizar(c.nombre_capturado) !== normalizar(c.producto_nombre);

  return (
    <li className="m3-revision-item">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="m3-chip-motivo"><span className="material-symbols-outlined" aria-hidden="true">{motivoIcono}</span>{motivoTexto}</span>
          <span className="inline-flex items-center gap-1.5 m3-label-medium text-on-surface-variant">
            <CadenaBadge cadena={c.cadena_id} tamano="xs" title="" />{nombreCadena(c.cadena_id)}
          </span>
          {c.es_propio && <span className="m3-chip-propio">Tú</span>}
          <span className="m3-label-medium text-on-surface-variant tabular-nums">{fecha(c.fecha_captura)}</span>
          {c.pendientes_enlace > 1 && ver === 'pendiente' && (
            <span className="m3-label-small text-on-surface-variant" title="Capturas pendientes de este mismo enlace">
              · {c.pendientes_enlace} de este enlace
            </span>
          )}
        </div>
        <div className="m3-title-small text-on-surface mt-1 truncate" title={c.producto_nombre}>{c.producto_nombre}</div>
        <div className="m3-body-small text-on-surface-variant truncate">
          {[c.id_producto_propio, c.laboratorio, !c.es_propio && c.producto_propio_nombre ? `frente a ${c.producto_propio_nombre}` : null].filter(Boolean).join(' · ')}
        </div>
        {nombreDistinto && (
          <div className="m3-body-small mt-1">
            <span className="text-on-surface-variant">Se leyó: </span>
            <span className="text-error">«{c.nombre_capturado}»</span>
            {c.similitud_nombre != null && (
              <span className="text-on-surface-variant"> · {Math.round(c.similitud_nombre * 100)} % de parecido</span>
            )}
          </div>
        )}
        {pista && (
          <div className={`m3-revision-pista ${pista.tipo ? `is-${pista.tipo}` : ''}`}>
            <span className="material-symbols-outlined" aria-hidden="true">{pista.tipo ? 'lightbulb' : 'schedule'}</span>
            {pista.texto}
          </div>
        )}
      </div>

      {/* Anterior -> capturado -> siguiente: el contexto para juzgar */}
      <div className="m3-revision-precios">
        <Precio rotulo="Anterior" valor={c.precio_anterior_bs} />
        <span className="material-symbols-outlined text-on-surface-variant text-[18px]" aria-hidden="true">arrow_forward</span>
        <div className="text-right">
          <div className="m3-label-small text-on-surface-variant">Capturado</div>
          <div className="m3-body-large font-medium tabular-nums text-on-surface">{bs(c.precio_bs)}</div>
          <div className="m3-label-small tabular-nums text-on-surface-variant">
            {c.precio_usd != null && `$${Number(c.precio_usd).toFixed(2)}`}
            {variacion != null && (
              <span className={`ml-1 font-semibold ${variacion > 0 ? 'text-error' : 'text-primary'}`}>
                {variacion > 0 ? '+' : variacion < 0 ? '−' : ''}{Math.abs(variacion).toLocaleString('es-VE')} %
              </span>
            )}
          </div>
        </div>
        {'precio_siguiente_bs' in c && (
          <>
            <span className="material-symbols-outlined text-on-surface-variant text-[18px]" aria-hidden="true">arrow_forward</span>
            <Precio rotulo="Siguiente" valor={c.precio_siguiente_bs} />
          </>
        )}
      </div>

      <div className="m3-revision-acciones">
        <a href={c.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir la página en la tienda" aria-label="Abrir en la tienda">
          <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </a>
        <Link to={`/competencia?editar=${c.publicacion_id}&volver=revision`} className="m3-btn-text" title="Abrir el formulario de este enlace en Competencia">
          <span className="material-symbols-outlined" aria-hidden="true">edit</span>
          Corregir enlace
        </Link>
        {ver === 'pendiente' ? (
          <div className="m3-revision-decision">
            <button type="button" onClick={() => onDecidir(c, 'erronea')} disabled={procesando}
              className="m3-btn-danger-outline h-10 px-4" title="Descartar: deja de contar en los análisis">
              Es errónea
            </button>
            <button type="button" onClick={() => onDecidir(c, 'valida')} disabled={procesando}
              className="m3-btn-primary h-10 px-4" title="Confirmar: vuelve a contar en los análisis">
              Es válida
            </button>
          </div>
        ) : (
          <div className="m3-revision-decision">
            <span className={`m3-revision-estado is-${ver}`}>
              <span className="material-symbols-outlined" aria-hidden="true">{ver === 'valida' ? 'check_circle' : 'block'}</span>
              {ver === 'valida' ? 'Válida' : 'Errónea'}
            </span>
            <button type="button" onClick={() => onDecidir(c, 'pendiente')} disabled={procesando}
              className="m3-btn-outline h-10 px-4" title="Quitar la decisión: vuelve a pendientes">
              <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">undo</span>
              Volver a revisar
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Precio({ rotulo, valor }) {
  return (
    <div className="text-right">
      <div className="m3-label-small text-on-surface-variant">{rotulo}</div>
      <div className="m3-body-medium tabular-nums text-on-surface-variant">{bs(valor)}</div>
    </div>
  );
}
