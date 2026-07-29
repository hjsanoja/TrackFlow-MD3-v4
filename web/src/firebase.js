import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, initializeFirestore, memoryLocalCache, setLogLevel } from 'firebase/firestore';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyMockKeyForTrackFlowStudio',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'trackflow-app.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'trackflow-app',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'trackflow-app.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789:web:123456789',
};

setLogLevel('silent');

let app;
let auth;
let db;

try {
  app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    db = getFirestore(app);
  } catch {
    db = initializeFirestore(app, {
      localCache: memoryLocalCache()
    });
  }
} catch (err) {
  console.warn('Firebase initialization warning:', err?.message || String(err));
}

export { app, auth, db };


