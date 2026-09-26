import { useMemo, useState } from 'react';
import StatCard from '../StatCard';
import Select from '../Select';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { useData } from '../../context/DataContext';
import { useRpc } from '../../hooks/useRpc';
import { EstadoAnalisis } from './Estados';

// Velocidad de reaccion: cuando una cadena cambia el precio de un producto,
// cuantos dias tardan las demas en mover el suyo. Lo calcula
// fn_velocidad_reaccion (fase 32).
const PERIODOS = [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [180, 'Últimos 180 días']];
const dias = (v) => (v == null ? '—' : `${String(Number(v)).replace('.', ',')} ${Number(v) === 1 ? 'día' : 'días'}`);

export default function VelocidadReaccion() {
  const { cadenas = [] } = useData() || {};
  const [periodo, setPeriodo] = useState(90);
  const { filas, cargando, error, faltaSql } = useRpc('fn_velocidad_reaccion', { p_dias: periodo });

  const nombreCadena = useMemo(() => {
    const m = new Map(cadenas.map(c => [String(c.id).toLowerCase(), c.nombre]));
    return (id) => m.get(String(id).toLowerCase()) || id;
  }, [cadenas]);

  const datos = filas.map(f => ({ ...f, mediana: f.mediana_dias == null ? null : Number(f.mediana_dias) }));
  const conReaccion = datos.filter(x => x.reacciones > 0 && x.mediana != null);
  const masRapida = [...conReaccion].sort((a, b) => a.mediana - b.mediana)[0];
  const masSeguida = [...datos].sort((a, b) => b.seguidos - a.seguidos)[0];
  const totalMov = datos.reduce((s, x) => s + x.movimientos, 0);

  return (
    <div className="space-y-4">
      <section className="m3-dash-filtros" aria-label="Periodo">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(periodo)} onChange={e => setPeriodo(Number(e.target.value))} aria-label="Periodo" className="m3-filter-chip" leadingIcon="date_range">
            {PERIODOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </Select>
          <InfoGrafico
            titulo="Velocidad de reacción"
            que="Cuándo una cadena cambia el precio de un producto, cuántos días tardan las demás en mover el suyo."
            formula={[
              'Cambio = más de 0,5 % en dólares entre dos días con lectura del mismo enlace',
              'Reacción = un cambio de una cadena cuando el cambio anterior en ese producto lo hizo otra cadena en los 30 días previos',
              'Tarda = días entre los dos cambios (se muestra la mediana)',
            ]}
            lectura="Una cadena que reacciona en 1–2 días vigila de cerca a la competencia: si bajas un precio, espera que responda rápido. «La siguieron» dice cuántas veces un cambio suyo fue respondido por otra: la que más aparece ahí es la que marca el precio. Los cambios del mismo día no cuentan como reacción."
          />
        </div>
      </section>

      <EstadoAnalisis cargando={cargando} faltaSql={faltaSql} fase="la fase 32" error={error} hayFilas={datos.length > 0}
        vacio="Aún no hay cambios de precio suficientes en este periodo.">
        <section className="grid grid-cols-2 md:grid-cols-3 gap-3" aria-label="Resumen">
          <StatCard compacto label="Reacciona más rápido" value={masRapida ? nombreCadena(masRapida.cadena) : '—'} icon="bolt" tono="primary"
            hint={masRapida ? `En ${dias(masRapida.mediana)} (mediana)` : 'Sin reacciones'} />
          <StatCard compacto label="Marca el precio" value={masSeguida?.seguidos ? nombreCadena(masSeguida.cadena) : '—'} icon="flag" tono="neutral"
            hint={masSeguida?.seguidos ? `La siguieron ${masSeguida.seguidos} veces` : 'Nadie la siguió'} />
          <StatCard compacto label="Cambios de precio" value={totalMov} icon="swap_vert" tono="neutral" hint={`En ${datos.length} ${datos.length === 1 ? 'cadena' : 'cadenas'}`} />
        </section>

        <section className="m3-data-table" aria-label="Cadenas">
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead>
                <tr>
                  <th>Cadena</th>
                  <th className="text-right" title="Días típicos que tarda en responder a un cambio de otra cadena">Tarda en reaccionar</th>
                  <th className="text-right">Reacciones</th>
                  <th className="text-right" title="Reacciones en la misma dirección: si la otra subió, esta también">Misma dirección</th>
                  <th className="text-right" title="Veces que otra cadena respondió a un cambio suyo">La siguieron</th>
                  <th className="text-right">Cambios</th>
                </tr>
              </thead>
              <tbody>
                {datos.map(x => (
                  <tr key={x.cadena}>
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={x.cadena} tamano="xs" title="" />{nombreCadena(x.cadena)}</span>
                    </td>
                    <td className="text-right tabular-nums font-medium" data-label="Tarda en reaccionar">{dias(x.mediana)}</td>
                    <td className="text-right tabular-nums" data-label="Reacciones">{x.reacciones}</td>
                    <td className="text-right tabular-nums" data-label="Misma dirección">
                      {x.reacciones ? `${Math.round((x.misma_direccion / x.reacciones) * 100)} %` : '—'}
                    </td>
                    <td className="text-right tabular-nums" data-label="La siguieron">{x.seguidos}</td>
                    <td className="text-right tabular-nums" data-label="Cambios">{x.movimientos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </EstadoAnalisis>
    </div>
  );
}
