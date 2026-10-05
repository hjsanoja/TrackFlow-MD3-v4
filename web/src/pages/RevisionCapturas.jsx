import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import AvisoRobot from '../components/AvisoRobot';
import GitHubConfigModal from '../components/GitHubConfigModal';
import Sensibilidad from '../components/revision/Sensibilidad';
import PreciosRepetidos from '../components/revision/PreciosRepetidos';
import HistorialRevision from '../components/revision/HistorialRevision';
import { haceCuanto, fechaHora } from '../utils/usuarios';
import { normalizar } from '../components/formulario';
import { useRobot } from '../hooks/useRobot';
import { avisarCambioRevision } from '../hooks/usePendientesRevision';
import { leerConsulta, guardarConsulta } from '../utils/cacheConsultas';
import { publicacionIdDe } from '../utils/dbClient';
import { describirPresentacion } from '../utils/presentacion';
import LecturaEnlace from '../components/revision/LecturaEnlace';

/**
 * Bandeja de revisión de capturas sospechosas.
 *
 * Un trigger marca como dudosa la captura cuyo nombre leído no se parece al
 * del catálogo, cuya dosis o tamaño no son los registrados (fase 35) o cuyo
 * precio salta más que el umbral de config_calidad. Hasta revisarla no entra
 * en los promedios ni en las brechas.
 *
 *   "Es válida"  -> revisado_manual, sin marca: vuelve a los análisis
 *   "Es errónea" -> revisado_manual, con marca: fuera, pero el dato se conserva
 *   "Volver a revisar" -> sin revisar y con marca: de nuevo pendiente
 *
 * Las ya revisadas se leen de v_capturas_revision (fase 34). Sin esa fase
 * solo se ven las pendientes, desde v_capturas_sospechosas (fase 12).
 */
const MOTIVOS = {
  presentacion: ['Dosis o tamaño distinto', 'straighten'],
  precio_repetido: ['Precio repetido', 'content_copy'],
  nombre: ['El nombre no coincide', 'badge'],
  variacion_precio: ['Salto de precio', 'trending_up'],
  ambos: ['Varios motivos', 'report'],
  legacy: ['Dato migrado', 'history'],
};
const VISTAS = { pendiente: 'Pendientes', valida: 'Válidas', erronea: 'Erróneas' };
const POR_PAGINA = 30;
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

const bs = (v) => (v == null ? '—' : `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fecha = (v) => (v ? new Date(v).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const cerca = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / b <= 0.05;
const num = (v) => (v == null ? null : Number(v));
const decimal = (v) => String(Number(v)).replace('.', ',');

// "50 mg x 30", "x 120 ml"... a partir de dosis (mg) y tamaño.
function presentacion(dosis, tamano, unidad) {
  const partes = [];
  if (dosis != null) partes.push(Number(dosis) >= 1000 && Number(dosis) % 1000 === 0 ? `${Number(dosis) / 1000} g` : `${decimal(dosis)} mg`);
  if (tamano != null) partes.push(`x ${decimal(tamano)}${unidad === 'ml' ? ' ml' : unidad === 'g' ? ' g' : ''}`);
  return partes.join(' ');
}

// Lo leído en la tienda contra lo registrado: solo cuenta lo que hay en los dos lados.
function diferenciaPresentacion(c) {
  const ld = num(c.leida_dosis_mg); const rd = num(c.registrada_dosis_mg);
  const lt = num(c.leida_tamano); const rt = num(c.registrada_tamano);
  const dosis = ld != null && rd != null && Math.abs(ld - rd) > 0.001;
  const tamano = lt != null && rt != null && (c.leida_unidad || 'unidad') === (c.registrada_unidad || 'unidad') && Math.abs(lt - rt) > 0.001;
  if (!dosis && !tamano) return null;
  return {
    leida: presentacion(dosis ? ld : null, tamano ? lt : null, c.leida_unidad),
    registrada: presentacion(dosis ? rd : null, tamano ? rt : null, c.registrada_unidad),
  };
}

// Pista para decidir: la presentación, y la lectura siguiente del mismo enlace.
function sugerencia(c) {
  const pres = diferenciaPresentacion(c);
  if (pres) {
    return { tipo: 'erronea', texto: 'Si el enlace apunta a otra presentación, corrígelo; si no, márcala errónea.' };
  }
  const actual = Number(c.precio_bs);
  const ant = num(c.precio_anterior_bs);
  const sig = num(c.precio_siguiente_bs);
  if (sig != null && ant != null && cerca(sig, ant) && !cerca(actual, ant)) {
    return { tipo: 'erronea', texto: 'La lectura siguiente volvió al precio anterior: parece un error de lectura.' };
  }
  if (sig != null && cerca(sig, actual)) {
    return { tipo: 'valida', texto: 'La lectura siguiente repite este precio: parece un cambio real.' };
  }
  if ((c.motivo_sospecha === 'nombre') && ant != null && cerca(actual, ant)) {
    return { tipo: 'valida', texto: 'El precio es igual al anterior: quizá la tienda solo escribe el nombre distinto.' };
  }
  if (sig == null && 'precio_siguiente_bs' in c) return { tipo: null, texto: 'Aún no hay otra lectura de este enlace después de esta. Usa «Volver a leer» para comprobarlo ahora.' };
  return null;
}

// Guarda la decision de varias capturas. estado: 'valida' | 'erronea' | 'pendiente'.
async function guardarDecision(ids, estado) {
  const cambios = estado === 'pendiente'
    ? { revisado_manual: false, sospechoso: true }
    : { revisado_manual: true, sospechoso: estado === 'erronea' };
  let hechas = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('fact_precios').update(cambios).in('id', ids.slice(i, i + 150)).select('id');
    if (error) throw error;
    hechas += data?.length || 0;
  }
  // Solo se pueden tocar estos campos (permiso de la fase 12).
  if (hechas === 0) throw new Error('No se guardó el cambio. Ejecuta fase12_bandeja_revision.sql en Supabase.');
  return hechas;
}

export default function RevisionCapturas() {
  const { cadenas = [], productosCompetencia = [], productos = [] } = useData() || {};
  const { addToast } = useToast();
  const [ver, setVer] = useState('pendiente');
  const [capturas, setCapturas] = useState([]);
  const [decisiones, setDecisiones] = useState(() => new Map()); // captura_id -> ultima decision (fase 47)
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [sinFase34, setSinFase34] = useState(false);
  const [procesando, setProcesando] = useState(false);
  const [seleccion, setSeleccion] = useState(() => new Set());
  const [motivo, setMotivo] = useState('todos');
  const [cadena, setCadena] = useState('todos');
  const [relacion, setRelacion] = useState('todos');
  const [producto, setProducto] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const [limite, setLimite] = useState(POR_PAGINA);
  const [verSensibilidad, setVerSensibilidad] = useState(false);
  const [verGithub, setVerGithub] = useState(false);

  const nombreCadena = useMemo(() => {
    const m = new Map(cadenas.map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);

  // Enlace de Relacion de cada publicacion: lo necesita el robot.
  const enlacePorPub = useMemo(() => new Map(productosCompetencia.map(it => [publicacionIdDe(it), it])), [productosCompetencia]);
  // Tu producto (el que se compara) por su ID, con laboratorio y presentacion.
  const propioPorId = useMemo(() => new Map(productos.map(p => [String(p.id_interno).trim(), p])), [productos]);

  // Umbrales con los que se marco (Sensibilidad): para explicar el porque.
  const [umbrales, setUmbrales] = useState(null);
  useEffect(() => {
    if (!isSupabaseActive()) return;
    supabase.from('config_calidad').select('clave, valor').then(({ data }) => {
      if (data) setUmbrales(Object.fromEntries(data.map(r => [r.clave, Number(r.valor)])));
    });
  }, [verSensibilidad]);

  const cargarResumen = useCallback(async () => {
    const { data, error } = await supabase.from('v_calidad_datos').select('*').maybeSingle();
    if (!error) setResumen(data);
  }, []);

  // Bandeja que se esta mirando: una respuesta de otra que llegue tarde no se pinta.
  const verRef = useRef(ver);
  verRef.current = ver;

  const cargar = useCallback(async () => {
    if (!isSupabaseActive() || ver === 'repetidos' || ver === 'historial') { setCargando(false); return; }
    // Lo ultimo leido de esta bandeja sale al instante; se pide de nuevo por detras.
    const clave = `revision:${ver}`;
    const previo = leerConsulta(clave);
    if (previo) {
      setCapturas(previo.datos.capturas);
      setDecisiones(previo.datos.decisiones);
      setCargando(false);
    } else {
      setCargando(true);
    }
    try {
      // fn_capturas_revision (fase 48) elige primero las 500 y calcula solo esas.
      let { data, error } = await supabase.rpc('fn_capturas_revision', { p_estado: ver, p_limite: 500 });
      if (error && faltaVista(error)) {
        ({ data, error } = await supabase.from('v_capturas_revision').select('*')
          .eq('estado_revision', ver).order('fecha_captura', { ascending: false }).limit(500));
      }
      if (error && faltaVista(error)) {
        setSinFase34(true);
        ({ data, error } = ver === 'pendiente'
          ? await supabase.from('v_capturas_sospechosas').select('*').order('fecha_captura', { ascending: false }).limit(500)
          : { data: [], error: null });
      }
      if (error) throw error;
      if (verRef.current !== ver) return;
      setCapturas(data || []);
      setCargando(false);
      cargarResumen();
      // Quien decidio cada una (solo en Validas / Erroneas; sin la fase 47 no hay).
      const m = new Map();
      if (ver !== 'pendiente' && data?.length) {
        const { data: h } = await supabase.from('v_revision_historial').select('captura_id, usuario, usuario_nombre, fecha')
          .in('captura_id', data.map(c => c.captura_id)).order('fecha', { ascending: false });
        for (const d of h || []) if (!m.has(d.captura_id)) m.set(d.captura_id, d);
        if (verRef.current === ver) setDecisiones(m);
      }
      guardarConsulta(clave, { capturas: data || [], decisiones: m });
    } catch (err) {
      console.error('Error cargando la bandeja de revisión:', err);
      addToast(`No se pudo cargar la bandeja: ${err.message}`, 'error');
    } finally {
      setCargando(false);
    }
  }, [ver, addToast, cargarResumen]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { setLimite(POR_PAGINA); setSeleccion(new Set()); }, [ver, motivo, cadena, relacion, producto, busqueda]);

  const robot = useRobot({
    onTerminado: ({ leidos }) => {
      cargar();
      addToast(`Robot terminado: ${leidos} ${leidos === 1 ? 'enlace leído' : 'enlaces leídos'}. Mira la lectura siguiente de cada captura.`, 'success');
    },
    onError: (mensaje, { faltaConfig } = {}) => {
      if (faltaConfig) setVerGithub(true);
      addToast(mensaje, faltaConfig ? 'info' : 'error');
    },
  });

  // Vuelve a leer ahora los enlaces de estas capturas.
  const releer = async (lista) => {
    const enlaces = [...new Map(lista.map(c => [c.publicacion_id, enlacePorPub.get(Number(c.publicacion_id))])).values()].filter(Boolean);
    if (enlaces.length === 0) { addToast('No se encontró el enlace en Relación.', 'warning'); return false; }
    const ok = await robot.lanzar(enlaces, []);
    if (ok) addToast(`Robot lanzado para ${enlaces.length} ${enlaces.length === 1 ? 'enlace' : 'enlaces'}. Tarda unos minutos.`, 'info');
    return ok;
  };

  const decidir = async (lista, estado) => {
    const ids = lista.map(c => c.captura_id);
    setProcesando(true);
    try {
      const hechas = await guardarDecision(ids, estado);
      const quitar = new Set(ids);
      setCapturas(prev => prev.filter(x => !quitar.has(x.captura_id)));
      setSeleccion(new Set());
      cargarResumen();
      avisarCambioRevision();
      const cuantas = hechas === 1 ? 'Captura' : `${hechas} capturas`;
      const textos = {
        valida: `${cuantas} ${hechas === 1 ? 'marcada' : 'marcadas'} como ${hechas === 1 ? 'válida' : 'válidas'}: ${hechas === 1 ? 'vuelve' : 'vuelven'} a contar en los análisis.`,
        erronea: `${cuantas} ${hechas === 1 ? 'marcada' : 'marcadas'} como ${hechas === 1 ? 'errónea' : 'erróneas'}: ya no ${hechas === 1 ? 'afecta' : 'afectan'} los análisis.`,
        pendiente: `${cuantas} de nuevo en pendientes.`,
      };
      const vistaAntes = ver;
      addToast(textos[estado], 'success', {
        accion: {
          texto: 'Deshacer',
          onClick: async () => {
            try {
              await guardarDecision(ids, vistaAntes);
              avisarCambioRevision();
              cargar();
            } catch (err) { addToast(`No se pudo deshacer: ${err.message}`, 'error'); }
          },
        },
      });
    } catch (err) {
      addToast(`No se pudo guardar: ${err.message}`, 'error');
    } finally {
      setProcesando(false);
    }
  };

  const cadenasEnLista = useMemo(() => [...new Set(capturas.map(c => c.cadena_id))], [capturas]);

  // Tus productos (los que tienen capturas en la lista), para el filtro.
  const productosEnLista = useMemo(() => {
    const m = new Map();
    for (const c of capturas) {
      const id = String(c.id_producto_propio).trim();
      if (!m.has(id)) m.set(id, { id, nombre: propioPorId.get(id)?.nombre || c.producto_propio_nombre || c.producto_nombre, n: 0 });
      m.get(id).n += 1;
    }
    return [...m.values()].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }, [capturas, propioPorId]);

  // Primero las capturas de TUS enlaces (afectan tu precio); dentro de cada
  // grupo, las mas recientes primero (el orden en que llegan).
  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return capturas.filter(c =>
      (motivo === 'todos' || c.motivo_sospecha === motivo)
      && (cadena === 'todos' || c.cadena_id === cadena)
      && (relacion === 'todos' || (relacion === 'propio') === Boolean(c.es_propio))
      && (producto === 'todos' || String(c.id_producto_propio).trim() === producto)
      && (!t || normalizar(`${c.id_producto_propio} ${c.producto_nombre} ${c.producto_propio_nombre || ''} ${c.laboratorio} ${c.nombre_capturado || ''}`).includes(t)))
      .map((c, i) => [c, i]).sort((a, b) => (b[0].es_propio ? 1 : 0) - (a[0].es_propio ? 1 : 0) || a[1] - b[1]).map(([c]) => c);
  }, [capturas, motivo, cadena, relacion, producto, busqueda]);

  // Pendientes / Válidas / Erróneas y, aparte, los precios repetidos (fase 44).
  const selectorVista = sinFase34 ? null : (
    <Segmentado etiqueta="Qué capturas ver" valor={ver} onChange={setVer}
      opciones={[
        ...Object.entries(VISTAS).map(([v, t]) => [v, t, v === 'pendiente' ? 'Aún sin revisar' : `Las que marcaste como ${t.toLowerCase().slice(0, -1)}`]),
        ['repetidos', 'Precios repetidos', 'Productos distintos de una cadena con el mismo precio exacto'],
        ['historial', 'Historial', 'Quién marcó cada captura y cuándo'],
      ]} />
  );

  const hayFiltros = motivo !== 'todos' || cadena !== 'todos' || relacion !== 'todos' || producto !== 'todos' || busqueda !== '';
  const limpiar = () => { setMotivo('todos'); setCadena('todos'); setRelacion('todos'); setProducto('todos'); setBusqueda(''); };
  const conteo = (clave) => capturas.filter(c => c.motivo_sospecha === clave).length;

  const seleccionadas = visibles.filter(c => seleccion.has(c.captura_id));
  const todasSeleccionadas = visibles.length > 0 && seleccionadas.length === visibles.length;
  const alternar = (id) => setSeleccion(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const alternarTodas = () => setSeleccion(todasSeleccionadas ? new Set() : new Set(visibles.map(c => c.captura_id)));
  // "N de este enlace": selecciona todas las capturas visibles de ese enlace.
  const seleccionarEnlace = (pub) => setSeleccion(new Set(visibles.filter(c => c.publicacion_id === pub).map(c => c.captura_id)));

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

      <AvisoRobot robot={robot} />

      {resumen && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen">
          <StatCard compacto label="Pendientes" value={resumen.pendientes ?? 0} icon="rule"
            tono={resumen.pendientes > 0 ? 'warning' : 'positive'} hint="Hoy no entran en los análisis"
            onClick={() => setVer('pendiente')} title="Ver las pendientes" />
          <StatCard compacto label="Datos limpios" value={`${decimal(resumen.porcentaje_limpio ?? 0)} %`} icon="verified" tono="primary"
            hint={`De ${Number(resumen.capturas_totales || 0).toLocaleString('es-VE')} capturas`} />
          <StatCard compacto label="Marcadas válidas" icon="check_circle" tono="neutral"
            value={resumen.validas ?? Math.max((resumen.revisadas || 0) - (resumen.descartadas || 0), 0)}
            hint="Volvieron a los análisis" onClick={sinFase34 ? undefined : () => setVer('valida')} title="Ver las válidas" />
          <StatCard compacto label="Marcadas erróneas" value={resumen.descartadas ?? 0} icon="block" tono="neutral"
            hint="Fuera de los análisis" onClick={sinFase34 ? undefined : () => setVer('erronea')} title="Ver las erróneas" />
        </section>
      )}

      {ver === 'repetidos' ? (
        <PreciosRepetidos selector={selectorVista} nombreCadena={nombreCadena} releer={releer} robotOcupado={Boolean(robot.corrida)} />
      ) : ver === 'historial' ? (
        <HistorialRevision selector={selectorVista} nombreCadena={nombreCadena} />
      ) : (
      <section className="m3-data-table" aria-label="Capturas">
        <div className="m3-data-table-toolbar flex flex-col gap-3">
          {seleccion.size > 0 ? (
            <div className="m3-selection-bar" role="toolbar" aria-label="Acciones sobre las capturas seleccionadas">
              <button type="button" onClick={() => setSeleccion(new Set())} disabled={procesando}
                className="m3-icon-btn" title="Quitar selección" aria-label="Quitar selección">
                <span className="material-symbols-outlined">close</span>
              </button>
              <div className="flex flex-col min-w-0 mr-auto">
                <span className="m3-title-medium">
                  {procesando ? 'Guardando…' : `${seleccionadas.length} ${seleccionadas.length === 1 ? 'seleccionada' : 'seleccionadas'}`}
                </span>
                {!todasSeleccionadas && (
                  <button type="button" onClick={alternarTodas} className="self-start text-primary m3-label-medium hover:underline">
                    Seleccionar las {visibles.length} de esta lista
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button data-edita type="button" onClick={() => releer(seleccionadas)} disabled={procesando || Boolean(robot.corrida)} className="m3-btn-tonal"
                  title={robot.corrida ? 'Ya hay una lectura en curso' : 'El robot lee ahora los enlaces de estas capturas'}>
                  <span className="material-symbols-outlined" aria-hidden="true">sync</span>
                  Volver a leer
                </button>
                {ver === 'pendiente' ? (
                  <>
                    <button data-edita type="button" onClick={() => decidir(seleccionadas, 'erronea')} disabled={procesando} className="m3-btn-danger-outline h-10 px-4">Son erróneas</button>
                    <button data-edita type="button" onClick={() => decidir(seleccionadas, 'valida')} disabled={procesando} className="m3-btn-primary h-10 px-4">Son válidas</button>
                  </>
                ) : (
                  <button data-edita type="button" onClick={() => decidir(seleccionadas, 'pendiente')} disabled={procesando} className="m3-btn-outline h-10 px-4">
                    <span className="material-symbols-outlined text-[18px] mr-1" aria-hidden="true">undo</span>
                    Volver a revisar
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <BarraFiltros integrada limpiar={{ visible: hayFiltros, onClick: limpiar }} filtrar={<>
                {selectorVista}
                <FiltroChip etiqueta="Motivo" icono="filter_list" valor={motivo} onChange={setMotivo}
                  opciones={[['todos', 'Motivo: todos'], ...Object.entries(MOTIVOS).filter(([k]) => conteo(k) > 0).map(([k, [t]]) => [k, `${t} (${conteo(k)})`])]} />
                <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
                  opciones={[['todos', 'Cadena: todas'], ...cadenasEnLista.map(id => [id, nombreCadena(id)])]} />
                <FiltroChip etiqueta="Producto" icono="medication" valor={producto} onChange={setProducto}
                  opciones={[['todos', 'Producto: todos'], ...productosEnLista.map(x => [x.id, `${x.nombre} (${x.n})`])]} />
                <FiltroChip etiqueta="De quién es el enlace" icono="link" valor={relacion} onChange={setRelacion}
                  opciones={[['todos', 'Enlaces: todos'], ['propio', 'Solo tus enlaces'], ['competencia', 'Solo competencia']]} />
              </>} />
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <label className="m3-search-field">
                  <span className="material-symbols-outlined" aria-hidden="true">search</span>
                  <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)}
                    placeholder="Buscar por ID, producto, laboratorio o nombre leído" aria-label="Buscar captura" />
                </label>
                <div className="flex items-center gap-1 md:ml-auto">
                  <span className="m3-label-large text-on-surface-variant mr-2">{visibles.length} de {capturas.length}</span>
                  <button data-edita type="button" onClick={() => setVerSensibilidad(true)} className="m3-btn-text" title="Cuándo se marca una captura como dudosa">
                    <span className="material-symbols-outlined" aria-hidden="true">tune</span>
                    Sensibilidad
                  </button>
                  <InfoGrafico alinear="derecha" titulo="Revisión de capturas"
                    que="El robot marca una captura como dudosa cuando el nombre leído no se parece al del catálogo, la dosis o el tamaño no son los registrados, o el precio salta más que el umbral. Mientras está pendiente, no cuenta en promedios ni brechas."
                    formula={[
                      'Es válida → vuelve a contar en los análisis',
                      'Es errónea → queda fuera, pero el dato se guarda',
                      'Volver a revisar → regresa a pendientes (en Válidas o Erróneas)',
                    ]}
                    lectura="La pista de cada captura sale de la presentación leída y de la lectura SIGUIENTE del mismo enlace: si repite el precio, el cambio fue real; si vuelve al anterior, fue un error de lectura. La línea pequeña son las últimas lecturas del enlace; el punto grande es esta captura y los rojos están marcados. Marca la casilla de varias para decidir en lote." />
                  <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
                    <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
                  </button>
                </div>
              </div>
            </>
          )}
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
          <>
            <label className="m3-revision-todas">
              <input type="checkbox" className="m3-checkbox" checked={todasSeleccionadas} onChange={alternarTodas}
                ref={el => { if (el) el.indeterminate = seleccionadas.length > 0 && !todasSeleccionadas; }} />
              Seleccionar todas
            </label>
            <ul className="m3-revision-lista" aria-busy={cargando}>
              {visibles.slice(0, limite).map(c => (
                <FilaCaptura key={c.captura_id} captura={c} ver={ver} nombreCadena={nombreCadena}
                  propio={propioPorId.get(String(c.id_producto_propio).trim())} umbrales={umbrales} decision={decisiones.get(c.captura_id)}
                  seleccionada={seleccion.has(c.captura_id)} onSeleccionar={() => alternar(c.captura_id)}
                  onSeleccionarEnlace={() => seleccionarEnlace(c.publicacion_id)}
                  procesando={procesando} leyendo={robot.leyendo(enlacePorPub.get(Number(c.publicacion_id)))}
                  robotOcupado={Boolean(robot.corrida)} onReleer={() => releer([c])}
                  onDecidir={(estado) => decidir([c], estado)} />
              ))}
            </ul>
          </>
        )}
        {visibles.length > limite && (
          <div className="flex justify-center p-3 border-t border-outline-variant">
            <button type="button" className="m3-btn-text" onClick={() => setLimite(l => l + POR_PAGINA)}>
              Mostrar {Math.min(POR_PAGINA, visibles.length - limite)} más
            </button>
          </div>
        )}
      </section>
      )}

      {verSensibilidad && (
        <Sensibilidad onClose={() => setVerSensibilidad(false)}
          onAplicado={() => { avisarCambioRevision(); if (ver === 'pendiente') cargar(); else cargarResumen(); }} />
      )}
      <GitHubConfigModal isOpen={verGithub} onClose={() => setVerGithub(false)} />
    </div>
  );
}

function FilaCaptura({ captura: c, ver, nombreCadena, propio, umbrales, decision, seleccionada, onSeleccionar, onSeleccionarEnlace, procesando, leyendo, robotOcupado, onReleer, onDecidir }) {
  const variacion = num(c.variacion_pct);
  const [motivoTexto, motivoIcono] = MOTIVOS[c.motivo_sospecha] || [c.motivo_sospecha || 'Dudosa', 'help'];
  const pista = sugerencia(c);
  const razones = porQue(c, umbrales);

  return (
    <li className={`m3-revision-item ${seleccionada ? 'is-seleccionada' : ''}`}>
      <input type="checkbox" className="m3-checkbox m3-revision-check" checked={seleccionada} onChange={onSeleccionar}
        aria-label={`Seleccionar ${c.producto_nombre}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="m3-chip-motivo"><span className="material-symbols-outlined" aria-hidden="true">{motivoIcono}</span>{motivoTexto}</span>
          <span className="inline-flex items-center gap-1.5 m3-label-medium text-on-surface-variant">
            <CadenaBadge cadena={c.cadena_id} tamano="xs" title="" />{nombreCadena(c.cadena_id)}
          </span>
          <span className="m3-label-medium text-on-surface-variant tabular-nums">{fecha(c.fecha_captura)}</span>
          {c.pendientes_enlace > 1 && ver === 'pendiente' && (
            <button type="button" onClick={onSeleccionarEnlace} className="m3-revision-enlace" title="Seleccionar todas las capturas pendientes de este enlace">
              {c.pendientes_enlace} de este enlace
            </button>
          )}
        </div>
        <Comparacion c={c} propio={propio} umbrales={umbrales} />
        {razones.length > 0 && (
          <div className="m3-revision-porque">
            <span className="material-symbols-outlined" aria-hidden="true">info</span>
            <span><strong className="font-medium">Por qué está aquí: </strong>{razones.join(' ')}</span>
          </div>
        )}
        {pista && (
          <div className={`m3-revision-pista ${pista.tipo ? `is-${pista.tipo}` : ''}`}>
            <span className="material-symbols-outlined" aria-hidden="true">{pista.tipo ? 'lightbulb' : 'schedule'}</span>
            {pista.texto}
          </div>
        )}
      </div>

      {/* Anterior -> capturado -> siguiente, y las ultimas lecturas del enlace */}
      <div className="m3-revision-contexto">
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
        {Array.isArray(c.historial) && c.historial.length > 2 && <MiniHistorial lecturas={c.historial} />}
      </div>

      <div className="m3-revision-acciones">
        <a href={c.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir la página en la tienda" aria-label="Abrir en la tienda">
          <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </a>
        <button data-edita type="button" onClick={onReleer} disabled={robotOcupado} className="m3-icon-btn"
          title={leyendo ? 'El robot está leyendo este enlace' : robotOcupado ? 'Ya hay una lectura en curso' : 'Volver a leer ahora este enlace'} aria-label="Volver a leer">
          <span className={`material-symbols-outlined ${leyendo ? 'animate-spin' : ''}`} aria-hidden="true">sync</span>
        </button>
        <Link data-edita to={`/competencia?editar=${c.publicacion_id}&volver=revision`} className="m3-btn-text" title="Abrir el formulario de este enlace en Relación">
          <span className="material-symbols-outlined" aria-hidden="true">edit</span>
          Corregir enlace
        </Link>
        {ver === 'pendiente' ? (
          <div className="m3-revision-decision">
            <button data-edita type="button" onClick={() => onDecidir('erronea')} disabled={procesando}
              className="m3-btn-danger-outline h-10 px-4" title="Descartar: deja de contar en los análisis">
              Es errónea
            </button>
            <button data-edita type="button" onClick={() => onDecidir('valida')} disabled={procesando}
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
            {decision && (
              <span className="m3-body-small text-on-surface-variant" title={fechaHora(decision.fecha)}>
                por {decision.usuario_nombre || decision.usuario || 'alguien'} · {haceCuanto(decision.fecha).toLowerCase()}
              </span>
            )}
            <button data-edita type="button" onClick={() => onDecidir('pendiente')} disabled={procesando}
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

// Linea con las lecturas del enlace alrededor de la captura: el punto grande
// es esta captura; los rojos, lecturas marcadas como dudosas.
function MiniHistorial({ lecturas }) {
  const ancho = 168;
  const alto = 30;
  const precios = lecturas.map(l => Number(l.p));
  const min = Math.min(...precios);
  const max = Math.max(...precios);
  const rango = max - min || 1;
  const x = (i) => 5 + (i / (lecturas.length - 1)) * (ancho - 10);
  const y = (v) => (max === min ? alto / 2 : alto - 5 - ((v - min) / rango) * (alto - 10));
  const puntos = lecturas.map((l, i) => `${x(i).toFixed(1)},${y(Number(l.p)).toFixed(1)}`).join(' ');
  const resumen = lecturas.map(l => `${fecha(l.f)}: ${bs(l.p)}${l.a ? ' (esta)' : ''}${l.s && !l.a ? ' (marcada)' : ''}`).join('\n');
  return (
    <svg className="m3-revision-historial" width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} role="img"
      aria-label={`Últimas ${lecturas.length} lecturas del enlace`}>
      <title>{resumen}</title>
      <polyline points={puntos} fill="none" stroke="var(--md-sys-color-outline)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {lecturas.map((l, i) => (
        <circle key={i} cx={x(i)} cy={y(Number(l.p))} r={l.a ? 4.5 : 2.5}
          fill={l.a || l.s ? 'var(--md-sys-color-error)' : 'var(--md-sys-color-primary)'}
          stroke={l.a ? 'var(--md-sys-color-surface-container-lowest)' : 'none'} strokeWidth="2" />
      ))}
    </svg>
  );
}

// Presentacion de TU producto: "8 mg x 30".
function presentacionPropio(p) {
  if (!p) return '';
  return [p.concentracion && p.concentracion !== '—' ? p.concentracion : null, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ');
}

// Que producto es, de cual tuyo es competidor y la tabla registrado / leido.
function Comparacion({ c, propio, umbrales }) {
  const minimoParecido = umbrales?.umbral_similitud_nombre ?? 0.4;
  return (
    <LecturaEnlace
      esPropio={c.es_propio}
      enlace={{
        nombre: c.producto_nombre, laboratorio: c.laboratorio,
        dosis_mg: c.registrada_dosis_mg, tamano: c.registrada_tamano, unidad: c.registrada_unidad,
      }}
      propio={{
        nombre: propio?.nombre || c.producto_propio_nombre || c.producto_nombre,
        id: c.id_producto_propio, laboratorio: propio?.laboratorio, presentacion: presentacionPropio(propio),
      }}
      leido={c.nombre_capturado ? {
        nombre: c.nombre_capturado,
        parecido: c.similitud_nombre,
        parecidoBajo: c.similitud_nombre != null && Number(c.similitud_nombre) < minimoParecido,
        dosis_mg: c.leida_dosis_mg, tamano: c.leida_tamano, unidad: c.leida_unidad,
      } : null}
    />
  );
}

// Por que el control de calidad la marco, con sus numeros.
function porQue(c, umbrales) {
  const r = [];
  const m = c.motivo_sospecha;
  const variacion = num(c.variacion_pct);
  const umbralPrecio = umbrales?.umbral_variacion_precio != null ? Math.round(umbrales.umbral_variacion_precio * 100) : null;
  const umbralNombre = umbrales?.umbral_similitud_nombre != null ? Math.round(umbrales.umbral_similitud_nombre * 100) : null;
  const pres = diferenciaPresentacion(c);
  if (m === 'precio_repetido') {
    r.push('Otros productos distintos de esta tienda salieron con este mismo precio exacto: suele ser el robot leyendo un monto que no es el del producto.');
  }
  if ((m === 'variacion_precio' || m === 'ambos') && variacion != null && c.precio_anterior_bs != null) {
    r.push(`El precio ${variacion > 0 ? 'subió' : 'bajó'} ${Math.abs(variacion).toLocaleString('es-VE')} % frente a la lectura anterior (${bs(c.precio_anterior_bs)} → ${bs(c.precio_bs)})${umbralPrecio ? `; se marca desde ${umbralPrecio} %` : ''}.`);
  }
  if ((m === 'nombre' || m === 'ambos') && c.similitud_nombre != null && (umbrales == null || c.similitud_nombre < (umbrales.umbral_similitud_nombre ?? 0.4))) {
    r.push(`El nombre de la tienda se parece ${Math.round(c.similitud_nombre * 100)} % al registrado${umbralNombre ? `; se marca por debajo de ${umbralNombre} %` : ''}: puede ser otro producto.`);
  }
  if ((m === 'presentacion' || m === 'ambos') && pres) {
    r.push(`La tienda muestra ${pres.leida} y el enlace está registrado como ${pres.registrada}.`);
  }
  if (m === 'legacy') r.push('Dato traído del sistema anterior, sin revisar.');
  return r;
}
