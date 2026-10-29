import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../supabase';
import { useToast } from '../../context/ToastContext';
import { useData } from '../../context/DataContext';
import BarraFiltros from '../BarraFiltros';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { normalizar } from '../formulario';

// Precios sin actualizar (fase 53): enlaces cuyo ultimo precio valido tiene
// mas de 15 dias. Esos precios ya no cuentan en graficos ni promedios (se
// ocultan para no danar los datos); aqui se listan para revisarlos: la tienda
// pudo cambiar la pagina, retirar el producto o el robot no la lee.
export const DIAS_PRECIO_VIEJO = 15;
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const fecha = (v) => (v ? new Date(v).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function PreciosViejos() {
  const { addToast } = useToast();
  const { cadenas = [] } = useData() || {};
  const nombreCadena = (id) => cadenas.find(c => String(c.id).toLowerCase() === String(id).toLowerCase())?.nombre || id;
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sinFase, setSinFase] = useState(false);
  const [cadena, setCadena] = useState('todos');
  const [quien, setQuien] = useState('todos');
  const [buscar, setBuscar] = useState('');

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase.from('v_precios_viejos').select('*').order('dias', { ascending: false }).limit(5000);
    if (error) {
      if (faltaVista(error)) setSinFase(true);
      else addToast(`No se pudieron cargar los precios sin actualizar: ${error.message}`, 'error');
      setFilas([]);
    } else {
      setFilas(data || []);
    }
    setCargando(false);
  }, [addToast]);
  useEffect(() => { cargar(); }, [cargar]);

  const cadenasLista = useMemo(() => [...new Set(filas.map(f => f.cadena_id))].sort(), [filas]);
  const visibles = useMemo(() => {
    const term = normalizar(buscar);
    return filas.filter(f => (cadena === 'todos' || f.cadena_id === cadena)
      && (quien === 'todos' || (quien === 'propio' ? f.es_propio : !f.es_propio))
      && (!term || normalizar(`${f.id_producto_propio} ${f.producto_propio_nombre} ${f.producto_nombre} ${f.laboratorio}`).includes(term)));
  }, [filas, cadena, quien, buscar]);

  if (sinFase) {
    return (
      <div className="m3-banner m3-banner-info" role="status">
        <span className="material-symbols-outlined" aria-hidden="true">info</span>
        <span className="m3-body-medium">Falta correr <code>sql/fase53_cadenas_baja_y_precios_viejos.sql</code> en Supabase.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BarraFiltros
        etiqueta="Filtros de precios sin actualizar"
        limpiar={{ visible: cadena !== 'todos' || quien !== 'todos', onClick: () => { setCadena('todos'); setQuien('todos'); } }}
        filtrar={(
          <>
            <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
              opciones={[['todos', 'Cadena: todas'], ...cadenasLista.map(c => [c, nombreCadena(c)])]} />
            <FiltroChip etiqueta="De quién es el enlace" icono="person" valor={quien} onChange={setQuien}
              opciones={[['todos', 'Enlaces: todos'], ['propio', 'Tus enlaces'], ['competencia', 'Competencia']]} />
          </>
        )}
      />

      <section className="m3-data-table" aria-label="Precios sin actualizar">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar producto o laboratorio" aria-label="Buscar" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">{visibles.length} enlaces</span>
              <InfoGrafico alinear="derecha" titulo="Precios sin actualizar"
                que={`Enlaces cuyo último precio tiene más de ${DIAS_PRECIO_VIEJO} días. Ese precio ya no cuenta en gráficos, promedios ni comparaciones, para no dañar los datos.`}
                lectura="Abre el enlace: si la página cambió o el producto ya no está, corrige o da de baja el enlace en Relación. Si la página está bien, el robot lo volverá a leer."
                ejemplo="Un competidor con 22 días sin leer ya no te hace ver «el más caro»." />
            </div>
          </div>
        </div>

        {cargando ? (
          <div className="h-64 m3-skeleton" aria-busy="true" />
        ) : visibles.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">check_circle</span>
            <div className="m3-title-medium text-on-surface">Todos los precios están al día</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead className="m3-sticky-header">
                <tr>
                  <th>Tu producto</th>
                  <th>Enlace</th>
                  <th>Cadena</th>
                  <th className="text-right">Última lectura</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibles.map(f => (
                  <tr key={f.publicacion_id}>
                    <td data-label="Tu producto">
                      <div className="m3-cell-primary m3-cell-clamp" title={f.producto_propio_nombre}>{f.producto_propio_nombre}</div>
                      <div className="m3-cell-secondary">{f.id_producto_propio}</div>
                    </td>
                    <td data-label="Enlace">
                      <div className="m3-cell-primary m3-cell-clamp" title={f.producto_nombre}>{f.es_propio ? 'Tu enlace' : f.producto_nombre}</div>
                      <div className="m3-cell-secondary">{f.laboratorio}</div>
                    </td>
                    <td data-label="Cadena">
                      <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={f.cadena_id} tamano="xs" title="" />{nombreCadena(f.cadena_id)}</span>
                    </td>
                    <td data-label="Última lectura" className="text-right whitespace-nowrap">
                      <div className="font-medium tabular-nums">hace {f.dias} días</div>
                      <div className="m3-cell-secondary">{fecha(f.ultima_lectura)}</div>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {f.url && (
                        <a href={f.url} target="_blank" rel="noreferrer" className="m3-icon-btn m3-icon-btn-sm" title="Abrir la página de la tienda" aria-label="Abrir la página de la tienda">
                          <span className="material-symbols-outlined">open_in_new</span>
                        </a>
                      )}
                      <Link to={`/competencia?producto=${encodeURIComponent(f.id_producto_propio)}`} className="m3-icon-btn m3-icon-btn-sm" title="Ver en Relación" aria-label="Ver en Relación">
                        <span className="material-symbols-outlined">link</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
