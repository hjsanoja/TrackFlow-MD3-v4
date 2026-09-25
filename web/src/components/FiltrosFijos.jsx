import { useLayoutEffect, useRef } from 'react';

// Barra de filtros que queda fija arriba (debajo de la barra de la app) al
// bajar por la pagina: los filtros siempre estan a mano, sin volver a subir.
// Publica su alto en --alto-filtros para que la barra de busqueda de las
// tablas se quede justo debajo y no detras.
export default function FiltrosFijos({ children, etiqueta = 'Filtros' }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const raiz = document.documentElement;
    const publicar = () => raiz.style.setProperty('--alto-filtros', `${el.offsetHeight + 8}px`);
    publicar();
    const obs = new ResizeObserver(publicar);
    obs.observe(el);
    return () => { obs.disconnect(); raiz.style.removeProperty('--alto-filtros'); };
  }, []);
  return (
    <section ref={ref} className="m3-dash-filtros m3-filtros-fijos" aria-label={etiqueta}>
      {children}
    </section>
  );
}
