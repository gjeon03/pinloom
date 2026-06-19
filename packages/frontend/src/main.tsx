import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { NotificationProvider } from './stores/notifications.js';
import { applyTheme, getStoredPreference, watchSystem } from './theme.js';
// Side-effect import: attach the PWA `beforeinstallprompt` listener at startup
// so the deferred install prompt is captured before the user opens Settings.
import './stores/pwaInstall.js';
// Side-effect import: register the service worker and auto-reload the tab when
// a new build's SW activates, so updates don't get stuck behind a stale cache.
import './stores/pwaUpdate.js';
import 'dockview-react/dist/styles/dockview.css';
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
