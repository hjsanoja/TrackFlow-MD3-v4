import Select from './Select';

// Filtro como chip con menu: ocupa el ancho de su texto y no cuatro grupos de
// botones. Con un valor distinto de 'todos' se marca como activo (check).
export default function FiltroChip({ etiqueta, icono, valor, onChange, opciones }) {
  const activo = valor !== 'todos';
  return (
    <Select value={valor} onChange={e => onChange(e.target.value)} aria-label={etiqueta}
      className={`m3-filter-chip ${activo ? 'is-active' : ''}`} leadingIcon={activo ? 'check' : icono}>
      {opciones.map(([v, texto]) => <option key={v} value={v}>{texto}</option>)}
    </Select>
  );
}
