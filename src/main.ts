/**
 * LiveCaption — Entry Point
 *
 * Bootstraps the app, wires up the companion UI,
 * and initializes the settings panel.
 */

import { LiveCaptionApp } from './glass/app';
import { LANGUAGES } from './types/settings';

const app = new LiveCaptionApp();

// ─── UI Elements ──────────────────────────────────────────────

const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const btnToggle = document.getElementById('btn-toggle');
const btnClear = document.getElementById('btn-clear');
const settingsToggle = document.getElementById('settings-toggle');
const settingsBody = document.getElementById('settings-body');
const langGrid = document.getElementById('lang-grid');

// ─── Status & Transcript Callbacks ────────────────────────────

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

// ─── Toggle Listening ─────────────────────────────────────────

let listening = false;
btnToggle?.addEventListener('click', async () => {
  await app.toggleBrowserCapture();
  listening = !listening;
  if (btnToggle) {
    btnToggle.textContent = listening ? '⏸ Pause' : '🎙 Start Listening';
    btnToggle.className = listening ? 'btn active' : 'btn';
  }
});

btnClear?.addEventListener('click', () => {
  app.clearTranscript();
  if (previewEl) previewEl.textContent = 'Waiting for audio...';
});

// ─── Settings Panel ───────────────────────────────────────────

// Toggle settings visibility
settingsToggle?.addEventListener('click', () => {
  const isOpen = settingsBody?.classList.toggle('open');
  settingsToggle.classList.toggle('open', isOpen);
});

// Build language grid
function buildLanguageGrid(): void {
  if (!langGrid) return;
  const currentLang = app.settings.current.language.code;

  langGrid.innerHTML = '';
  for (const lang of LANGUAGES) {
    const el = document.createElement('div');
    el.className = `lang-option ${lang.code === currentLang ? 'selected' : ''}`;
    el.innerHTML = `<span class="flag">${lang.flag}</span><span class="name">${lang.label}</span>`;
    el.addEventListener('click', () => {
      app.settings.setLanguage(lang.code);
      // Update UI selection
      langGrid.querySelectorAll('.lang-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
    });
    langGrid.appendChild(el);
  }
}

// Initialize toggles
function initToggles(): void {
  const settings = app.settings.current;

  const smartToggle = document.getElementById('toggle-smart');
  const profanityToggle = document.getElementById('toggle-profanity');

  if (smartToggle) {
    smartToggle.classList.toggle('on', settings.smartFormat);
    smartToggle.addEventListener('click', () => {
      const newValue = !app.settings.current.smartFormat;
      app.settings.update({ smartFormat: newValue });
      smartToggle.classList.toggle('on', newValue);
    });
  }

  if (profanityToggle) {
    profanityToggle.classList.toggle('on', settings.profanityFilter);
    profanityToggle.addEventListener('click', () => {
      const newValue = !app.settings.current.profanityFilter;
      app.settings.update({ profanityFilter: newValue });
      profanityToggle.classList.toggle('on', newValue);
    });
  }
}

// ─── Debug Panel ──────────────────────────────────────────────

const debugEl = document.getElementById('debug');
const debugLog = (msg: string) => {
  const ts = new Date().toLocaleTimeString();
  if (debugEl) {
    debugEl.innerHTML += `<div><span style="color:#444">${ts}</span> ${msg}</div>`;
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  console.log(`[Debug] ${msg}`);
};

// Intercept console.log/error for BrowserAudio and LiveCaption messages
const origLog = console.log;
const origErr = console.error;
console.log = (...args: any[]) => {
  origLog.apply(console, args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[BrowserAudio]') || msg.includes('[LiveCaption]') || msg.includes('[DisplaySim]')) {
    debugLog(msg);
  }
};
console.error = (...args: any[]) => {
  origErr.apply(console, args);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  debugLog(`<span style="color:#FF453A">❌ ${msg}</span>`);
};

debugLog('App starting...');

// ─── Boot ─────────────────────────────────────────────────────

buildLanguageGrid();
initToggles();

app.init().then(() => {
  console.log('[LiveCaption] Ready');
}).catch((err) => {
  console.error('[LiveCaption] Failed to initialize:', err);
  if (statusEl) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'status error';
  }
});

window.addEventListener('beforeunload', () => {
  app.destroy();
});
