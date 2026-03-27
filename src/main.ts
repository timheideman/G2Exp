/**
 * LiveCaption — Entry Point
 *
 * Bootstraps the app and wires up the companion UI.
 * Auto-detects G2 glasses vs browser mode.
 */

import { LiveCaptionApp } from './glass/app';

const app = new LiveCaptionApp();

// Wire up companion UI elements
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const btnToggle = document.getElementById('btn-toggle');
const btnClear = document.getElementById('btn-clear');

app.onStatusChange = (text: string, connected: boolean) => {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = `status ${connected ? 'connected' : ''}`;
  }
};

app.onTranscriptUpdate = (text: string) => {
  if (previewEl) {
    previewEl.textContent = text || 'Waiting for audio...';
    previewEl.scrollTop = previewEl.scrollHeight;
  }
};

// Toggle button
btnToggle?.addEventListener('click', () => {
  app.toggleBrowserCapture();
  const isListening = btnToggle.textContent === '⏸ Pause';
  btnToggle.textContent = isListening ? '🎙 Start Listening' : '⏸ Pause';
  btnToggle.className = isListening ? 'btn' : 'btn active';
});

// Clear button
btnClear?.addEventListener('click', () => {
  app.clearTranscript();
  if (previewEl) previewEl.textContent = 'Waiting for audio...';
});

// Boot
app.init().then(() => {
  console.log('[LiveCaption] Ready');
}).catch((err) => {
  console.error('[LiveCaption] Failed to initialize:', err);
  if (statusEl) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'status error';
  }
});

// Clean up
window.addEventListener('beforeunload', () => {
  app.destroy();
});
