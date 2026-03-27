/**
 * LiveCaption — Entry Point
 *
 * Bootstraps the glasses app. This file is loaded by the
 * WebView when the Even App opens the plugin.
 */

import { LiveCaptionApp } from './glass/app';

const app = new LiveCaptionApp();

app.init().catch((err) => {
  console.error('[LiveCaption] Failed to initialize:', err);
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  app.destroy();
});
