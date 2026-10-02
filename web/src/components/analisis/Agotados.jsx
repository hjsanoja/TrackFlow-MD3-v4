import { useCallback, useMemo, useState } from 'react';
import StatCard from '../StatCard';
import FiltroChip from '../FiltroChip';
import BarraFiltros from '../BarraFiltros';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { useData } from '../../context/DataContext';
import { supabase, isSupabaseActive } from '../../supabase';
import { normalizar } from '../formulario';
import { haceCuanto, fechaHora } from '../../utils/usuarios';
import { EstadoAnalisis } from './Estados';
import { useConsulta } from '../../utils/cacheConsultas';

// Agotados y de vuelta en existencia (v_disponibilidad, fase 46).
//   - Tu producto agotado en una cadena: ventas que se pierden.
//   - Un competidor agotado donde tu producto tiene precio: oportunidad.
//   - Volvio: la ultima lectura tiene precio y antes estaba agotado (7 dias).
// Solo cuentan las lecturas donde la tienda dijo "agotado"; una pagina que no
// carga no dice nada de la existencia.
const SIN_FILAS = [];
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

export default function Agotados() {
  const { cadenas = [], productosCompetencia = [] } = useData() || {};
  // Queda en memoria: al volver a la pestana sale al instante (utils/cacheConsultas).
  const consulta = useConsulta('disp:agotados', () => supabase.from('v_disponibilidad').select('*').limit(2000),
    { activa: isSupabaseActive() });
  const filas = consulta.datos || SIN_FILAS;
  const estado = { cargando: consulta.cargando, error: consulta.error && !faltaVista(consulta.error) ? consulta.error : null,
    faltaSql: Boolean(consulta.error && faltaVista(consulta.error)) };
  const cargar = consulta.recargar;
  const [ver, setVer] = useState('todos');        // todos | tuyos | competencia | oportunidad | volvio
  const [cadena, setCadena] = useState('todos');
  const [busqueda, setBusqueda] = useState('');

  const nombreCadena = useMemo(() => {
    const m = new Map((cadenas || []).map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);


  // Donde tu producto tiene hoy precio leido: (producto, cadena).
  const tuyoConPrecio = useMemo(() => {
    const s = new Set();
    for (const e of productosCompetencia) {
      if (e.activo && String(e.tipo).toLowerCase() === 'propio' && e.ultimo_precio_full_bs) {
        s.add(`${String(e.id_producto_propio).trim()}|${String(e.cadena).toLowerCase()}`);
      }
    }
    return s;
  }, [productosCompetencia]);
  const esOportunidad = useCallback((f) => f.estado === 'agotado' && !f.es_propio
    && tuyoConPrecio.has(`${String(f.id_producto_propio).trim()}|${String(f.cadena_id).toLowerCase()}`), [tuyoConPrecio]);

  const conteo = useMemo(() => ({
    tuyos: filas.filter(f => f.estado === 'agotado' && f.es_propio).length,
    competencia: filas.filter(f => f.estado === 'agotado' && !f.es_propio).length,
    oportunidad: filas.filter(esOportunidad).length,
    volvio: filas.filter(f => f.estado === 'volvio').length,
  }), [filas, esOportunidad]);

  const visibles = useMemo(() => {
    const t = normalizar(busqueda);
    return filas.filter(f => {
      if (cadena !== 'todos' && f.cadena_id !== cadena) return false;
      if (ver === 'tuyos' && !(f.estado === 'agotado' && f.es_propio)) return false;
      if (ver === 'competencia' && !(f.estado === 'agotado' && !f.es_propio)) return false;
      if (ver === 'oportunidad' && !esOportunidad(f)) return false;
      if (ver === 'volvio' && f.estado !== 'volvio') return false;
      return !t || normalizar(`${f.id_producto_propio} ${f.producto_propio_nombre} ${f.producto_nombre} ${f.laboratorio}`).includes(t);
    });
  }, [filas, ver, cadena, busqueda, esOportunidad]);

  // Agrupado por tu producto: sus enlaces agotados o que volvieron.
  const grupos = useMemo(() => {
    const m = new Map();
    for (const f of visibles) {
      const k = String(f.id_producto_propio);
      if (!m.has(k)) m.set(k, { id: k, nombre: f.producto_propio_nombre, filas: [] });
      m.get(k).filas.push(f);
    }
    const peso = (f) => (f.estado === 'agotado' && f.es_propio ? 0 : esOportunidad(f) ? 1 : f.estado === 'agotado' ? 2 : 3);
    return [...m.values()]
      .map(g => ({ ...g, filas: g.filas.sort((a, b) => peso(a) - peso(b) || new Date(a.desde) - new Date(b.desde)) }))
      .sort((a, b) => peso(a.filas[0]) - peso(b.filas[0]) || (a.nombre || '').localeCompare(b.nombre || ''));
  }, [visibles, esOportunidad]);

  const cadenasLista = [...new Set(filas.map(f => f.cadena_id))].sort((a, b) => nombreCadena(a).localeCompare(nombreCadena(b)));

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen">
        <StatCard compacto label="Tus productos agotados" value={conteo.tuyos} icon="remove_shopping_cart" tono={conteo.tuyos ? 'negative' : 'neutral'}
          hint="En esas cadenas no se está vendiendo" onClick={() => setVer('tuyos')} title="Ver tus productos agotados" />
        <StatCard compacto label="Oportunidades" value={conteo.oportunidad} icon="bolt" tono={conteo.oportunidad ? 'primary' : 'neutral'}
          hint="Competidor agotado donde tú tienes precio" onClick={() => setVer('oportunidad')} title="Ver dónde el competidor está agotado y tú no" />
        <StatCard compacto label="Competidores agotados" value={conteo.competencia} icon="inventory_2" tono="neutral"
          hint="En alguna cadena" onClick={() => setVer('competencia')} title="Ver los competidores agotados" />
        <StatCard compacto label="Volvieron a tener" value={conteo.volvio} icon="restart_alt" tono="neutral"
          hint="Existencia de nuevo, últimos 7 días" onClick={() => setVer('volvio')} title="Ver los que volvieron a tener existencia" />
      </section>

      <section className="m3-data-table" aria-label="Agotados">
        <div className="m3-data-table-toolbar flex flex-col gap-3">
          <BarraFiltros integrada limpiar={{ visible: ver !== 'todos' || cadena !== 'todos', onClick: () => { setVer('todos'); setCadena('todos'); } }} filtrar={<>
            <FiltroChip etiqueta="Qué ver" icono="filter_list" valor={ver} onChange={setVer}
              opciones={[['todos', 'Ver: todo'], ['tuyos', `Tus productos agotados (${conteo.tuyos})`], ['oportunidad', `Oportunidades (${conteo.oportunidad})`],
                ['competencia', `Competidores agotados (${conteo.competencia})`], ['volvio', `Volvieron a tener (${conteo.volvio})`]]} />
            <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
              opciones={[['todos', 'Cadena: todas'], ...cadenasLista.map(id => [id, nombreCadena(id)])]} />
          </>} />
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar por ID, producto o laboratorio" aria-label="Buscar" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant mr-1">{visibles.length} enlaces</span>
              <InfoGrafico alinear="derecha" titulo="Agotados"
                que="Enlaces cuya última lectura dice que la tienda no tiene existencia, y los que volvieron a tener en los últimos 7 días."
                formula={[
                  'Agotado: la tienda lo dice en la página (una página que no carga no cuenta)',
                  'Oportunidad: el competidor está agotado en una cadena donde tu producto tiene precio',
                  'Desde: la primera lectura agotado seguida',
                ]}
                lectura="Primero tus productos agotados (ventas que se pierden), después las oportunidades. Los avisos empiezan con las lecturas del robot desde este cambio." />
              <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
                <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
              </button>
            </div>
          </div>
        </div>

        <EstadoAnalisis cargando={estado.cargando} faltaSql={estado.faltaSql} fase="la fase 46" error={estado.error} hayFilas={grupos.length > 0}
          vacio={filas.length ? 'Nada con estos filtros.' : 'No hay productos agotados ni que hayan vuelto en los últimos 7 días.'}>
          <ul className="m3-sugerencias-lista">
            {grupos.map(g => (
              <li key={g.id} className="m3-sugerencias-grupo">
                <div className="m3-sugerencias-producto flex flex-wrap items-baseline gap-x-3">
                  <span className="m3-title-small text-on-surface">{g.nombre}</span>
                  <span className="m3-body-small text-on-surface-variant">{g.id}</span>
                </div>
                <ul>
                  {g.filas.map(f => {
                    const oportunidad = esOportunidad(f);
                    return (
                      <li key={f.publicacion_id} className="m3-sugerencia">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <CadenaBadge cadena={f.cadena_id} tamano="xs" title="" />
                            <span className="m3-body-medium text-on-surface">{nombreCadena(f.cadena_id)}</span>
                            {f.es_propio ? <span className="m3-chip-propio">Tú</span>
                              : <span className="m3-body-medium text-on-surface-variant truncate">{f.producto_nombre} · {f.laboratorio}</span>}
                          </div>
                          <div className="m3-body-small text-on-surface-variant" title={fechaHora(f.desde)}>
                            {f.estado === 'volvio' ? `Volvió a tener existencia ${haceCuanto(f.desde).toLowerCase()}` : `Agotado desde ${haceCuanto(f.desde).toLowerCase()}`}
                            {' · última lectura '}{haceCuanto(f.ultima_lectura).toLowerCase()}
                          </div>
                        </div>
                        <div className="flex items-center">
                          {f.estado === 'volvio' ? <span className="m3-etiqueta">Volvió</span>
                            : f.es_propio ? <span className="m3-chip-caido">Tu producto agotado</span>
                              : oportunidad ? <span className="m3-etiqueta is-primary">Oportunidad</span>
                                : <span className="m3-etiqueta">Agotado</span>}
                        </div>
                        <div className="m3-sugerencia-acciones">
                          <a href={f.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir la página en la tienda" aria-label="Abrir en la tienda">
                            <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </EstadoAnalisis>
      </section>
    </div>
  );
}
