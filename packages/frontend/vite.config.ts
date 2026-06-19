import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_PORT = process.env.PORT || '4748';

const proxy = {
  '/api': `http://localhost:${API_PORT}`,
  // Forward the browser's real Origin (no rewriteWsOrigin) so the backend's
  // WS origin allowlist can distinguish the local frontend from a cross-site
  // hijack attempt.
  '/ws/terminal': {
    target: `ws://localhost:${API_PORT}`,
    ws: true,
  },
  '/ws': {
    target: `ws://localhost:${API_PORT}`,
    ws: true,
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable PWA so pinloom can run as a standalone desktop app window
    // (dock/taskbar icon, no browser chrome). pinloom is a dynamic localhost
    // app: the service worker precaches ONLY the static app shell — every
    // `/api` call and WebSocket stays on the network. `autoUpdate` swaps in a
    // new shell on the next load whenever `vite build` changes the asset
    // hashes (matters because prod re-serves via `vite preview` after build).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'pinloom',
        short_name: 'pinloom',
        description:
          'Local Claude Code workspace — persistent history, pinned answers, project wiki, team orchestration.',
        theme_color: '#1a1b26',
        background_color: '#1a1b26',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the built shell only. NEVER the dynamic surfaces:
        // - `/api/*`  → NetworkOnly (conversation data, settings, health)
        // - `/ws*`    → WebSockets bypass the SW fetch handler entirely, but
        //               we deny them from the SPA navigation fallback too so a
        //               socket path is never answered with index.html.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api') ||
              url.pathname.startsWith('/ws'),
            handler: 'NetworkOnly',
          },
          {
            // Serve the app shell network-first: pinloom is a localhost app
            // that's always online, so a navigation should fetch the freshest
            // index.html (pointing at the newest hashed assets) instead of the
            // precached one. The cache is only a fallback if the local server
            // is briefly unreachable. Pairs with the SW auto-reload so a new
            // build is picked up with minimal staleness.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-shell',
              networkTimeoutSeconds: 3,
            },
          },
        ],
        // A new pinloom build should take over immediately rather than waiting
        // for every tab to close — pairs with `registerType: 'autoUpdate'`.
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  server: {
    port: 4747,
    strictPort: false,
    watch: {
      // Reduce file descriptor pressure — these paths never affect the running
      // app and consume a large number of watchers on macOS.
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/data/**',
        '**/.pinloom-uploads/**',
        '**/*.sqlite*',
      ],
    },
    proxy,
  },
  preview: {
    port: 4747,
    strictPort: false,
    proxy,
  },
});
