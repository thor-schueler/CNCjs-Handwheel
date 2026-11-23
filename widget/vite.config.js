import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bridge's health endpoint (http.host / http.port in the bridge config).
const BRIDGE = process.env.HANDWHEEL_BRIDGE || 'http://127.0.0.1:8001';

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs: the widget is mounted by CNCjs at an arbitrary path (cncjs --mount /handwheel:<dist>).
  base: './',
  plugins: [react()],
  server: {
    // `npm run dev` talks to a bridge running on this machine; same path the production proxy uses.
    proxy: {
      '/handwheel-api': {
        target: BRIDGE,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/handwheel-api/, '')
      }
    }
  }
});
