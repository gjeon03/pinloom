import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
  plugins: [react(), tailwindcss()],
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
