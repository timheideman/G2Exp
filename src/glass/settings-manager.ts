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
