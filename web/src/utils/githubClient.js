import { supabase, isSupabaseActive } from '../supabase';
import { db } from '../firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

export async function getGitHubConfig() {
  let config = null;

  // 1. Intentar desde Supabase
  if (isSupabaseActive()) {
    try {
      const { data, error } = await supabase.from('secrets').select('*').eq('id', 'github_dispatch').maybeSingle();
      if (!error && data && data.token) {
        config = data;
      }
    } catch (e) {
      console.warn('Error leyendo secrets desde Supabase:', e);
    }
  }

  // 2. Intentar desde Firestore
  if (!config && db) {
    try {
      const secretSnap = await getDoc(doc(db, 'secrets', 'github_dispatch'));
      if (secretSnap.exists()) {
        config = secretSnap.data();
      }
    } catch (e) {
      console.warn('Error leyendo secrets desde Firestore:', e);
    }
  }

  // 3. Fallback localStorage
  if (!config) {
    const local = localStorage.getItem('trackflow_github_config');
    if (local) {
      try {
        config = JSON.parse(local);
      } catch (_) {}
    }
  }

  return config;
}

export async function saveGitHubConfig(configData) {
  const cleanConfig = {
    id: 'github_dispatch',
    token: (configData.token || '').trim(),
    repo_owner: (configData.repo_owner || '').trim(),
    repo_name: (configData.repo_name || '').trim(),
    workflow_event_type: (configData.workflow_event_type || 'run-scraper').trim(),
    updated_at: new Date().toISOString()
  };

  // Guardar en localStorage
  localStorage.setItem('trackflow_github_config', JSON.stringify(cleanConfig));

  // Guardar en Supabase
  if (isSupabaseActive()) {
    try {
      await supabase.from('secrets').upsert(cleanConfig);
    } catch (e) {
      console.warn('Error guardando secret en Supabase:', e);
    }
  }

  // Guardar en Firestore
  if (db) {
    try {
      await setDoc(doc(db, 'secrets', 'github_dispatch'), cleanConfig, { merge: true });
    } catch (e) {
      console.warn('Error guardando secret en Firestore:', e);
    }
  }

  return cleanConfig;
}

export async function triggerGitHubScraper({ config, payload = null }) {
  if (!config || !config.token || !config.repo_owner || !config.repo_name) {
    throw new Error('CONFIG_MISSING');
  }

  const url = `https://api.github.com/repos/${config.repo_owner}/${config.repo_name}/dispatches`;
  const bodyData = {
    event_type: config.workflow_event_type || 'run-scraper'
  };

  if (payload) {
    bodyData.client_payload = payload;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(bodyData),
  });

  if (res.status === 204) {
    return { success: true };
  }

  let details = '';
  try {
    const json = await res.json();
    if (json.message) details = json.message;
  } catch (_) {
    details = await res.text();
  }

  if (res.status === 404) {
    throw new Error(`Repositorio '${config.repo_owner}/${config.repo_name}' no encontrado en GitHub o el Token no tiene permisos 'repo'. (${res.status})`);
  } else if (res.status === 401) {
    throw new Error(`Token de GitHub no autorizado o expirado. (${res.status})`);
  } else {
    throw new Error(`GitHub respondió con código ${res.status}${details ? ': ' + details : ''}`);
  }
}
