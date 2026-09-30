import { useMemo, useState } from 'react';
import Segmentado from '../Segmentado';
import FiltroChip from '../FiltroChip';
import BarraFiltros from '../BarraFiltros';
import TendenciaPosicion, { diaLargo } from '../dashboard/TendenciaPosicion';
import { useData } from '../../context/DataContext';
import { useToast } from '../../context/ToastContext';
import { supabase } from '../../supabase';
import { tokensGrafico } from '../../utils/chartTokens';
import { describirPresentacion } from '../../utils/presentacion';
import { Diferencia } from '../dashboard/comun';

// Tendencia de tu posicion (antes en el Dashboard): la mediana de "tu precio
// frente al promedio del mercado" dia a dia (fn_tendencia_posicion, fase 28).
// Tocar un dia lista cada producto ese dia (fn_posicion_productos).
const usd = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);

export default function TendenciaExperimental() {
  const { productos = [], cadenas = [] } = useData() || {};
  const { addToast } = useToast();
  const [modoPrecio, setModoPrecio] = useState('lista');
  const [modoAnalisis, setModoAnalisis] = useState('empaque');
  const [cadena, setCadena] = useState('todos');
  const [dia, setDia] = useState(null); // { fecha, filas, cargando }

  const porId = useMemo(() => new Map(productos.map(p => [String(p.id_interno), p])), [productos]);
  const cadenasActivas = useMemo(() => (cadenas || []).filter(c => c.activo !== false)
    .sort((a, b) => a.nombre.localeCompare(b.nombre)), [cadenas]);

  const verDia = async (fecha) => {
    setDia({ fecha, filas: [], cargando: true });
    const { data, error } = await supabase.rpc('fn_posicion_productos', {
      p_desde: fecha, p_hasta: fecha,
      p_con_descuento: modoPrecio === 'descuento',
      p_por_unidad: modoAnalisis === 'unidosis',
      p_cadena: cadena === 'todos' ? null : cadena,
      p_productos: null,
    });
    if (error) { addToast(`No se pudo leer ese día: ${error.message}`, 'error'); setDia(null); return; }
    const filas = (data || [])
      .filter(f => f.dif_promedio != null && porId.has(String(f.id_interno)))
      .map(f => ({ ...f, producto: porId.get(String(f.id_interno)) }))
      .sort((a, b) => Number(b.dif_promedio) - Number(a.dif_promedio));
    setDia({ fecha, filas, cargando: false });
  };

  return (
    <div className="space-y-4">
      <BarraFiltros
        etiqueta="Filtros de la tendencia"
        limpiar={{ visible: cadena !== 'todos', onClick: () => setCadena('todos') }}
        filtrar={(
          <FiltroChip etiqueta="Comparar contra" icono="storefront" valor={cadena} onChange={v => { setCadena(v); setDia(null); }}
            opciones={[['todos', 'Cadenas: todas'], ...cadenasActivas.map(c => [c.id, `Solo ${c.nombre}`])]} />
        )}
        comparar={(
          <>
            <Segmentado etiqueta="Precio que se compara" rotulo="Precio" valor={modoPrecio} onChange={v => { setModoPrecio(v); setDia(null); }}
              opciones={[['lista', 'Lista', 'Precio de lista'], ['descuento', 'Oferta', 'Precio con oferta']]} />
            <Segmentado etiqueta="Comparar por" rotulo="Por" valor={modoAnalisis} onChange={v => { setModoAnalisis(v); setDia(null); }}
              opciones={[['empaque', 'Empaque', 'Precio de la caja'], ['unidosis', 'Unidad', 'Precio por tableta, ml o g']]} />
          </>
        )}
      />

      <TendenciaPosicion
        productos={null}
        conDescuento={modoPrecio === 'descuento'}
        porUnidad={modoAnalisis === 'unidosis'}
        cadena={cadena === 'todos' ? null : cadena}
        tipoMercado={null}
        meta={0}
        tg={tokensGrafico()}
        onDia={verDia}
      />

      {dia && (
        <section className="m3-data-table" aria-label={`Tu posición el ${diaLargo(dia.fecha)}`}>
          <div className="m3-data-table-titulo flex items-center gap-3">
            <div className="min-w-0">
              <h2 className="m3-title-medium text-on-surface first-letter:uppercase">Tu posición el {diaLargo(dia.fecha)}</h2>
              <p className="m3-body-small text-on-surface-variant">Primero los más caros frente al promedio del mercado (la competencia y tú), con el último precio de cada enlace ese día.</p>
            </div>
            <button type="button" onClick={() => setDia(null)} className="m3-icon-btn ml-auto" aria-label="Cerrar el detalle del día">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          {dia.cargando ? (
            <div className="h-32 m3-skeleton m-4 rounded-2xl" aria-busy="true" />
          ) : (
            <div className="overflow-x-auto">
              <table className="m3-table m3-table-apilada">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="text-right">Tu precio</th>
                    <th className="text-right">Promedio</th>
                    <th className="text-right">Tú frente al promedio</th>
                  </tr>
                </thead>
                <tbody>
                  {dia.filas.map(f => (
                    <tr key={f.id_interno}>
                      <td>
                        <div className="m3-cell-primary m3-cell-clamp max-w-[20rem]" title={f.producto.nombre}>{f.producto.nombre}</div>
                        <div className="m3-cell-secondary">{[f.id_interno, f.producto.concentracion, describirPresentacion(f.producto)].filter(v => v && v !== '—').join(' · ')}</div>
                      </td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Tu precio">{usd(f.tu_precio_usd)}</td>
                      <td className="text-right whitespace-nowrap tabular-nums" data-label="Promedio">{usd(f.promedio_usd)}</td>
                      <td className="text-right whitespace-nowrap" data-label="Tú frente al promedio"><Diferencia valor={Number(f.dif_promedio)} /></td>
                    </tr>
                  ))}
                  {dia.filas.length === 0 && <tr><td colSpan={4} className="text-center text-on-surface-variant py-8">Ese día no hay productos con tu precio y el de la competencia.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
