import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, initializeFirestore, memoryLocalCache, setLogLevel } from 'firebase/firestore';

/**
 * Firebase es capa heredada: la autenticación es 100% Supabase (ver Login.jsx
 * y App.jsx) y los datos viven en el modelo dimensional. Lo único que queda es
 * la escritura a Firestore para retrocompatibilidad.
 *
 * Antes se inicializaba SIEMPRE, cayendo en un proyecto de relleno
 * ("AIzaSyMockKeyForTrackFlowStudio", proyecto trackflow-app) cuando no había
 * credenciales reales. Eso hacía que `db` fuera un objeto válido apuntando a
 * ninguna parte, y setDoc() resolvía contra la caché local: de ahí salía el
 * bug de "guardado con éxito" que en realidad no guardaba nada, porque el
 * falso éxito de Firestore tapaba el fallo real de Supabase.
 *
 * Ahora, sin credenciales reales, `db` queda `undefined`. Todos los
 * consumidores ya comprueban `if (db)`, así que simplemente no se escribe.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
};

export function isFirebaseConfigured() {
  const { apiKey, projectId } = firebaseConfig;
  return Boolean(apiKey && projectId && !apiKey.toLowerCase().includes('mock'));
}

let app;
let auth;
let db;

if (isFirebaseConfigured()) {
  setLogLevel('silent');
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    try {
      db = getFirestore(app);
    } catch {
      db = initializeFirestore(app, { localCache: memoryLocalCache() });
    }
  } catch (err) {
    console.warn('Firebase no se pudo inicializar:', err?.message || String(err));
  }
}

export { app, auth, db };
