import { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  // opciones.accion = { texto, onClick }: un boton en el aviso, p. ej.
  // "Deshacer". Con accion el aviso dura mas (8 s) para dar tiempo a usarlo.
  const addToast = useCallback((message, type = 'info', opciones = {}) => {
    const id = Date.now() + Math.random().toString(36).substr(2, 9);
    const { accion = null, duracion = accion ? 8000 : 4000 } = opciones;
    setToasts((prev) => [...prev, { id, message, type, accion }]);

    setTimeout(() => {
      removeToast(id);
    }, duracion);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      
      {/* Floating Toast Container - z-index higher than modal cards (100000) and scrims (99999) */}
      <div className="fixed bottom-6 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-[100005] flex flex-col gap-3 pointer-events-none">
        {toasts.map((t) => {
          const icon = { success: 'check_circle', error: 'error', warning: 'warning' }[t.type] || 'info';
          return (
            <div
              key={t.id}
              className={`m3-toast is-${t.type || 'info'} pointer-events-auto animate-fade-in-slide`}
              role="alert"
            >
              <span className="material-symbols-outlined m3-toast-icono select-none shrink-0" aria-hidden="true">
                {icon}
              </span>
              <div className="flex-1 m3-body-medium">
                {t.message}
              </div>
              {t.accion && (
                <button
                  type="button"
                  onClick={() => { removeToast(t.id); t.accion.onClick(); }}
                  className="shrink-0 text-xs font-bold uppercase tracking-wide text-primary hover:underline"
                >
                  {t.accion.texto}
                </button>
              )}
              <button
                onClick={() => removeToast(t.id)}
                className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
              >
                <span className="material-symbols-outlined select-none text-base">close</span>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
