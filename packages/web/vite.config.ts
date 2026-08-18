import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
// pnpm's strict "exports" map blocks deep imports like
// "monaco-editor/esm/vs/editor/editor.worker?worker", so point it at the
// real file on disk.
const monacoWorker = path.resolve(
  rootDir,
  'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
);
const monacoJsonWorker = path.resolve(
  rootDir,
  'node_modules/monaco-editor/esm/vs/language/json/json.worker.js',
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: {
      'monaco-editor/esm/vs/editor/editor.worker.js': monacoWorker,
      'monaco-editor/esm/vs/language/json/json.worker.js': monacoJsonWorker,
    },
  },
  // Monaco's editor worker is ESM; tell Vite to emit it as ES so the
  // `?worker` import in main.tsx resolves correctly in both dev and build.
  worker: { format: 'es' },
  // react-force-graph pulls in force-graph + d3; pre-bundle so dev startup is fast.
  optimizeDeps: { include: ['react-force-graph-2d'], exclude: ['monaco-editor'] },
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split large vendor groups into their own long-term-cacheable chunks.
          if (id.includes('node_modules')) {
            if (id.includes('monaco-editor')) {
              return 'monaco';
            }
            if (id.includes('yaml') || id.includes('toml') || id.includes('papaparse')) {
              return 'formats';
            }
            if (id.includes('react') || id.includes('scheduler')) {
              return 'react';
            }
          }
          return undefined;
        },
      },
    },
  },
});
