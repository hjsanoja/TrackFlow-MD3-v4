// Aviso azul con el avance del robot (hooks/useRobot). Lo usan Competencia y
// Cadenas: la corrida se guarda en el navegador, asi que se ve en las dos.
export default function AvisoRobot({ robot }) {
  if (!robot?.corrida) return null;
  const c = robot.corrida;
  return (
    <div className="m3-banner m3-banner-info" role="status" aria-live="polite">
      <span className="material-symbols-outlined animate-spin" aria-hidden="true">sync</span>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="m3-body-medium">
          <strong>El robot está leyendo {c.ids ? `${c.total} ${c.total === 1 ? 'enlace' : 'enlaces'}` : `los ${c.total} enlaces activos`}</strong>
          {c.etiqueta ? ` de ${c.etiqueta}` : ''}
          {' · '}{c.estadoGitHub === 'queued' ? 'en cola en GitHub' : robot.minutos < 1 ? 'arrancando' : `${robot.minutos} de unos ${c.estimado} min`}
          <span className="text-on-surface-variant"> · puedes seguir usando el panel</span>
        </div>
        <div className="m3-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(robot.avance)}>
          <div style={{ width: `${Math.max(4, robot.avance)}%` }} />
        </div>
      </div>
      {c.urlGitHub && (
        <a href={c.urlGitHub} target="_blank" rel="noopener noreferrer" className="m3-btn-text">Ver en GitHub</a>
      )}
      <button type="button" onClick={robot.ocultar} className="m3-icon-btn" title="Dejar de seguir (el robot sigue trabajando)" aria-label="Dejar de seguir el robot">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  );
}
