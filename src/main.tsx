import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Inject web-mode API if not running in Electron
// Electron's preload script sets window.api via contextBridge
if (!window.api) {
  import('./services/web-api').then(({ webApi }) => {
    (window as any).api = webApi;
    console.log('[Web Mode] Using browser-compatible API');
    mountApp();
  });
} else {
  mountApp();
}

function mountApp() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
