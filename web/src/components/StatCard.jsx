/**
 * Tarjeta de indicador (KPI), única para todo el panel.
 *
 * Antes cada fila de indicadores se construía a mano y acababa mezclando las
 * tres variantes de tarjeta de Material Design 3 en una misma fila: una con
 * borde oscuro, otra con sombra y sin borde, otra rellena con un tinte de la
 * paleta cruda de Tailwind (bg-red-500/10). Cada una con su radio y su sombra.
 *
 * M3 define esas tres variantes como excluyentes. Aquí todas las tarjetas son
 * la misma variante (elevated) y lo único que cambia con el tono semántico es
 * el COLOR del número y del icono, nunca la forma ni la elevación. Así la fila
 * se lee como una cuadrícula y el color sigue comunicando el estado.
 */
export default function StatCard({
  label,
  value,
  hint,
  icon,
  tono = 'neutral',   // neutral | primary | positive | negative | warning
  onClick,
  title,
  compacto = false,   // version baja: deja mas sitio a graficos y tablas
}) {
  const clases = [
    'm3-stat',
    compacto ? 'm3-stat-compact' : '',
    tono !== 'neutral' ? `m3-stat-${tono}` : '',
    onClick ? 'cursor-pointer m3-interactive text-left w-full' : '',
  ].filter(Boolean).join(' ');

  const Etiqueta = onClick ? 'button' : 'div';

  return (
    <Etiqueta className={clases} onClick={onClick} title={title} type={onClick ? 'button' : undefined}>
      <div className="m3-stat-body">
        <div className="m3-stat-label" title={label}>{label}</div>
        <div className="m3-stat-value">{value}</div>
        {hint && <div className="m3-stat-hint" title={hint}>{hint}</div>}
      </div>
      {icon && (
        <div className="m3-stat-icon" aria-hidden="true">
          <span className={`material-symbols-outlined ${compacto ? 'text-[18px]' : 'text-[22px]'}`}>{icon}</span>
        </div>
      )}
    </Etiqueta>
  );
}
