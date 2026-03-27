import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  optimizeDeps: {
    // Don't pre-bundle the Even Hub SDK — it crashes outside the Even App WebView
    exclude: ['@evenrealities/even_hub_sdk'],
  },
});
