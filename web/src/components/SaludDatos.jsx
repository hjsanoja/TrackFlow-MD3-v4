import CadenaBadge from './CadenaBadge';
import InfoGrafico from './InfoGrafico';

// Semaforo de salud de los datos (Cadenas): por cadena activa, que parte de
// sus enlaces activos tiene un precio de los ultimos 15 dias (los demas ya no
// cuentan en los analisis) y cuantos se leyeron hoy. Sirve para saber cuanto
// confiar en los numeros de cada cadena.
//   verde >= 90 % · ambar 70 a 90 % · rojo < 70 %
export const nivelSalud = (pct) => (pct == null ? 'gris' : pct >= 90 ? 'verde' : pct >= 70 ? 'ambar' : 'rojo');
const TEXTO = { verde: 'Confiable', ambar: 'Revisar', rojo: 'Poco confiable', gris: 'Sin enlaces' };
const esHoy = (f) => f && new Date(f).toDateString() === new Date().toDateString();

export function calcularSalud(enlaces) {
  const total = enlaces.length;
  const alDia = enlaces.filter(e => Number(e.ultimo_precio_full_bs) > 0).length;
  const hoy = enlaces.filter(e => Number(e.ultimo_precio_full_bs) > 0 && esHoy(e.ultimo_scrape)).length;
  return { total, alDia, hoy, pct: total ? (alDia / total) * 100 : null };
}

export default function SaludDatos({ filas }) {
  if (!filas.length) return null;
  const total = filas.reduce((n, f) => n + f.salud.total, 0);
  const alDia = filas.reduce((n, f) => n + f.salud.alDia, 0);
  const pctTotal = total ? (alDia / total) * 100 : null;
  return (
    <section className="m3-dash-card" aria-label="Salud de los datos">
      <header className="m3-dash-card-header items-center">
        <div className="min-w-0 flex items-center gap-1">
          <h2 className="m3-title-medium text-on-surface">Salud de los datos</h2>
          <InfoGrafico titulo="Salud de los datos"
            que="Por cadena activa: qué parte de sus enlaces tiene un precio leído en los últimos 15 días. Los precios más viejos ya no cuentan en los análisis."
            formula="Al día = enlaces activos con precio de los últimos 15 días ÷ enlaces activos"
            lectura="Verde (90 % o más): confía en los números de esa cadena. Ámbar (70 a 90 %): revisa sus enlaces. Rojo (menos de 70 %): sus comparaciones están incompletas."
            ejemplo="Farmatodo 498 de 526 al día = 95 %, verde." />
        </div>
        <span className={`m3-salud-chip is-${nivelSalud(pctTotal)}`}>
          <i aria-hidden="true" />Total {pctTotal == null ? '—' : `${Math.round(pctTotal)} %`} al día
        </span>
      </header>
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        {filas.map(({ cadena, salud }) => {
          const nivel = nivelSalud(salud.pct);
          return (
            <li key={cadena.id} className="m3-salud-item" title={`${TEXTO[nivel]}: ${salud.alDia} de ${salud.total} enlaces con precio de los últimos 15 días · ${salud.hoy} leídos hoy`}>
              <CadenaBadge cadena={cadena.id} tamano="sm" title="" />
              <div className="min-w-0 flex-1">
                <div className="m3-body-medium text-on-surface truncate">{cadena.nombre}</div>
                <div className="m3-body-small text-on-surface-variant">{salud.alDia} de {salud.total} al día · {salud.hoy} hoy</div>
              </div>
              <span className={`m3-salud-chip is-${nivel}`}><i aria-hidden="true" />{salud.pct == null ? '—' : `${Math.round(salud.pct)} %`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
