import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Monaco web workers must be wired up for Vite — without this, Monaco falls
// back to a broken main-thread path and the editor never becomes interactive.
// The worker is resolved through a Vite alias (see vite.config.ts) because
// pnpm's strict "exports" map blocks the bare `?worker` deep import.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    // JSON language features (validation, document symbols, folding, colors)
    // are served by the dedicated json worker; everything else falls back to
    // the base editor worker. Returning only the editor worker makes every
    // language request fail with "Missing requestHandler".
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    );
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
