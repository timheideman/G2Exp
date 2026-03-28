/**
 * SettingsManager — Persists and manages app settings
 *
 * Uses localStorage in browser mode, bridge.setLocalStorage on glasses.
 * Notifies listeners on changes so the server connection can be reconfigured.
 */

import { DEFAULT_SETTINGS, LANGUAGES } from '../types/settings';
import type { LiveCaptionSettings, LanguageOption } from '../types/settings';

const STORAGE_KEY = 'livecaption_settings';

export class SettingsManager {
  private settings: LiveCaptionSettings;
  private listeners: Array<(settings: LiveCaptionSettings) => void> = [];

  constructor() {
    this.settings = this.load();
  }

  /** Get current settings */
  get current(): LiveCaptionSettings {
    return { ...this.settings };
  }

  /** Update settings and notify listeners */
  update(partial: Partial<LiveCaptionSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.save();
    this.notifyListeners();
  }

  /** Set language by code */
  setLanguage(code: string): void {
    const lang = LANGUAGES.find(l => l.code === code);
    if (lang) {
      this.update({ language: lang });
    }
  }

  /** Register change listener */
  onChange(callback: (settings: LiveCaptionSettings) => void): void {
    this.listeners.push(callback);
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) {
      cb(this.settings);
    }
  }

  private load(): LiveCaptionSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Resolve language object from code
        const lang = LANGUAGES.find(l => l.code === parsed.language?.code) || LANGUAGES[0];
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          language: lang,
        };
      }
    } catch {
      // Ignore parse errors
    }
    return { ...DEFAULT_SETTINGS };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // localStorage unavailable
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ReconnectScheduler — WebSocket auto-reconnect with exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Manages WebSocket reconnect attempts with exponential backoff.
 *
 * Usage:
 * ```ts
 * const reconnect = new ReconnectScheduler();
 * reconnect.onStatusChange = (msg) => setStatus(msg);
 *
 * ws.onclose = () => reconnect.schedule(() => connectWebSocket());
 * ws.onopen  = () => reconnect.reset();
 * ```
 *
 * Delays: 1s → 2s → 4s → 8s → 16s → 30s (capped)
 */
export class ReconnectScheduler {
  private currentDelay: number = RECONNECT_MIN_DELAY_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional callback invoked when reconnect status changes.
   * Receives a human-readable message like "Reconnecting in 2s…"
   * or "Connected" after a successful reconnect (see reset()).
   */
  onStatusChange?: (message: string) => void;

  /** Current backoff delay in milliseconds (before the next attempt). */
  get nextDelay(): number {
    return this.currentDelay;
  }

  /**
   * Schedule a reconnect attempt after the current backoff delay.
   * If a timer is already pending this is a no-op (won't double-schedule).
   * The backoff doubles for the *subsequent* call after this one fires.
   */
  schedule(callback: () => void): void {
    if (this.timer !== null) return; // already scheduled

    const delay = this.currentDelay;
    const secs = Math.round(delay / 1000);
    this.onStatusChange?.(`Reconnecting in ${secs}s…`);

    this.timer = setTimeout(() => {
      this.timer = null;
      // Double the delay for the next attempt, capped at max
      this.currentDelay = Math.min(this.currentDelay * 2, RECONNECT_MAX_DELAY_MS);
      callback();
    }, delay);
  }

  /** Cancel any pending reconnect timer (e.g., when app is torn down). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reset backoff to the initial delay.
   * Call this on a successful WebSocket connection.
   */
  reset(): void {
    this.cancel();
    this.currentDelay = RECONNECT_MIN_DELAY_MS;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — Deepgram / server error messages → user-friendly strings
// ─────────────────────────────────────────────────────────────────────────────

/** Known error codes from Deepgram or the backend proxy. */
const API_KEY_PATTERNS = [
  'api_key', 'api key', 'invalid_api_key', 'unauthorized', 'authentication',
  '401', 'forbidden', '403',
];
const QUOTA_PATTERNS = [
  'quota', 'quota_exceeded', 'rate_limit', 'too_many_requests',
  '429', 'usage_limit',
];

/**
 * Translate a server error `{ type: 'error', code, message }` into a
 * user-friendly string for display in the companion UI.
 *
 * @param code     Error code string from the server (may be HTTP status as string)
 * @param message  Raw error message from the server
 * @returns        A localised, user-friendly error string
 */
export function handleServerError(code: string, message: string): string {
  const codeLower = code.toLowerCase();
  const messageLower = message.toLowerCase();

  const matchesApiKey =
    API_KEY_PATTERNS.some(p => codeLower.includes(p)) ||
    API_KEY_PATTERNS.some(p => messageLower.includes(p));

  if (matchesApiKey) {
    return 'Transcription service unavailable — check API key';
  }

  const matchesQuota =
    QUOTA_PATTERNS.some(p => codeLower.includes(p)) ||
    QUOTA_PATTERNS.some(p => messageLower.includes(p));

  if (matchesQuota) {
    return 'Usage limit reached — please try again later';
  }

  // Generic fallback — show the raw message but keep it clean
  return message || 'An unknown error occurred';
}
