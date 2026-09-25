import CadenaBadge from './CadenaBadge';
import { useMemo, useState } from 'react';
import ModalWrapper from './ModalWrapper';
import { normalizar } from './formulario';
import { describirPresentacion } from '../utils/presentacion';

// Cobertura por cadena: por cada producto propio activo, en que cadenas tiene
// su propio enlace (lo vigila el robot) y cuantos competidores hay. Un hueco
// es una cadena donde tu producto no tiene enlace propio.
export default function CoberturaCadenas({ productos, cadenas, enlaces, idCadena, onVincular, onClose }) {
  const [buscar, setBuscar] = useState('');
  const [soloHuecos, setSoloHuecos] = useState(false);

  const cadenasActivas = useMemo(() => (cadenas || []).filter(c => c.activo !== false), [cadenas]);
  const propios = useMemo(() => (productos || [])
    .filter(p => p.activo !== false)
    .sort((a, b) => String(a.id_interno).localeCompare(String(b.id_interno), undefined, { numeric: true })), [productos]);

  // producto -> cadena -> { propio, competidores }
  const mapa = useMemo(() => {
    const m = new Map();
    for (const e of enlaces || []) {
      if (e.activo === false) continue;
      const id = String(e.id_producto_propio || '').trim();
      const cad = idCadena(e.cadena);
      if (!m.has(id)) m.set(id, new Map());
      const porCadena = m.get(id);
      const celda = porCadena.get(cad) || { propio: false, competidores: 0 };
      if (String(e.tipo).toLowerCase() === 'propio') celda.propio = true;
      else celda.competidores += 1;
      porCadena.set(cad, celda);
    }
    return m;
  }, [enlaces, idCadena]);

  const celda = (p, c) => mapa.get(String(p.id_interno))?.get(c.id) || { propio: false, competidores: 0 };
  const huecos = (p) => cadenasActivas.filter(c => !celda(p, c).propio).length;

  const filas = useMemo(() => {
    const term = normalizar(buscar);
    return propios.filter(p => (!soloHuecos || huecos(p) > 0) &&
      (!term || normalizar(`${p.id_interno} ${p.nombre}`).includes(term)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propios, buscar, soloHuecos, mapa, cadenasActivas]);

  const cubiertos = (c) => propios.filter(p => celda(p, c).propio).length;
  const sinNinguna = propios.filter(p => cadenasActivas.every(c => !celda(p, c).propio)).length;

  return (
    <ModalWrapper
      isOpen
      onClose={onClose}
      title="Cobertura por cadena"
      subtitle={`En qué cadenas tiene enlace propio cada uno de tus ${propios.length} productos activos. ${sinNinguna} no tienen ninguno.`}
      icon="grid_view"
      maxWidth="max-w-6xl"
      footer={<button type="button" onClick={onClose} className="m3-btn-text">Cerrar</button>}
    >
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <label className="m3-search-field md:max-w-md">
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input type="search" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar por ID o nombre" aria-label="Buscar producto" />
          </label>
          <label className="m3-switch-label md:ml-auto">
            <input type="checkbox" role="switch" checked={soloHuecos} onChange={e => setSoloHuecos(e.target.checked)} className="m3-switch" />
            <span>Solo productos con cadenas sin enlace propio</span>
          </label>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 m3-body-small text-on-surface-variant">
          <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[18px] text-primary">check_circle</span>tu enlace</span>
          <span className="inline-flex items-center gap-1"><span className="m3-count">3</span>competidores</span>
          <span className="inline-flex items-center gap-1"><span className="material-symbols-outlined text-[18px]">add_link</span>vincular tu enlace en esa cadena</span>
        </div>

        <div className="overflow-auto max-h-[60vh] rounded-2xl border border-outline-variant">
          <table className="m3-table m3-table-cobertura">
            <thead className="m3-sticky-header">
              <tr>
                <th className="m3-cobertura-producto">Producto</th>
                {cadenasActivas.map(c => (
                  <th key={c.id} className="text-center">
                    <div className="inline-flex items-center gap-1.5"><CadenaBadge cadena={c.id} tamano="xs" title="" />{c.nombre}</div>
                    <div className="m3-cell-secondary font-normal">{cubiertos(c)} de {propios.length}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map(p => (
                <tr key={p.id_interno}>
                  <td className="m3-cobertura-producto">
                    <div className="m3-cell-primary" title={p.nombre}>{p.nombre}</div>
                    <div className="m3-cell-secondary">
                      <span className="font-mono">{p.id_interno}</span>
                      {` · ${[p.concentracion, describirPresentacion(p)].filter(v => v && v !== '—').join(' · ')}`}
                    </div>
                  </td>
                  {cadenasActivas.map(c => {
                    const { propio, competidores } = celda(p, c);
                    return (
                      <td key={c.id} className="text-center">
                        <div className="inline-flex items-center justify-center gap-1.5">
                          {propio ? (
                            <span className="material-symbols-outlined text-[20px] text-primary" title="Tu producto tiene enlace en esta cadena">check_circle</span>
                          ) : (
                            <button type="button" onClick={() => onVincular(p.id_interno, c.id)} className="m3-icon-btn m3-icon-btn-sm"
                              title={`Vincular ${p.nombre} en ${c.nombre}`} aria-label={`Vincular ${p.nombre} en ${c.nombre}`}>
                              <span className="material-symbols-outlined">add_link</span>
                            </button>
                          )}
                          {competidores > 0 && (
                            <span className="m3-count" title={`${competidores} ${competidores === 1 ? 'competidor' : 'competidores'} en ${c.nombre}`}>{competidores}</span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {filas.length === 0 && (
                <tr><td colSpan={cadenasActivas.length + 1} className="text-center text-on-surface-variant py-8">Ningún producto coincide.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </ModalWrapper>
  );
}
