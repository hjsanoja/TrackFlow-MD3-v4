import { useId } from 'react';

// Logo de TrackFlow («pulso de precio»): una linea de precio que sube y baja
// y un punto verde en el precio que se vigila. El mismo dibujo es el icono de
// la pestana del navegador (public/favicon.svg).
export default function Logo({ tamano = 40, className = '' }) {
  const id = useId();
  return (
    <svg width={tamano} height={tamano} viewBox="0 0 64 64" className={className} role="img" aria-label="TrackFlow">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1B4B8F" />
          <stop offset="1" stopColor="#0F2C59" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id})`} />
      <polyline points="10,40 20,40 26,28 33,46 40,18 46,34 54,34" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="40" cy="18" r="5.5" fill="#2EC4A6" stroke="#0F2C59" strokeWidth="2" />
    </svg>
  );
}
