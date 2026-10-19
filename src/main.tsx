import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { disableBrowserFeatures } from './lib/desktop';
import './styles.css';

// Foxen es una app de escritorio: se apagan los comportamientos de navegador
// (menu contextual, recargar, zoom, devtools) antes de montar la interfaz.
disableBrowserFeatures();

const root = document.getElementById('root');
if (!root) throw new Error('No se encontro el elemento #root en index.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);