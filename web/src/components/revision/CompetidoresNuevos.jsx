import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../supabase';
import { useToast } from '../../context/ToastContext';
import { useData } from '../../context/DataContext';
import { useDimensiones } from '../../hooks/useDimensiones';
import BarraFiltros from '../BarraFiltros';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import GitHubConfigModal from '../GitHubConfigModal';
import Select from '../Select';
import { normalizar } from '../formulario';
import { getGitHubConfig, triggerGitHubScraper } from '../../utils/githubClient';

// Competidores nuevos (fase 57, etapa 2 del buscador): el robot busco en
// cada cadena la molecula y la dosis de tus productos y encontro productos
// de otros laboratorios que aun no estan registrados. Aceptar crea el
// competidor (laboratorio, molecula, dosis), su relacion con tu producto y
// el enlace; el robot de precios lo lee en su proxima corrida.
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const precio = (v, moneda) => (v == null ? '—' : `${moneda === 'USD' ? '$' : 'Bs'} ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SI = { si: 'check_circle', distinto: 'swap_horiz', '?': 'help', no: 'cancel' };

export default function CompetidoresNuevos() {
  const { addToast } = useToast();
  const { cadenas = [], refreshCompetencia } = useData() || {};
  const { laboratorios = [] } = useDimensiones();
  const nombreCadena = (id) => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id;
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sinFase, setSinFase] = useState(false);
  const [cadena, setCadena] = useState('todos');
  const [buscar, setBuscar] = useState('');
  const [labs, setLabs] = useState({});      // id -> laboratorio escrito
  const [tipos, setTipos] = useState({});    // id -> GENERICO | MARCA
  const [procesando, setProcesando] = useState(null);
  const [verGithub, setVerGithub] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase.from('v_competidores_nuevos').select('*').eq('estado', 'pendiente')
      .order('puntaje', { ascending: false }).limit(2000);
    if (error) {
      if (faltaVista(error)) setSinFase(true);
      else addToast(`No se pudieron cargar las propuestas: ${error.message}`, 'error');
      setFilas([]);
    } else {
      setFilas(data || []);
    }
    setCargando(false);
  }, [addToast]);
  useEffect(() => { cargar(); }, [cargar]);

  // Laboratorio sugerido: la marca que muestra la tienda, o un laboratorio
  // conocido que aparezca en el nombre.
  const labSugerido = useCallback((f) => {
    if (f.marca_tienda) return f.marca_tienda;
    const nombre = normalizar(f.nombre_tienda);
    return laboratorios.find(l => l.length >= 3 && new RegExp(`\\b${normalizar(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nombre)) || '';
  }, [laboratorios]);

  const cadenasLista = useMemo(() => [...new Set(filas.map(f => f.cadena_id))], [filas]);
  const visibles = useMemo(() => {
    const term = normalizar(buscar);
    return filas.filter(f => (cadena === 'todos' || f.cadena_id === cadena)
      && (!term || normalizar(`${f.propio_id} ${f.propio_nombre} ${f.propio_molecula} ${f.nombre_tienda} ${f.marca_tienda}`).includes(term)));
  }, [filas, cadena, buscar]);

  const lanzar = async () => {
    const config = await getGitHubConfig();
    if (!config?.token || !config.repo_owner || !config.repo_name) {
      setVerGithub(true);
      addToast('Faltan las credenciales de GitHub Actions.', 'info');
      return;
    }
    try {
      await triggerGitHubScraper({ config: { ...config, workflow_event_type: 'buscar-enlaces' }, payload: { modo: 'competidores' } });
      addToast('Búsqueda de competidores lanzada en GitHub: arranca en unos minutos. Vuelve más tarde.', 'info');
    } catch (err) {
      addToast(`No se pudo lanzar la búsqueda: ${err.message}`, 'error');
    }
  };

  const aceptar = async (f) => {
    const lab = (labs[f.id] ?? labSugerido(f)).trim();
    if (!lab) { addToast('Escribe el laboratorio del competidor.', 'error'); return; }
    setProcesando(f.id);
    const { error } = await supabase.rpc('fn_aceptar_competidor', {
      p_id: f.id, p_laboratorio: lab, p_nombre: f.nombre_tienda, p_tipo_mercado: tipos[f.id] || 'GENERICO',
    });
    setProcesando(null);
    if (error) { addToast(`No se pudo aceptar: ${error.message}`, 'error'); return; }
    setFilas(fs => fs.filter(x => x.id !== f.id));
    refreshCompetencia?.();
    addToast(`${lab} agregado como competidor en ${nombreCadena(f.cadena_id)}. El robot leerá su precio en la próxima corrida.`, 'success');
  };

  const descartar = async (f) => {
    setProcesando(f.id);
    const { error } = await supabase.from('competidores_nuevos').update({ estado: 'descartada', revisado: new Date().toISOString() }).eq('id', f.id);
    setProcesando(null);
    if (error) { addToast(`No se pudo descartar: ${error.message}`, 'error'); return; }
    setFilas(fs => fs.filter(x => x.id !== f.id));
  };

  if (sinFase) {
    return (
      <div className="m3-banner m3-banner-info" role="status">
        <span className="material-symbols-outlined" aria-hidden="true">info</span>
        <span className="m3-body-medium">Falta correr <code>sql/fase57_competidores_nuevos.sql</code> en Supabase.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="m3-body-medium text-on-surface-variant">
          El robot busca la molécula y la dosis de cada producto tuyo en cada cadena y propone productos de otros laboratorios que todavía no tienes registrados.
        </p>
        <button type="button" onClick={lanzar} className="m3-btn-tonal self-start md:self-auto" title="Lanza el robot buscador en modo competidores (GitHub Actions)">
          <span className="material-symbols-outlined">travel_explore</span>
          Buscar competidores
        </button>
      </div>

      <BarraFiltros etiqueta="Filtros de competidores nuevos"
        filtrar={<FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
          opciones={[['todos', 'Cadena: todas'], ...cadenasLista.map(c => [c, nombreCadena(c)])]} />} />

      <section className="m3-data-table" aria-label="Competidores nuevos">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar producto, molécula o laboratorio" aria-label="Buscar" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">{visibles.length} propuestas</span>
              <InfoGrafico alinear="derecha" titulo="Competidores nuevos"
                que="Productos de otros laboratorios con tu misma molécula y dosis que el robot encontró en las cadenas y aún no están registrados."
                formula={['Molécula en el nombre: 30 · misma dosis: 40 (si no se lee: 15) · mismo tamaño: 30 (otro tamaño: 10; si no se lee: 15)', 'Se propone desde 60. Otra dosis o tu propio laboratorio se descartan solos.']}
                lectura="Revisa el laboratorio (viene de la marca que muestra la tienda) y si es genérico o marca, y acepta. Lo que no sirva, descártalo: no vuelve a salir."
                ejemplo="Para tu Losartán 50 mg aparece «Losartán Potásico 50 mg x 20 · Calox» en Farmatodo: aceptas y queda como competidor." />
            </div>
          </div>
        </div>

        {cargando ? <div className="h-64 m3-skeleton" aria-busy="true" /> : visibles.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">travel_explore</span>
            <div className="m3-title-medium text-on-surface">{filas.length ? 'Nada con estos filtros' : 'Sin propuestas pendientes'}</div>
            {!filas.length && <div className="m3-body-medium">Toca «Buscar competidores» para que el robot busque.</div>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead className="m3-sticky-header">
                <tr><th>Tu producto</th><th>Encontrado en la tienda</th><th>Laboratorio</th><th>Tipo</th><th className="text-right">Acciones</th></tr>
              </thead>
              <tbody>
                {visibles.map(f => {
                  const d = f.detalle || {};
                  return (
                    <tr key={f.id}>
                      <td data-label="Tu producto">
                        <div className="m3-cell-primary m3-cell-clamp" title={f.propio_nombre}>{f.propio_nombre}</div>
                        <div className="m3-cell-secondary">{f.propio_id} · {f.propio_molecula}</div>
                      </td>
                      <td data-label="Encontrado">
                        <a href={f.url} target="_blank" rel="noreferrer" className="m3-cell-primary m3-cell-clamp text-primary hover:underline" title={f.nombre_tienda}>{f.nombre_tienda}</a>
                        <div className="m3-cell-secondary" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 }}>
                          <span className="inline-flex items-center gap-1"><CadenaBadge cadena={f.cadena_id} tamano="xs" title="" />{nombreCadena(f.cadena_id)}</span>
                          <span className="tabular-nums">{precio(f.precio, f.moneda)}</span>
                          {['dosis', 'tamano'].map(k => (
                            <span key={k} className="inline-flex items-center gap-0.5" title={`${k === 'dosis' ? 'Dosis' : 'Tamaño'}: ${d[k] === 'si' ? 'igual al tuyo' : d[k] === 'distinto' ? 'distinto' : 'no se lee'}`}>
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }} aria-hidden="true">{SI[d[k]] || 'help'}</span>{k === 'dosis' ? 'dosis' : `tamaño${d.tamano_leido ? ` ${d.tamano_leido}` : ''}`}
                            </span>
                          ))}
                          <span>{f.puntaje} pts</span>
                        </div>
                      </td>
                      <td data-label="Laboratorio">
                        <input list="tf-labs-comp" value={labs[f.id] ?? labSugerido(f)} onChange={e => setLabs(m => ({ ...m, [f.id]: e.target.value }))}
                          className="m3-input w-36" placeholder="Laboratorio" aria-label={`Laboratorio de ${f.nombre_tienda}`} />
                      </td>
                      <td data-label="Tipo">
                        <Select value={tipos[f.id] || 'GENERICO'} onChange={e => setTipos(m => ({ ...m, [f.id]: e.target.value }))} aria-label="Genérico o marca">
                          <option value="GENERICO">Genérico</option>
                          <option value="MARCA">Marca</option>
                        </Select>
                      </td>
                      <td className="text-right">
                        <div className="flex flex-col items-end gap-1">
                        <button type="button" onClick={() => aceptar(f)} disabled={procesando === f.id} className="m3-btn-tonal h-9 px-3">
                          <span className="material-symbols-outlined text-base">add_link</span>Aceptar
                        </button>
                        <button type="button" onClick={() => descartar(f)} disabled={procesando === f.id} className="m3-btn-text h-8 px-3">Descartar</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <datalist id="tf-labs-comp">{laboratorios.map(l => <option key={l} value={l} />)}</datalist>
      <GitHubConfigModal isOpen={verGithub} onClose={() => setVerGithub(false)} />
    </div>
  );
}
