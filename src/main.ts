/**
 * LiveCaption — Entry Point
 *
 * Bootstraps the app, wires up the companion UI,
 * and initializes the settings panel.
 */

import { LiveCaptionApp } from './glass/app';
import { LANGUAGES } from './types/settings';
import { ContactStore } from './glass/contact-store';
import { SessionLabels } from './glass/session-labels';
import type { IdentificationMode } from './types/privacy';

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
const origLog = console.log;
const origErr = console.error;

const debugLog = (msg: string) => {
  const ts = new Date().toLocaleTimeString();
  if (debugEl) {
    debugEl.innerHTML += `<div><span style="color:#444">${ts}</span> ${msg}</div>`;
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  // Use origLog directly to avoid infinite recursion
  origLog(`[Debug] ${msg}`);
};

// Intercept console.log/error for BrowserAudio and LiveCaption messages
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

// ─── Contacts & Session Labels ────────────────────────────────

const contactStore = new ContactStore();
const sessionLabels = new SessionLabels();

// Wire session labels into transcript display
app.display.setNameResolver((speakerIndex) => sessionLabels.getShortTag(speakerIndex));

// ─── Mode Toggle ──────────────────────────────────────────────

function initModeToggle(): void {
  const modeAnon = document.getElementById('mode-anonymous');
  const modeContacts = document.getElementById('mode-contacts');
  const currentMode = app.settings.current.idMode;

  if (modeAnon && modeContacts) {
    modeAnon.classList.toggle('selected', currentMode === 'anonymous');
    modeContacts.classList.toggle('selected', currentMode === 'contacts');

    const setMode = (mode: IdentificationMode) => {
      app.settings.update({ idMode: mode });
      modeAnon.classList.toggle('selected', mode === 'anonymous');
      modeContacts.classList.toggle('selected', mode === 'contacts');
      debugLog(`Mode: ${mode}`);
    };

    modeAnon.addEventListener('click', () => setMode('anonymous'));
    modeContacts.addEventListener('click', () => setMode('contacts'));
  }
}

// ─── Contacts Panel ───────────────────────────────────────────

function renderContacts(): void {
  const listEl = document.getElementById('contacts-list');
  const countEl = document.getElementById('contacts-count');
  if (!listEl || !countEl) return;

  const contacts = contactStore.getAll();
  countEl.textContent = String(contacts.length);

  if (contacts.length === 0) {
    listEl.innerHTML = '<div style="font-size:13px;color:#555;">No contacts saved yet.</div>';
    return;
  }

  listEl.innerHTML = contacts.map(c => {
    const created = new Date(c.createdAt).toLocaleDateString();
    const lastMatch = c.lastMatchedAt
      ? new Date(c.lastMatchedAt).toLocaleDateString()
      : 'never';
    return `
      <div class="contact-item" data-id="${c.id}">
        <div>
          <div class="contact-name">${c.name}</div>
          <div class="contact-meta">Added ${created} · Last matched: ${lastMatch}</div>
        </div>
        <button class="contact-delete" data-delete="${c.id}" title="Delete voiceprint">✕</button>
      </div>
    `;
  }).join('');

  // Wire delete buttons
  listEl.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = (e.currentTarget as HTMLElement).getAttribute('data-delete');
      if (id && confirm('Delete this contact and their voiceprint?')) {
        contactStore.delete(id);
        renderContacts();
      }
    });
  });
}

function initContacts(): void {
  const contactsToggle = document.getElementById('contacts-toggle');
  const contactsBody = document.getElementById('contacts-body');
  contactsToggle?.addEventListener('click', () => {
    const isOpen = contactsBody?.classList.toggle('open');
    contactsToggle.classList.toggle('open', isOpen);
  });

  // Export button
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const data = contactStore.export();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `livecaption-contacts-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    debugLog('Contacts exported');
  });

  // Delete all button
  document.getElementById('btn-delete-all')?.addEventListener('click', () => {
    if (confirm('Delete ALL saved contacts and voiceprints? This cannot be undone.')) {
      contactStore.deleteAll();
      renderContacts();
      debugLog('All contacts deleted');
    }
  });

  // Re-render on changes
  contactStore.onChange(renderContacts);
  renderContacts();
}

// ─── Speakers Panel (live session) ────────────────────────────

function initSpeakersPanel(): void {
  const panel = document.getElementById('speakers-panel');
  const toggle = document.getElementById('speakers-toggle');
  const body = document.getElementById('speakers-body');

  toggle?.addEventListener('click', () => {
    const isOpen = body?.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
  });

  // Show panel when speakers are detected
  app.onTranscriptUpdate = ((origCallback) => {
    return (text: string) => {
      origCallback?.(text);
      updateSpeakersPanel();
    };
  })(app.onTranscriptUpdate);
}

function updateSpeakersPanel(): void {
  const panel = document.getElementById('speakers-panel');
  const listEl = document.getElementById('speakers-list');
  const speakers = app.getSpeakers();

  if (speakers.length === 0) return;
  if (panel) panel.style.display = '';

  if (!listEl) return;

  listEl.innerHTML = speakers.map(s => {
    const labels = sessionLabels.getAllLabels();
    const labelInfo = labels.find(l => l.speakerIndex === s.index);
    const displayName = sessionLabels.getDisplayName(s.index);
    const typeLabel = labelInfo?.type === 'identified' ? '✅ identified'
      : labelInfo?.type === 'labeled' ? '✏️ labeled'
      : '';

    return `
      <div class="speaker-item">
        <div style="display:flex;align-items:center;">
          <span class="speaker-tag">${s.letter}</span>
          <input class="speaker-name-input" data-speaker="${s.index}"
            value="${labelInfo ? labelInfo.name : ''}"
            placeholder="${displayName}" />
          <span class="speaker-type">${typeLabel}</span>
        </div>
      </div>
    `;
  }).join('');

  // Wire up name inputs for session labeling
  listEl.querySelectorAll('.speaker-name-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const idx = parseInt(el.getAttribute('data-speaker') || '0', 10);
      const name = el.value.trim();
      if (name) {
        sessionLabels.setLabel(idx, name);
        debugLog(`Labeled speaker ${idx} as "${name}"`);
      } else {
        sessionLabels.removeLabel(idx);
      }
    });
  });
}

// ─── Boot ─────────────────────────────────────────────────────

buildLanguageGrid();
initToggles();
initModeToggle();
initContacts();
initSpeakersPanel();

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
