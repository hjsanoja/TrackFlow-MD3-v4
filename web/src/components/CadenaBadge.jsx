import { getChainColor, siglaCadena } from '../utils/brandColors';

// Insignia de una cadena: circulo con su color y su sigla (fase 26). La misma
// en todos los menus, para reconocer la cadena de un vistazo.
export default function CadenaBadge({ cadena, tamano = 'md', title }) {
  const color = getChainColor(cadena);
  return (
    <span className={`m3-cadena-badge is-${tamano}`} style={{ backgroundColor: color }}
      title={title ?? cadena} aria-hidden={title === '' ? 'true' : undefined}>
      {siglaCadena(cadena)}
    </span>
  );
}
