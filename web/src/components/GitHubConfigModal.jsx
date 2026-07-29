import { useState, useEffect } from 'react';
import { getGitHubConfig, saveGitHubConfig } from '../utils/githubClient';
import { useToast } from '../context/ToastContext';

export default function GitHubConfigModal({ isOpen, onClose, onSaveSuccess }) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [form, setForm] = useState({
    token: '',
    repo_owner: '',
    repo_name: '',
    workflow_event_type: 'run-scraper'
  });

  useEffect(() => {
    if (isOpen) {
      (async () => {
        const config = await getGitHubConfig();
        if (config) {
          setForm({
            token: config.token || '',
            repo_owner: config.repo_owner || '',
            repo_name: config.repo_name || '',
            workflow_event_type: config.workflow_event_type || 'run-scraper'
          });
        }
      })();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.token.trim()) {
      addToast('Ingresa tu Token Personal de GitHub (PAT)', 'error');
      return;
    }
    if (!form.repo_owner.trim()) {
      addToast('Ingresa el Usuario u Organización de GitHub', 'error');
      return;
    }
    if (!form.repo_name.trim()) {
      addToast('Ingresa el Nombre del Repositorio en GitHub', 'error');
      return;
    }

    setLoading(true);
    try {
      const saved = await saveGitHubConfig(form);
      addToast('Configuración de GitHub guardada correctamente.', 'success');
      if (onSaveSuccess) onSaveSuccess(saved);
      onClose();
    } catch (err) {
      addToast('Error al guardar configuración: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl max-w-lg w-full overflow-hidden border border-slate-200 dark:border-slate-700">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/50 rounded-xl text-indigo-600 dark:text-indigo-400">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Conexión GitHub Actions
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Configura la conexión para disparar los scrapers automáticamente.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 p-1 rounded-lg"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-1">
              Token Personal de GitHub (PAT) <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                placeholder="ghp_xxx o github_pat_xxx"
                className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-2.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                {showToken ? 'Ocultar' : 'Ver'}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Crea un token en GitHub: <i>Settings &gt; Developer Settings &gt; Personal access tokens</i> con alcance <code className="bg-slate-100 dark:bg-slate-900 px-1 rounded">repo</code>.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-1">
                Usuario / Repo Owner <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={form.repo_owner}
                onChange={(e) => setForm({ ...form, repo_owner: e.target.value })}
                placeholder="ej: hjsanoja"
                className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-1">
                Nombre Repositorio <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={form.repo_name}
                onChange={(e) => setForm({ ...form, repo_name: e.target.value })}
                placeholder="ej: TrackFlow"
                className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-1">
              Tipo de Evento Disparador
            </label>
            <input
              type="text"
              value={form.workflow_event_type}
              onChange={(e) => setForm({ ...form, workflow_event_type: e.target.value })}
              placeholder="run-scraper"
              className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white"
            />
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700/60 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-xl shadow-md transition-all flex items-center gap-2"
            >
              {loading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Guardar Configuración
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
