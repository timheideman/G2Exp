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
    // The app loads on the phone over LAN; Vite's HMR websocket otherwise tries
    // to reach the dev server at a host the WebView can't resolve, spamming the
    // console with connection errors. Setting VITE_HMR_HOST=<laptop-LAN-IP>
    // (or disabling HMR) keeps the dev WebView console clean. Re-scan the QR to
    // force a full reload after a code change regardless.
    hmr: process.env.VITE_HMR_HOST
      ? { host: process.env.VITE_HMR_HOST, protocol: 'ws' }
      : undefined,
  },
  optimizeDeps: {
    // Don't pre-bundle the Even Hub SDK — it crashes outside the Even App WebView
    exclude: ['@evenrealities/even_hub_sdk'],
  },
});
