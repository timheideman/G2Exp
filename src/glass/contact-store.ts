/**
 * ContactStore — On-device voiceprint storage
 *
 * All biometric data stays on the phone. Uses localStorage/IndexedDB
 * in browser mode, bridge.setLocalStorage on G2.
 *
 * Privacy guarantees:
 * - Voiceprints never leave the device
 * - Only explicitly enrolled contacts are stored
 * - Unknown speakers are never saved
 * - Full GDPR export and individual delete support
 */

import type { SavedContact, VoiceprintExport } from '../types/privacy';

const STORAGE_KEY = 'livecaption_contacts';
const VERSION = '1.0.0';

export class ContactStore {
  private contacts: Map<string, SavedContact> = new Map();
  private listeners: Array<() => void> = [];

  constructor() {
    this.load();
    this.pruneExpired();
  }

  /** Register change listener */
  onChange(callback: () => void): void {
    this.listeners.push(callback);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  // ─── CRUD ───────────────────────────────────────────────────

  /** Add a new contact with voiceprint */
  add(name: string, embedding: number[], sampleDurationMs: number, expiryDays?: number): SavedContact {
    const contact: SavedContact = {
      id: `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      embedding,
      createdAt: Date.now(),
      lastMatchedAt: null,
      sampleDurationMs,
      expiryDays: expiryDays ?? null,
    };
    this.contacts.set(contact.id, contact);
    this.save();
    this.notify();
    return contact;
  }

  /** Update a contact's name */
  rename(id: string, newName: string): boolean {
    const contact = this.contacts.get(id);
    if (!contact) return false;
    contact.name = newName;
    this.save();
    this.notify();
    return true;
  }

  /** Delete a contact and their voiceprint */
  delete(id: string): boolean {
    const deleted = this.contacts.delete(id);
    if (deleted) {
      this.save();
      this.notify();
    }
    return deleted;
  }

  /** Delete all contacts */
  deleteAll(): void {
    this.contacts.clear();
    this.save();
    this.notify();
  }

  /** Get a contact by ID */
  get(id: string): SavedContact | undefined {
    return this.contacts.get(id);
  }

  /** Get all contacts */
  getAll(): SavedContact[] {
    return Array.from(this.contacts.values());
  }

  /** Find contact by name (case-insensitive) */
  findByName(name: string): SavedContact | undefined {
    const lower = name.toLowerCase();
    for (const c of this.contacts.values()) {
      if (c.name.toLowerCase() === lower) return c;
    }
    return undefined;
  }

  /** Record that a contact was matched in a session */
  recordMatch(id: string): void {
    const contact = this.contacts.get(id);
    if (contact) {
      contact.lastMatchedAt = Date.now();
      this.save();
    }
  }

  /** Number of stored contacts */
  get size(): number {
    return this.contacts.size;
  }

  // ─── Expiry ─────────────────────────────────────────────────

  /** Remove expired voiceprints */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, contact] of this.contacts) {
      if (contact.expiryDays !== null) {
        const expiryMs = contact.expiryDays * 24 * 60 * 60 * 1000;
        const lastActivity = contact.lastMatchedAt || contact.createdAt;
        if (now - lastActivity > expiryMs) {
          this.contacts.delete(id);
          pruned++;
        }
      }
    }
    if (pruned > 0) {
      this.save();
      this.notify();
    }
    return pruned;
  }

  /** Update a contact's expiry in days (null = never expire). Returns false if contact not found. */
  setExpiry(contactId: string, days: number | null): boolean {
    const contact = this.contacts.get(contactId);
    if (!contact) return false;
    contact.expiryDays = days;
    this.save();
    this.notify();
    return true;
  }

  /**
   * Get expiry info for a contact.
   * Returns null if the contact doesn't exist.
   * Returns { expiresAt: null, daysRemaining: null } if the contact has no expiry set.
   */
  getExpiryInfo(contactId: string): { expiresAt: Date | null; daysRemaining: number | null } | null {
    const contact = this.contacts.get(contactId);
    if (!contact) return null;
    if (contact.expiryDays === null) {
      return { expiresAt: null, daysRemaining: null };
    }
    const lastActivity = contact.lastMatchedAt ?? contact.createdAt;
    const expiryMs = contact.expiryDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(lastActivity + expiryMs);
    const daysRemaining = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return { expiresAt, daysRemaining };
  }

  // ─── GDPR ──────────────────────────────────────────────────

  /** Export all voiceprints in portable format */
  export(): VoiceprintExport {
    return {
      exportedAt: new Date().toISOString(),
      version: VERSION,
      contacts: Array.from(this.contacts.values()).map(c => ({
        id: c.id,
        name: c.name,
        createdAt: new Date(c.createdAt).toISOString(),
        lastMatchedAt: c.lastMatchedAt ? new Date(c.lastMatchedAt).toISOString() : null,
        embeddingDim: c.embedding.length,
        embedding: c.embedding,
      })),
    };
  }

  /**
   * Import voiceprints from a File object (e.g. from a file input).
   * Reads the file as text, parses JSON, validates the shape, then calls import().
   */
  async importFromFile(file: File): Promise<{ imported: number; skipped: number; error?: string }> {
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      return { imported: 0, skipped: 0, error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { imported: 0, skipped: 0, error: 'Invalid JSON — file could not be parsed.' };
    }

    if (
      typeof data !== 'object' ||
      data === null ||
      !Array.isArray((data as Record<string, unknown>).contacts)
    ) {
      return { imported: 0, skipped: 0, error: 'Invalid format — expected an object with a "contacts" array.' };
    }

    const exportData = data as VoiceprintExport;
    const totalContacts = exportData.contacts.length;
    const imported = this.import(exportData);
    const skipped = totalContacts - imported;
    return { imported, skipped };
  }

  /** Import voiceprints from export (merges, doesn't overwrite) */
  import(data: VoiceprintExport): number {
    let imported = 0;
    for (const entry of data.contacts) {
      if (!this.contacts.has(entry.id)) {
        this.contacts.set(entry.id, {
          id: entry.id,
          name: entry.name,
          embedding: entry.embedding,
          createdAt: new Date(entry.createdAt).getTime(),
          lastMatchedAt: entry.lastMatchedAt ? new Date(entry.lastMatchedAt).getTime() : null,
          sampleDurationMs: 0,
          expiryDays: null,
        });
        imported++;
      }
    }
    if (imported > 0) {
      this.save();
      this.notify();
    }
    return imported;
  }

  // ─── Persistence (on-device only) ──────────────────────────

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data: SavedContact[] = JSON.parse(raw);
        this.contacts.clear();
        for (const c of data) {
          this.contacts.set(c.id, c);
        }
      }
    } catch {
      // Corrupted data — start fresh
    }
  }

  private save(): void {
    try {
      const data = Array.from(this.contacts.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      console.error('[ContactStore] Failed to save — localStorage full?');
    }
  }
}
