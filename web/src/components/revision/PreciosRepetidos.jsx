import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../supabase';
import { useToast } from '../../context/ToastContext';
import CadenaBadge from '../CadenaBadge';
import FiltroChip from '../FiltroChip';
import BarraFiltros from '../BarraFiltros';
import InfoGrafico from '../InfoGrafico';
import { avisarCambioRevision } from '../../hooks/usePendientesRevision';
import { useData } from '../../context/DataContext';
import { describirPresentacion } from '../../utils/presentacion';
import { leerPresentacion } from '../../utils/leerPresentacion';
import LecturaEnlace from './LecturaEnlace';

// Precios repetidos (fase 44): productos distintos de una misma cadena con el
// MISMO precio al centavo en su ultima lectura. Casi siempre es el robot
// leyendo un monto que se repite en todas las paginas de la tienda.
//   "Son erróneas"  -> las lecturas quedan fuera de los analisis
//   "Son correctos" -> el grupo deja de salir (revisado)
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);
const bs = (v) => `Bs ${Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fecha = (v) => (v ? new Date(v).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function PreciosRepetidos({ selector, nombreCadena, releer, robotOcupado }) {
  const { addToast } = useToast();
  const { productos = [] } = useData() || {};
  const propioPorId = useMemo(() => new Map(productos.map(p => [String(p.id_interno).trim(), p])), [productos]);
  const datosPropio = (f) => {
    const p = propioPorId.get(String(f.id_producto_propio).trim());
    const pres = p ? [p.concentracion && p.concentracion !== '—' ? p.concentracion : null, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ') : '';
    return { nombre: p?.nombre || f.producto_propio_nombre || f.producto_nombre, id: f.id_producto_propio, laboratorio: p?.laboratorio, presentacion: pres };
  };
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sinFase, setSinFase] = useState(false);
  const [cadena, setCadena] = useState('todos');
  const [procesando, setProcesando] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase.from('v_precios_repetidos').select('*')
      .order('enlaces', { ascending: false }).limit(1000);
    if (error) {
      if (faltaVista(error)) setSinFase(true);
      else addToast(`No se pudieron cargar los precios repetidos: ${error.message}`, 'error');
      setFilas([]);
    } else {
      setFilas(data || []);
    }
    setCargando(false);
  }, [addToast]);
  useEffect(() => { cargar(); }, [cargar]);

  const grupos = useMemo(() => {
    const m = new Map();
    for (const f of filas) {
      if (cadena !== 'todos' && f.cadena_id !== cadena) continue;
      if (!m.has(f.grupo)) m.set(f.grupo, { clave: f.grupo, cadena: f.cadena_id, precio: f.precio_full_bs, usd: f.precio_usd, filas: [] });
      m.get(f.grupo).filas.push(f);
    }
    return [...m.values()].sort((a, b) => b.filas.length - a.filas.length);
  }, [filas, cadena]);
  const cadenas = [...new Set(filas.map(f => f.cadena_id))];

  const decidir = async (g, erroneas) => {
    setProcesando(g.clave);
    const ids = g.filas.map(f => f.captura_id);
    const cambios = erroneas
      ? { revisado_manual: true, sospechoso: true, motivo_sospecha: 'precio_repetido' }
      : { revisado_manual: true };
    const { data, error } = await supabase.from('fact_precios').update(cambios).in('id', ids).select('id');
    setProcesando(null);
    if (error || !data?.length) {
      addToast(`No se pudo guardar: ${error?.message || 'sin permiso'}`, 'error');
      return;
    }
    setFilas(prev => prev.filter(f => f.grupo !== g.clave));
    avisarCambioRevision();
    addToast(erroneas
      ? `${data.length} lecturas marcadas como erróneas: ya no cuentan en los análisis. Usa «Volver a leer» cuando el robot esté corregido.`
      : 'Marcados como correctos: este grupo no vuelve a salir.', 'success');
  };

  return (
    <section className="m3-data-table" aria-label="Precios repetidos">
      <div className="m3-data-table-toolbar flex flex-col gap-3">
        <BarraFiltros integrada limpiar={{ visible: cadena !== 'todos', onClick: () => setCadena('todos') }} filtrar={<>
          {selector}
          <FiltroChip etiqueta="Cadena" icono="storefront" valor={cadena} onChange={setCadena}
            opciones={[['todos', 'Cadena: todas'], ...cadenas.map(id => [id, nombreCadena(id)])]} />
        </>} />
        <div className="flex items-center gap-1">
          <span className="m3-label-large text-on-surface-variant mr-auto">
            {grupos.length} {grupos.length === 1 ? 'grupo' : 'grupos'} de productos distintos con el mismo precio exacto (última lectura, 3 días)
          </span>
          <InfoGrafico alinear="derecha" titulo="Precios repetidos"
            que="Productos distintos de una misma cadena cuya última lectura dio exactamente el mismo precio, al centavo. Casi siempre es el robot leyendo un monto que se repite en todas las páginas de la tienda (envío, carrito, un banner) en vez del precio del producto."
            formula={[
              'Grupo = misma cadena + mismo precio exacto en Bs, en 2 o más enlaces de productos distintos',
              'El robot ya marca solo los casos de 3 o más enlaces en una corrida',
            ]}
            lectura="Abre los enlaces: si cada página tiene su propio precio, marca «Son erróneas» (salen de los análisis) y luego «Volver a leer». Si de verdad cuestan lo mismo, «Son correctos» y el grupo no vuelve a salir." />
          <button type="button" onClick={cargar} className="m3-icon-btn" title="Actualizar" aria-label="Actualizar">
            <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          </button>
        </div>
      </div>

      {sinFase ? (
        <p className="m3-body-medium text-on-surface-variant p-6">Ejecuta <strong>fase44_precios_repetidos.sql</strong> en Supabase para ver los precios repetidos.</p>
      ) : cargando && !filas.length ? (
        <div className="h-48 m3-skeleton m-4 rounded-2xl" aria-busy="true" />
      ) : grupos.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-14 px-6 text-center text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl text-[color:var(--md-sys-color-data-positive)]" aria-hidden="true">task_alt</span>
          <p className="m3-title-medium text-on-surface">No hay precios repetidos</p>
          <p className="m3-body-medium">Ningún par de productos distintos de una misma cadena tiene el mismo precio exacto.</p>
        </div>
      ) : (
        <ul className="m3-sugerencias-lista">
          {grupos.map(g => (
            <li key={g.clave} className="m3-sugerencias-grupo">
              <div className="m3-sugerencias-producto flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="inline-flex items-center gap-1.5 m3-title-small text-on-surface">
                  <CadenaBadge cadena={g.cadena} tamano="xs" title="" />{nombreCadena(g.cadena)}
                </span>
                <span className="m3-title-small tabular-nums text-error">{bs(g.precio)}{g.usd != null && <span className="m3-body-small text-on-surface-variant"> · ${Number(g.usd).toFixed(2)}</span>}</span>
                <span className="m3-body-small text-on-surface-variant">{g.filas.length} enlaces con el mismo precio</span>
                <div className="flex flex-wrap items-center gap-2 ml-auto">
                  <button data-edita type="button" onClick={() => releer(g.filas)} disabled={robotOcupado} className="m3-btn-text"
                    title={robotOcupado ? 'Ya hay una lectura en curso' : 'El robot lee ahora estos enlaces'}>
                    <span className="material-symbols-outlined" aria-hidden="true">sync</span>
                    Volver a leer
                  </button>
                  <button data-edita type="button" onClick={() => decidir(g, false)} disabled={procesando === g.clave} className="m3-btn-outline h-10 px-4"
                    title="De verdad cuestan lo mismo: el grupo no vuelve a salir">Son correctos</button>
                  <button data-edita type="button" onClick={() => decidir(g, true)} disabled={procesando === g.clave} className="m3-btn-danger-outline h-10 px-4"
                    title="Lecturas mal tomadas: salen de los análisis">Son erróneas</button>
                </div>
              </div>
              <ul>
                {g.filas.map(f => (
                  <li key={f.captura_id} className="m3-sugerencia">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap m3-label-medium text-on-surface-variant">
                        <span className="tabular-nums">{fecha(f.fecha_captura)}</span>
                        {f.sospechoso && <span className="m3-etiqueta">Ya marcada dudosa</span>}
                      </div>
                      <LecturaEnlace esPropio={f.es_propio}
                        enlace={{ nombre: f.producto_nombre, laboratorio: f.laboratorio, dosis_mg: f.registrada_dosis_mg, tamano: f.registrada_tamano, unidad: f.registrada_unidad }}
                        propio={datosPropio(f)}
                        leido={f.nombre_capturado ? { nombre: f.nombre_capturado, ...leerPresentacion(f.nombre_capturado) } : null} />
                    </div>
                    <div />
                    <div className="m3-sugerencia-acciones">
                      <a href={f.url} target="_blank" rel="noopener noreferrer" className="m3-icon-btn" title="Abrir la página en la tienda" aria-label="Abrir en la tienda">
                        <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                      </a>
                      <Link data-edita to={`/competencia?editar=${f.publicacion_id}&volver=revision`} className="m3-btn-text" title="Abrir el formulario de este enlace en Relación">
                        <span className="material-symbols-outlined" aria-hidden="true">edit</span>
                        Corregir enlace
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
