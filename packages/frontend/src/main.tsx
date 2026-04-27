import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { NotificationProvider } from './stores/notifications.js';
import { applyTheme, getStoredPreference, watchSystem } from './theme.js';
import './styles/index.css';

// Apply persisted (or system) theme before React mounts to avoid a flash.
applyTheme(getStoredPreference());

// When the user follows the system theme, react to OS changes live.
watchSystem(() => {
  if (getStoredPreference() === 'system') applyTheme('system');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <NotificationProvider>
        <App />
      </NotificationProvider>
    </BrowserRouter>
  </StrictMode>,
);
