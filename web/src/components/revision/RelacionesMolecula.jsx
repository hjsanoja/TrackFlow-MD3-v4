import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../supabase';
import { useToast } from '../../context/ToastContext';
import { useDimensiones } from '../../hooks/useDimensiones';
import BarraFiltros from '../BarraFiltros';
import FiltroChip from '../FiltroChip';
import InfoGrafico from '../InfoGrafico';
import CadenaBadge from '../CadenaBadge';
import { normalizar } from '../formulario';
import { compararMoleculas, moleculasEnNombre } from '../../utils/moleculas';

// Relaciones a revisar (fase 53): cada competidor vinculado a tu producto con
// las dos moleculas lado a lado. Detecta cruces errados como una marca tuya
// de Donepecilo contra una marca de Nifedipina, que con nombres comerciales
// no se ven a simple vista.
// La molecula del competidor es la que se carga aqui (molecula_competidor);
// si falta, se intenta leer de su nombre (sirve en genericos).
const faltaVista = (e) => /42P01|PGRST205|does not exist|Could not find/i.test(`${e?.code} ${e?.message}`);

const ESTADOS = {
  cruce: { texto: 'Cruce errado', icono: 'error', clase: 'is-cruce', ayuda: 'Las moléculas no coinciden: revisa la relación en Relación.' },
  sin_dato: { texto: 'Sin molécula', icono: 'help', clase: 'is-sin-dato', ayuda: 'Falta la molécula del competidor: escríbela para poder validar.' },
  parcial: { texto: 'Parcial', icono: 'join', clase: 'is-parcial', ayuda: 'Comparten una molécula pero una es combinación.' },
  coincide: { texto: 'Coincide', icono: 'check_circle', clase: 'is-coincide', ayuda: 'Misma molécula.' },
};
const ORDEN = { cruce: 0, sin_dato: 1, parcial: 2, coincide: 3 };

export default function RelacionesMolecula() {
  const { addToast } = useToast();
  const { principiosActivos = [] } = useDimensiones();
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [sinFase, setSinFase] = useState(false);
  const [mostrar, setMostrar] = useState('revisar'); // revisar | cruce | sin_dato | parcial | coincide | todas
  const [tipo, setTipo] = useState('todos');
  const [buscar, setBuscar] = useState('');
  const [editando, setEditando] = useState(null);
  const [texto, setTexto] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase.from('v_relaciones_molecula').select('*').limit(5000);
    if (error) {
      if (faltaVista(error)) setSinFase(true);
      else addToast(`No se pudieron cargar las relaciones: ${error.message}`, 'error');
      setFilas([]);
    } else {
      setFilas(data || []);
    }
    setCargando(false);
  }, [addToast]);
  useEffect(() => { cargar(); }, [cargar]);

  const evaluadas = useMemo(() => filas.map(f => {
    const leida = f.molecula_competidor ? null : moleculasEnNombre(f.competidor_nombre, principiosActivos).join(' + ') || null;
    const molecula = f.molecula_competidor || leida;
    return { ...f, leida, molecula, estado: compararMoleculas(f.propio_molecula, molecula) };
  }), [filas, principiosActivos]);

  const cuenta = useMemo(() => {
    const c = { cruce: 0, sin_dato: 0, parcial: 0, coincide: 0 };
    evaluadas.forEach(f => { c[f.estado] += 1; });
    return c;
  }, [evaluadas]);

  const visibles = useMemo(() => {
    const term = normalizar(buscar);
    return evaluadas
      .filter(f => (mostrar === 'todas' || (mostrar === 'revisar' ? f.estado === 'cruce' || f.estado === 'sin_dato' : f.estado === mostrar))
        && (tipo === 'todos' || String(f.competidor_tipo || '').toUpperCase() === tipo)
        && (!term || normalizar(`${f.propio_id} ${f.propio_nombre} ${f.propio_molecula} ${f.competidor_nombre} ${f.competidor_laboratorio} ${f.molecula || ''}`).includes(term)))
      .sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || String(a.propio_nombre).localeCompare(String(b.propio_nombre)));
  }, [evaluadas, mostrar, tipo, buscar]);

  const empezar = (f) => { setEditando(f.equivalencia_id); setTexto(f.molecula_competidor || f.leida || ''); };
  const guardar = async (f) => {
    setGuardando(true);
    const valor = texto.trim() || null;
    const { error } = await supabase.from('dim_productos').update({ molecula_competidor: valor }).eq('id', f.competidor_db_id);
    setGuardando(false);
    if (error) { addToast(`No se pudo guardar la molécula: ${error.message}`, 'error'); return; }
    // El mismo producto competidor puede estar en varias relaciones.
    setFilas(fs => fs.map(x => (x.competidor_db_id === f.competidor_db_id ? { ...x, molecula_competidor: valor } : x)));
    setEditando(null);
    addToast('Molécula guardada.', 'success');
  };

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
        etiqueta="Filtros de relaciones"
        limpiar={{ visible: mostrar !== 'revisar' || tipo !== 'todos', onClick: () => { setMostrar('revisar'); setTipo('todos'); } }}
        filtrar={(
          <>
            <FiltroChip etiqueta="Qué relaciones mostrar" icono="filter_list" valor={mostrar} onChange={setMostrar}
              opciones={[
                ['revisar', `Por revisar (${cuenta.cruce + cuenta.sin_dato})`],
                ['cruce', `Cruce errado (${cuenta.cruce})`],
                ['sin_dato', `Sin molécula (${cuenta.sin_dato})`],
                ['parcial', `Parcial (${cuenta.parcial})`],
                ['coincide', `Coincide (${cuenta.coincide})`],
                ['todas', `Todas (${evaluadas.length})`],
              ]} />
            <FiltroChip etiqueta="Tipo del competidor" icono="category" valor={tipo} onChange={setTipo}
              opciones={[['todos', 'Competidor: todos'], ['MARCA', 'Marcas'], ['GENERICO', 'Genéricos']]} />
          </>
        )}
      />

      <section className="m3-data-table" aria-label="Relaciones por molécula">
        <div className="m3-data-table-toolbar">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <label className="m3-search-field">
              <span className="material-symbols-outlined" aria-hidden="true">search</span>
              <input type="search" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar producto, competidor o molécula" aria-label="Buscar" />
            </label>
            <div className="flex items-center gap-1 md:ml-auto">
              <span className="m3-label-large text-on-surface-variant whitespace-nowrap" aria-live="polite">{visibles.length} relaciones</span>
              <InfoGrafico alinear="derecha" titulo="Relaciones a revisar"
                que="Cada competidor vinculado a tu producto, con la molécula de los dos. Sirve para encontrar relaciones mal hechas, sobre todo entre marcas."
                formula={['Se compara la molécula principal de cada lado, sin acentos ni diferencias de escritura (Donepezilo = Donepecilo).', 'Sin molécula cargada se intenta leer del nombre del competidor (sirve en genéricos).']}
                lectura="Rojo: las moléculas no coinciden; corrige o quita la relación en Relación. Ámbar: falta la molécula del competidor; toca el lápiz y escríbela."
                ejemplo="Tu marca de Donepecilo vinculada a «Adalat» (Nifedipina) sale como «Cruce errado»." />
            </div>
          </div>
        </div>

        {cargando ? (
          <div className="h-64 m3-skeleton" aria-busy="true" />
        ) : visibles.length === 0 ? (
          <div className="p-12 text-center text-on-surface-variant flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-3xl">check_circle</span>
            <div className="m3-title-medium text-on-surface">{evaluadas.length ? 'Nada por revisar con estos filtros' : 'Aún no hay relaciones'}</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="m3-table m3-table-apilada">
              <thead className="m3-sticky-header">
                <tr>
                  <th>Tu producto</th>
                  <th>Competidor</th>
                  <th>Molécula del competidor</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map(f => {
                  const e = ESTADOS[f.estado];
                  return (
                    <tr key={f.equivalencia_id}>
                      <td data-label="Tu producto">
                        <div className="m3-cell-primary m3-cell-clamp" title={f.propio_nombre}>{f.propio_nombre}</div>
                        <div className="m3-cell-secondary">{[f.propio_id, f.propio_molecula || 'sin molécula', f.propio_tipo === 'MARCA' ? 'Marca' : 'Genérico'].join(' · ')}</div>
                      </td>
                      <td data-label="Competidor">
                        <div className="m3-cell-primary m3-cell-clamp" title={f.competidor_nombre}>{f.competidor_nombre}</div>
                        <div className="m3-cell-secondary flex flex-wrap items-center gap-1">
                          {[f.competidor_laboratorio, f.competidor_tipo === 'MARCA' ? 'Marca' : 'Genérico'].filter(Boolean).join(' · ')}
                          {String(f.cadenas || '').split(', ').filter(Boolean).map(c => <CadenaBadge key={c} cadena={c} tamano="xs" />)}
                        </div>
                      </td>
                      <td data-label="Molécula del competidor">
                        {editando === f.equivalencia_id ? (
                          <form className="flex items-center gap-1" onSubmit={ev => { ev.preventDefault(); guardar(f); }}>
                            <input autoFocus list="tf-moleculas" value={texto} onChange={ev => setTexto(ev.target.value)} className="m3-input w-48"
                              placeholder="Ej.: Nifedipina" aria-label={`Molécula de ${f.competidor_nombre}`}
                              onKeyDown={ev => { if (ev.key === 'Escape') setEditando(null); }} disabled={guardando} />
                            <button type="submit" className="m3-icon-btn m3-icon-btn-sm" aria-label="Guardar" disabled={guardando}><span className="material-symbols-outlined">check</span></button>
                            <button type="button" className="m3-icon-btn m3-icon-btn-sm" aria-label="Cancelar" onClick={() => setEditando(null)}><span className="material-symbols-outlined">close</span></button>
                          </form>
                        ) : (
                          <div className="flex items-center gap-1">
                            <div className="min-w-0">
                              <div className={f.molecula ? 'm3-body-medium' : 'm3-body-medium text-on-surface-variant'}>{f.molecula || '—'}</div>
                              {f.leida && <div className="m3-cell-secondary">leída del nombre</div>}
                            </div>
                            <button type="button" className="m3-icon-btn m3-icon-btn-sm" onClick={() => empezar(f)} aria-label={`Escribir la molécula de ${f.competidor_nombre}`} title="Escribir la molécula del competidor">
                              <span className="material-symbols-outlined">edit</span>
                            </button>
                          </div>
                        )}
                      </td>
                      <td data-label="Estado">
                        <span className={`m3-relacion-estado ${e.clase}`} title={e.ayuda}>
                          <span className="material-symbols-outlined" aria-hidden="true">{e.icono}</span>{e.texto}
                        </span>
                        {f.estado === 'cruce' && (
                          <div><Link to={`/competencia?producto=${encodeURIComponent(f.propio_id)}`} className="m3-body-small text-primary underline">Revisar en Relación</Link></div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <datalist id="tf-moleculas">{principiosActivos.map(m => <option key={m} value={m} />)}</datalist>
    </div>
  );
}
