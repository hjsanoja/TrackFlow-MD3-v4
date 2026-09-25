import { useMemo, useState } from 'react';
import CadenaBadge from '../CadenaBadge';
import { normalizar } from '../formulario';
import { Diferencia, mediana } from './comun';

// Vista por molecula: junta todos los productos con la misma molecula y
// concentracion (tus genericos, tus marcas y los de la competencia) y los
// compara SIEMPRE por unidad (tableta, capsula, ml...), porque las cajas
// traen cantidades distintas: una caja de 10 y una de 30 no se comparan.
export default function VistaMolecula({ items, busqueda, fmt, fmtUnidad, nombreCadena, onDetalle }) {
  const [orden, setOrden] = useState({ campo: 'nombre', dir: 'asc' });

  const moleculas = useMemo(() => {
    const grupos = new Map();
    for (const x of items) {
      const p = x.producto;
      if (!p.principio_activo) continue;
      const clave = `${normalizar(p.principio_activo)}|${normalizar(p.concentracion || '')}`;
      if (!grupos.has(clave)) {
        grupos.set(clave, { clave, nombre: p.principio_activo, concentracion: p.concentracion || '', productos: [], ofertas: [] });
      }
      const g = grupos.get(clave);
      g.productos.push(x);
      const propios = x.precios.filter(o => o.tipo === 'propio');
      for (const o of x.precios) g.ofertas.push({ ...o, item: x });
      // Sin enlace propio leido, tu precio es el PVP de la ficha.
      if (propios.length === 0 && x.tuUnidad != null) {
        g.ofertas.push({ id: `pvp_${p.id_interno}`, tipo: 'propio', pvp: true, cadena: null, marca: p.nombre, unidades: x.unidadesPropio, priceUsd: x.tuPrecio, unitUsd: x.tuUnidad, item: x });
      }
    }
    return [...grupos.values()].map(g => {
      // Una misma oferta puede estar vinculada a dos productos tuyos: se cuenta una vez.
      const vistas = new Set();
      g.ofertas = g.ofertas.filter(o => { const k = `${o.id}`; if (vistas.has(k)) return false; vistas.add(k); return true; });
      const tuyas = g.ofertas.filter(o => o.tipo === 'propio');
      const comp = g.ofertas.filter(o => o.tipo !== 'propio');
      const tuUnidad = tuyas.length ? Math.min(...tuyas.map(o => o.unitUsd)) : null;
      const valores = comp.map(o => o.unitUsd);
      const minimo = valores.length ? Math.min(...valores) : null;
      const promedio = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
      const ofertaMin = comp.find(o => o.unitUsd === minimo);
      return {
        ...g,
        tuUnidad,
        minimo,
        promedio,
        mediana: mediana(valores),
        cadenaMin: ofertaMin?.cadena,
        dif: tuUnidad != null && promedio > 0 ? (tuUnidad / promedio - 1) * 100 : null,
        competidores: comp.length,
      };
    });
  }, [items]);

  const filas = useMemo(() => {
    const term = normalizar(busqueda);
    const lista = moleculas.filter(m => !term || normalizar(`${m.nombre} ${m.concentracion} ${m.productos.map(x => `${x.producto.id_interno} ${x.producto.nombre}`).join(' ')}`).includes(term));
    const valor = { nombre: m => m.nombre, tuUnidad: m => m.tuUnidad, minimo: m => m.minimo, promedio: m => m.promedio, dif: m => m.dif, ofertas: m => m.ofertas.length }[orden.campo];
    const signo = orden.dir === 'asc' ? 1 : -1;
    return lista.sort((a, b) => {
      const va = valor(a); const vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb, 'es', { sensitivity: 'base' }) : va - vb) * signo;
    });
  }, [moleculas, busqueda, orden]);

  const ordenar = (campo) => setOrden(o => ({ campo, dir: o.campo === campo && o.dir === 'asc' ? 'desc' : 'asc' }));

  const abrir = (m) => {
    const ofertas = [...m.ofertas].sort((a, b) => a.unitUsd - b.unitUsd);
    onDetalle({
      titulo: `${m.nombre}${m.concentracion ? ` ${m.concentracion}` : ''}`,
      subtitulo: `Todas las ofertas de esta molécula, de la más barata a la más cara por unidad. Promedio de la competencia: ${fmtUnidad(m.promedio)} por unidad.`,
      icono: 'science',
      ancho: 'max-w-5xl',
      filas: ofertas,
      clave: o => `${o.id}`,
      abrir: o => o.item,
      columnas: [
        {
          titulo: 'Producto',
          celda: o => (
            <div className="min-w-0">
              <div className="m3-cell-primary m3-cell-clamp max-w-[16rem]" title={o.marca}>
                {o.marca}
              </div>
              <div className="m3-cell-secondary">
                {o.tipo === 'propio' ? <span className="m3-chip-propio">Tuyo</span> : 'Competidor'}
                {o.pvp ? ' · PVP de la ficha' : ''}
              </div>
            </div>
          ),
        },
        {
          titulo: 'Cadena',
          celda: o => (o.cadena
            ? <span className="inline-flex items-center gap-1.5"><CadenaBadge cadena={o.cadena} tamano="xs" title="" />{nombreCadena(o.cadena)}</span>
            : <span className="text-on-surface-variant">—</span>),
        },
        { titulo: 'Unidades', alinear: 'right', celda: o => (o.unidades > 1 ? `${o.unidades}` : '1') },
        { titulo: 'Precio', alinear: 'right', celda: o => fmt(o.priceUsd) },
        { titulo: 'Por unidad', alinear: 'right', celda: o => <strong className="font-medium">{fmtUnidad(o.unitUsd)}</strong> },
        { titulo: 'Frente al promedio', alinear: 'right', celda: o => <Diferencia valor={m.promedio > 0 ? (o.unitUsd / m.promedio - 1) * 100 : null} /> },
      ],
    });
  };

  if (filas.length === 0) {
    return (
      <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
        <span className="material-symbols-outlined text-3xl">science</span>
        <div className="m3-title-medium text-on-surface">Ninguna molécula coincide</div>
        <div className="m3-body-medium">Los productos sin molécula en su ficha no aparecen aquí.</div>
      </div>
    );
  }

  const Orden = ({ campo, children }) => {
    const activo = orden.campo === campo;
    return (
      <button type="button" onClick={() => ordenar(campo)} className={`m3-sort-btn ${activo ? 'is-active' : ''}`}>
        {children}
        <span className="material-symbols-outlined" aria-hidden="true">{activo ? (orden.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}</span>
      </button>
    );
  };

  return (
    <>
      <ul className="md:hidden divide-y divide-outline-variant" aria-label="Moléculas">
        {filas.map(m => (
          <li key={m.clave}>
            <button type="button" onClick={() => abrir(m)} className="w-full text-left px-4 py-3 space-y-1">
              <div className="m3-cell-primary">{m.nombre}</div>
              <div className="m3-cell-secondary">{m.concentracion || 'Sin concentración'} · {m.ofertas.length} ofertas</div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 m3-body-small">
                <span>Tuyo <strong className="font-medium">{fmtUnidad(m.tuUnidad)}</strong></span>
                <span>Promedio <strong className="font-medium">{fmtUnidad(m.promedio)}</strong></span>
                <Diferencia valor={m.dif} />
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden md:block overflow-x-auto">
        <table className="m3-table m3-table-dashboard">
          <thead className="m3-sticky-header">
            <tr>
              <th className="m3-dash-col-producto"><Orden campo="nombre">Molécula</Orden></th>
              <th>Tus productos</th>
              <th className="text-right"><Orden campo="ofertas">Ofertas</Orden></th>
              <th className="text-right m3-dash-col-sep"><Orden campo="tuUnidad">Tu precio por unidad</Orden></th>
              <th className="text-right"><Orden campo="minimo">Mínimo por unidad</Orden></th>
              <th className="text-right"><Orden campo="promedio">Promedio por unidad</Orden></th>
              <th className="text-right"><Orden campo="dif">Frente al promedio</Orden></th>
            </tr>
          </thead>
          <tbody>
            {filas.map(m => (
              <tr key={m.clave} onClick={() => abrir(m)} className="cursor-pointer" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') abrir(m); }}>
                <td className="m3-dash-col-producto">
                  <div className="m3-cell-primary m3-cell-clamp" title={m.nombre}>{m.nombre}</div>
                  <div className="m3-cell-secondary">{m.concentracion || 'Sin concentración'}</div>
                </td>
                <td>
                  <div className="m3-cell-clamp max-w-[16rem]" title={m.productos.map(x => x.producto.nombre).join(' · ')}>
                    {m.productos.length === 1 ? m.productos[0].producto.nombre : `${m.productos.length} productos`}
                  </div>
                  <div className="m3-cell-secondary">
                    {[...new Set(m.productos.map(x => ((x.producto.market_type || 'GENERICO').toUpperCase() === 'MARCA' ? 'Marca' : 'Genérico')))].join(' y ')}
                  </div>
                </td>
                <td className="text-right tabular-nums">{m.ofertas.length}</td>
                <td className="text-right whitespace-nowrap tabular-nums m3-dash-col-sep font-medium">{fmtUnidad(m.tuUnidad)}</td>
                <td className="text-right whitespace-nowrap tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    {m.cadenaMin && <CadenaBadge cadena={m.cadenaMin} tamano="xs" title={nombreCadena(m.cadenaMin)} />}
                    {fmtUnidad(m.minimo)}
                  </span>
                </td>
                <td className="text-right whitespace-nowrap tabular-nums">{fmtUnidad(m.promedio)}</td>
                <td className="text-right whitespace-nowrap"><Diferencia valor={m.dif} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m3-body-small text-on-surface-variant px-4 py-3 border-t border-outline-variant">
        {filas.length} {filas.length === 1 ? 'molécula' : 'moléculas'}. Precio por unidad = precio del empaque entre sus unidades (tabletas, cápsulas, sobres o ml, según la ficha).
      </p>
    </>
  );
}
