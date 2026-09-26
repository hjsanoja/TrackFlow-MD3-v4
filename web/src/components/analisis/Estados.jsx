// Estados comunes de las pestanas de analisis: cargando, falta SQL, vacio.
export function EstadoAnalisis({ cargando, faltaSql, fase, error, vacio, hayFilas, children }) {
  if (cargando && !hayFilas) return <div className="h-64 rounded-3xl m3-skeleton" aria-busy="true" />;
  if (faltaSql) return <Aviso icono="database" texto={`Falta correr ${fase} en Supabase para ver esto.`} />;
  if (error) return <Aviso icono="error" texto={`No se pudo cargar: ${error.message}`} />;
  if (!hayFilas) return <Aviso icono="query_stats" texto={vacio} />;
  return children;
}

function Aviso({ icono, texto }) {
  return (
    <div className="m3-dash-card h-48 flex flex-col items-center justify-center gap-2 text-on-surface-variant text-center px-6">
      <span className="material-symbols-outlined text-3xl" aria-hidden="true">{icono}</span>
      <span className="m3-body-medium">{texto}</span>
    </div>
  );
}
