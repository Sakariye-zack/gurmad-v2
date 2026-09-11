import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './design-system/tokens.css';
import { applyStoredTheme } from './lib/theme.js';

// Applied before the first render so a user who already chose a theme
// never sees a flash of the other one on load.
applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
