import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is served by the Node process on :3000; in dev, Vite proxies to it so
// the app is one origin in development as well as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.PORT || 3000}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
