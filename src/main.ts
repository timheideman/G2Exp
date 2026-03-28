/**
 * LiveCaption — Entry Point
 *
 * Bootstraps the app, wires up the companion UI,
 * initializes the settings panel, and sets up enrollment.
 */

import { LiveCaptionApp } from './glass/app';
import { LANGUAGES } from './types/settings';
import { ContactStore } from './glass/contact-store';
import { SessionLabels } from './glass/session-labels';
import { EnrollmentRecorder } from './glass/enrollment-recorder';
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
  // Re-wrap WS onmessage on every connect (handles reconnects too)
  // Also re-sync voiceprints if we're in contacts mode
  if (connected) {
    setTimeout(() => {
      rewrapWsOnMessage();
      if (app.settings.current.idMode === 'contacts') {
        loadVoiceprintsOnServer();
      }
    }, 0);
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

settingsToggle?.addEventListener('click', () => {
  const isOpen = settingsBody?.classList.toggle('open');
  settingsToggle.classList.toggle('open', isOpen);
});

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
      langGrid.querySelectorAll('.lang-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
    });
    langGrid.appendChild(el);
  }
}

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
  origLog(`[Debug] ${msg}`);
};

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
const enrollmentRecorder = new EnrollmentRecorder(contactStore);

// Wire session labels into transcript display
app.display.setNameResolver((speakerIndex) => sessionLabels.getShortTag(speakerIndex));

// ─── WebSocket interception ───────────────────────────────────

/**
 * Wrap the app's WebSocket onmessage to intercept enrollment and
 * speaker_identified messages before the app's handler sees them.
 * Called after each connection (and reconnection).
 */
function rewrapWsOnMessage(): void {
  const ws = (app as any).ws as WebSocket | null;
  if (!ws) return;
  if ((ws as any).__enrollWrapped) return; // Already wrapped this instance

  const origOnMessage = ws.onmessage;
  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

      // 1. Enrollment messages
      if (enrollmentRecorder.handleServerMessage(msg)) {
        return; // Consumed
      }

      // 2. Speaker identification from server matching pipeline
      if (msg.type === 'speaker_identified') {
        handleSpeakerIdentified(msg);
        return;
      }
    } catch {
      // Binary or non-JSON — pass through
    }
    origOnMessage?.call(ws, event);
  };

  (ws as any).__enrollWrapped = true;
  enrollmentRecorder.setSendFn((data) => {
    const currentWs = (app as any).ws as WebSocket | null;
    if (currentWs?.readyState === WebSocket.OPEN) {
      currentWs.send(data as any);
    }
  });
}

function handleSpeakerIdentified(msg: {
  speakerIndex: number;
  name: string;
  voiceprintId: string | null;
  confidence: number;
}): void {
  sessionLabels.applyServerIdentification(msg.speakerIndex, msg.name, msg.voiceprintId);
  debugLog(`✅ Identified speaker ${msg.speakerIndex} as "${msg.name}" (${(msg.confidence * 100).toFixed(1)}%)`);
  updateSpeakersPanel();
}

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

      // When switching to contacts mode, load voiceprints on server session
      if (mode === 'contacts') {
        loadVoiceprintsOnServer();
      }
    };

    modeAnon.addEventListener('click', () => setMode('anonymous'));
    modeContacts.addEventListener('click', () => setMode('contacts'));
  }
}

/** Send all stored contacts to the server for this session */
function loadVoiceprintsOnServer(): void {
  const ws = (app as any).ws as WebSocket | null;
  if (ws?.readyState !== WebSocket.OPEN) return;

  const contacts = contactStore.getAll();
  if (contacts.length === 0) return;

  const voiceprints = contacts.map(c => ({
    id: c.id,
    name: c.name,
    embedding: c.embedding,
  }));

  ws.send(JSON.stringify({ type: 'load_voiceprints', voiceprints }));
  debugLog(`Loaded ${voiceprints.length} voiceprint(s) for speaker matching`);
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

  // Add Contact button → open fresh enrollment modal
  document.getElementById('btn-add-contact')?.addEventListener('click', () => {
    openEnrollModal(null, null);
  });

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

  document.getElementById('btn-delete-all')?.addEventListener('click', () => {
    if (confirm('Delete ALL saved contacts and voiceprints? This cannot be undone.')) {
      contactStore.deleteAll();
      renderContacts();
      debugLog('All contacts deleted');
    }
  });

  const importInput = document.getElementById('btn-import') as HTMLInputElement | null;
  const importStatus = document.getElementById('import-status');

  importInput?.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file || !importStatus) return;

    importStatus.textContent = 'Importing…';
    importStatus.style.color = '#888';

    const result = await contactStore.importFromFile(file);
    importInput.value = ''; // reset so same file can be re-imported if needed

    if (result.error) {
      importStatus.textContent = `❌ ${result.error}`;
      importStatus.style.color = '#FF453A';
      debugLog(`Import failed: ${result.error}`);
    } else if (result.imported === 0) {
      importStatus.textContent = `No new contacts — all ${result.skipped} already saved.`;
      importStatus.style.color = '#888';
      debugLog('Import: no new contacts');
    } else {
      importStatus.textContent = `✅ Imported ${result.imported} contact${result.imported !== 1 ? 's' : ''}${result.skipped ? ` (${result.skipped} already existed)` : ''}.`;
      importStatus.style.color = '#30D158';
      debugLog(`Imported ${result.imported} contact(s)`);
      // Re-sync to server if in contacts mode
      if (app.settings.current.idMode === 'contacts') loadVoiceprintsOnServer();
    }

    // Clear status after 4 seconds
    setTimeout(() => { if (importStatus) importStatus.textContent = ''; }, 4000);
  });

  contactStore.onChange(renderContacts);
  renderContacts();
}

// ─── Speakers Panel (live session) ────────────────────────────

function initSpeakersPanel(): void {
  const toggle = document.getElementById('speakers-toggle');
  const body = document.getElementById('speakers-body');

  toggle?.addEventListener('click', () => {
    const isOpen = body?.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
  });

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
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="speaker-tag">${s.letter}</span>
          <input class="speaker-name-input" data-speaker="${s.index}"
            value="${labelInfo ? labelInfo.name : ''}"
            placeholder="${displayName}" />
          <span class="speaker-type">${typeLabel}</span>
          <button class="btn-save-speaker" data-save-speaker="${s.index}"
            data-speaker-label="${labelInfo?.name || displayName}"
            title="Save as contact using session audio">💾</button>
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

  // Wire up 💾 save-as-contact buttons
  listEl.querySelectorAll('[data-save-speaker]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const el = e.currentTarget as HTMLElement;
      const idx = parseInt(el.getAttribute('data-save-speaker') || '0', 10);
      const label = el.getAttribute('data-speaker-label') || `Speaker ${idx}`;
      openEnrollModal(idx, label);
    });
  });
}

// ─── Enrollment Modal ─────────────────────────────────────────

const ENROLL_MAX_SECONDS = 15;

let enrollCountdownTimer: ReturnType<typeof setInterval> | null = null;
let enrollFromSpeakerIndex: number | null = null; // null = use mic, number = from buffer

/** Open the "Add Contact" modal.
 *  speakerIndex=null → mic recording flow
 *  speakerIndex=number → enroll_from_buffer flow
 */
function openEnrollModal(speakerIndex: number | null, prefillName: string | null): void {
  enrollFromSpeakerIndex = speakerIndex;

  const backdrop = document.getElementById('enroll-modal-backdrop');
  const nameInput = document.getElementById('enroll-name-input') as HTMLInputElement;
  const status = document.getElementById('enroll-status');
  const progress = document.getElementById('enroll-progress');
  const btnStart = document.getElementById('enroll-btn-start');
  const btnStop = document.getElementById('enroll-btn-stop');

  if (!backdrop || !nameInput || !status || !progress || !btnStart || !btnStop) return;

  // Reset state
  resetEnrollModalState();

  // Pre-fill name if provided
  if (prefillName) nameInput.value = prefillName;

  if (speakerIndex !== null) {
    // From-buffer mode: show different CTA
    if (btnStart) btnStart.textContent = '💾 Save from Session';
    if (status) status.textContent = `Will use buffered audio from Speaker ${String.fromCharCode(65 + speakerIndex)}.`;
  } else {
    if (btnStart) btnStart.textContent = '🎙 Start Recording';
  }

  backdrop.classList.add('open');
  nameInput.focus();
}

function closeEnrollModal(): void {
  const backdrop = document.getElementById('enroll-modal-backdrop');
  backdrop?.classList.remove('open');
  resetEnrollModalState();
  enrollmentRecorder.cancelEnrollment();
}

function resetEnrollModalState(): void {
  stopEnrollCountdown();

  const nameInput = document.getElementById('enroll-name-input') as HTMLInputElement | null;
  const status = document.getElementById('enroll-status');
  const progress = document.getElementById('enroll-progress');
  const progressFill = document.getElementById('enroll-progress-fill') as HTMLElement | null;
  const progressLabel = document.getElementById('enroll-progress-label');
  const btnStart = document.getElementById('enroll-btn-start');
  const btnStop = document.getElementById('enroll-btn-stop');

  if (nameInput) nameInput.value = '';
  if (nameInput) nameInput.disabled = false;
  if (status) { status.textContent = ''; status.className = 'enroll-status'; }
  if (progress) progress.classList.remove('visible');
  if (progressFill) progressFill.style.width = '0%';
  if (progressLabel) progressLabel.textContent = `0 / ${ENROLL_MAX_SECONDS}s`;
  if (btnStart) { btnStart.style.display = ''; (btnStart as HTMLButtonElement).disabled = false; }
  if (btnStop) btnStop.style.display = 'none';
}

function stopEnrollCountdown(): void {
  if (enrollCountdownTimer !== null) {
    clearInterval(enrollCountdownTimer);
    enrollCountdownTimer = null;
  }
}

function startEnrollCountdown(onComplete: () => void): void {
  const progress = document.getElementById('enroll-progress');
  const progressFill = document.getElementById('enroll-progress-fill') as HTMLElement | null;
  const progressLabel = document.getElementById('enroll-progress-label');
  const btnStart = document.getElementById('enroll-btn-start');
  const btnStop = document.getElementById('enroll-btn-stop');

  progress?.classList.add('visible');
  if (btnStart) btnStart.style.display = 'none';
  if (btnStop) btnStop.style.display = '';

  let elapsed = 0;
  const INTERVAL_MS = 250;

  enrollCountdownTimer = setInterval(() => {
    elapsed += INTERVAL_MS / 1000;
    const pct = Math.min((elapsed / ENROLL_MAX_SECONDS) * 100, 100);

    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressLabel) progressLabel.textContent = `${elapsed.toFixed(1)} / ${ENROLL_MAX_SECONDS}s`;

    if (elapsed >= ENROLL_MAX_SECONDS) {
      stopEnrollCountdown();
      onComplete();
    }
  }, INTERVAL_MS);
}

function setEnrollStatus(msg: string, type: 'ok' | 'err' | 'info' = 'info'): void {
  const status = document.getElementById('enroll-status');
  if (!status) return;
  status.textContent = msg;
  status.className = type === 'ok' ? 'enroll-status ok'
    : type === 'err' ? 'enroll-status err'
    : 'enroll-status';
}

function initEnrollModal(): void {
  document.getElementById('enroll-modal-close')?.addEventListener('click', closeEnrollModal);

  // Close on backdrop click
  document.getElementById('enroll-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('enroll-modal-backdrop')) {
      closeEnrollModal();
    }
  });

  // Start button
  document.getElementById('enroll-btn-start')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('enroll-name-input') as HTMLInputElement;
    const name = nameInput?.value.trim();

    if (!name) {
      setEnrollStatus('Please enter a name first.', 'err');
      nameInput?.focus();
      return;
    }

    const btnStart = document.getElementById('enroll-btn-start') as HTMLButtonElement;
    if (btnStart) btnStart.disabled = true;
    if (nameInput) nameInput.disabled = true;

    // ── From-buffer mode ────────────────────────────────────
    if (enrollFromSpeakerIndex !== null) {
      setEnrollStatus('Processing session audio…');

      const outcome = await enrollmentRecorder.enrollFromBuffer(
        enrollFromSpeakerIndex,
        name,
      );

      if (outcome.success) {
        setEnrollStatus(`Contact "${name}" saved! ✓`, 'ok');
        renderContacts();
        debugLog(`Enrolled "${name}" from session buffer`);
        setTimeout(closeEnrollModal, 1500);
      } else {
        setEnrollStatus(outcome.error, 'err');
        if (btnStart) btnStart.disabled = false;
        if (nameInput) nameInput.disabled = false;
      }
      return;
    }

    // ── Mic recording mode ──────────────────────────────────
    try {
      await enrollmentRecorder.startEnrollment();
    } catch (err: any) {
      setEnrollStatus(`Mic error: ${err?.message || 'denied'}`, 'err');
      if (btnStart) btnStart.disabled = false;
      if (nameInput) nameInput.disabled = false;
      return;
    }

    setEnrollStatus('Recording… speak naturally for 15 seconds.');

    startEnrollCountdown(() => {
      // Auto-stop at 15s
      handleEnrollStop(name);
    });
  });

  // Stop button
  document.getElementById('enroll-btn-stop')?.addEventListener('click', () => {
    const nameInput = document.getElementById('enroll-name-input') as HTMLInputElement;
    const name = nameInput?.value.trim() || 'Unknown';
    stopEnrollCountdown();
    handleEnrollStop(name);
  });
}

async function handleEnrollStop(name: string): Promise<void> {
  stopEnrollCountdown();

  const btnStop = document.getElementById('enroll-btn-stop');
  const btnStart = document.getElementById('enroll-btn-start');
  if (btnStop) btnStop.style.display = 'none';

  setEnrollStatus('Processing… extracting voice signature.');

  const outcome = await enrollmentRecorder.stopEnrollment(name);

  if (outcome.success) {
    setEnrollStatus(`Contact "${name}" saved! ✓`, 'ok');
    renderContacts();
    debugLog(`Enrolled contact "${name}" (${outcome.durationMs}ms sample)`);
    setTimeout(closeEnrollModal, 1500);
  } else {
    setEnrollStatus(outcome.error, 'err');
    // Show retry: re-enable start button
    if (btnStart) {
      (btnStart as HTMLButtonElement).disabled = false;
      btnStart.style.display = '';
      (document.getElementById('enroll-name-input') as HTMLInputElement).disabled = false;
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────

buildLanguageGrid();
initToggles();
initModeToggle();
initContacts();
initSpeakersPanel();
initEnrollModal();

app.init().then(() => {
  console.log('[LiveCaption] Ready');
  // Initial WS wrap (may already be connected at this point)
  setTimeout(rewrapWsOnMessage, 100);
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
