import { useState, useEffect } from 'react';
import { getGitHubConfig, saveGitHubConfig } from '../utils/githubClient';
import { useToast } from '../context/ToastContext';
import ModalWrapper from './ModalWrapper';

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
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      title="Conexión GitHub Actions"
      subtitle="Configura la conexión para disparar los scrapers automáticamente."
      icon="terminal"
      maxWidth="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-1 font-mono">
            Token Personal de GitHub (PAT) <span className="text-error">*</span>
          </label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              placeholder="ghp_xxx o github_pat_xxx"
              className="m3-input pr-16"
              required
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-primary hover:text-primary/80"
            >
              {showToken ? 'Ocultar' : 'Ver'}
            </button>
          </div>
          <p className="text-[11px] text-on-surface-variant mt-1 font-sans">
            Crea un token en GitHub: <span className="font-semibold">Settings &gt; Developer Settings &gt; Personal access tokens</span> con alcance <code className="bg-surface-container-high px-1.5 py-0.5 rounded font-mono text-[10px]">repo</code>.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-1 font-mono">
              Usuario / Repo Owner <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={form.repo_owner}
              onChange={(e) => setForm({ ...form, repo_owner: e.target.value })}
              placeholder="ej: hjsanoja"
              className="m3-input"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-1 font-mono">
              Nombre Repositorio <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={form.repo_name}
              onChange={(e) => setForm({ ...form, repo_name: e.target.value })}
              placeholder="ej: TrackFlow"
              className="m3-input"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-1 font-mono">
            Tipo de Evento Disparador
          </label>
          <input
            type="text"
            value={form.workflow_event_type}
            onChange={(e) => setForm({ ...form, workflow_event_type: e.target.value })}
            placeholder="run-scraper"
            className="m3-input"
          />
        </div>

        <div className="pt-4 border-t border-outline-variant/60 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="m3-btn-outline h-9 px-4 text-xs"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={loading}
            className="m3-btn-primary h-9 px-5 text-xs"
          >
            {loading && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1.5" />}
            Guardar Configuración
          </button>
        </div>
      </form>
    </ModalWrapper>
  );
}
