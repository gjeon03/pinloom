import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.PORT || '3300';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
      },
    },
  },
});
