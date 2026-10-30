import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vite para la demo: cambia la base de datos y la tasa por datos de ejemplo.
const D = path.resolve(import.meta.dirname);
export default defineConfig({
  root: path.resolve(D, '..'),
  plugins: [react(), {
    name: 'demo', enforce: 'pre',
    resolveId(src, imp) {
      if (!imp || imp.includes('node_modules') || imp.startsWith(D)) return null;
      if (/context\/DataContext(\.jsx)?$/.test(src)) return path.join(D, 'DataContext.jsx');
      if (/hooks\/useBcvRate(\.js)?$/.test(src)) return path.join(D, 'useBcvRate.js');
      if (/(^|\/)supabase(\.js)?$/.test(src)) return path.join(D, 'supabase.js');
      return null;
    },
  }],
  server: { port: 5198 },
});
