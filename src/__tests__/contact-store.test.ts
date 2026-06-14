/**
 * Tests for ContactStore — on-device voiceprint storage with privacy guarantees
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContactStore } from '../glass/contact-store';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

function makeEmbedding(seed: number): number[] {
  return Array(192).fill(0).map((_, i) => Math.sin(i * seed));
}

describe('ContactStore', () => {
  let store: ContactStore;

  beforeEach(() => {
    localStorageMock.clear();
    store = new ContactStore();
  });

  describe('CRUD', () => {
    it('starts empty', () => {
      expect(store.size).toBe(0);
      expect(store.getAll()).toEqual([]);
    });

    it('adds a contact with voiceprint', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      expect(contact.name).toBe('Sarah');
      expect(contact.embedding).toHaveLength(192);
      expect(contact.id).toMatch(/^contact-/);
      expect(store.size).toBe(1);
    });

    it('retrieves a contact by ID', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      const retrieved = store.get(contact.id);
      expect(retrieved?.name).toBe('Sarah');
    });

    it('renames a contact', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      expect(store.rename(contact.id, 'Sarah Connor')).toBe(true);
      expect(store.get(contact.id)?.name).toBe('Sarah Connor');
    });

    it('deletes a contact', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      expect(store.delete(contact.id)).toBe(true);
      expect(store.size).toBe(0);
      expect(store.get(contact.id)).toBeUndefined();
    });

    it('deletes all contacts', () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      store.add('Marco', makeEmbedding(2), 12000);
      store.deleteAll();
      expect(store.size).toBe(0);
    });

    it('finds by name case-insensitive', () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      expect(store.findByName('sarah')?.name).toBe('Sarah');
      expect(store.findByName('SARAH')?.name).toBe('Sarah');
      expect(store.findByName('unknown')).toBeUndefined();
    });

    it('records match timestamp', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      expect(contact.lastMatchedAt).toBeNull();
      store.recordMatch(contact.id);
      expect(store.get(contact.id)?.lastMatchedAt).toBeGreaterThan(0);
    });
  });

  describe('addOrMerge (multi-sample enrollment)', () => {
    it('creates a new contact when the name is new', () => {
      const c = store.addOrMerge('Sarah', makeEmbedding(1), 10000);
      expect(store.size).toBe(1);
      expect(c.sampleCount).toBe(1);
    });

    it('averages a second sample into an existing same-name contact', () => {
      store.addOrMerge('Sarah', makeEmbedding(1), 10000);
      const merged = store.addOrMerge('Sarah', makeEmbedding(2), 8000);
      // Still one contact, now with 2 samples and accumulated duration.
      expect(store.size).toBe(1);
      expect(merged.sampleCount).toBe(2);
      expect(merged.sampleDurationMs).toBe(18000);
    });

    it('keeps the merged embedding L2-normalized', () => {
      store.addOrMerge('Sarah', makeEmbedding(1), 10000);
      const merged = store.addOrMerge('Sarah', makeEmbedding(2), 10000);
      const norm = Math.sqrt(merged.embedding.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('merged embedding lies between the two input directions', () => {
      const e1 = makeEmbedding(1);
      const e2 = makeEmbedding(3);
      store.addOrMerge('Sarah', e1, 10000);
      const merged = store.addOrMerge('Sarah', e2, 10000).embedding;
      const cos = (a: number[], b: number[]) => {
        let d = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return d / (Math.sqrt(na) * Math.sqrt(nb));
      };
      // The centroid should be similar to both originals.
      expect(cos(merged, e1)).toBeGreaterThan(0.4);
      expect(cos(merged, e2)).toBeGreaterThan(0.4);
    });

    it('different names stay separate', () => {
      store.addOrMerge('Sarah', makeEmbedding(1), 10000);
      store.addOrMerge('Marco', makeEmbedding(2), 10000);
      expect(store.size).toBe(2);
    });
  });

  describe('persistence', () => {
    it('persists contacts to localStorage', () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      // Create new store instance — should load from localStorage
      const store2 = new ContactStore();
      expect(store2.size).toBe(1);
      expect(store2.getAll()[0].name).toBe('Sarah');
    });

    it('survives corrupted localStorage gracefully', () => {
      localStorageMock.setItem('livecaption_contacts', 'not valid json{{{');
      const store2 = new ContactStore();
      expect(store2.size).toBe(0); // Falls back to empty
    });
  });

  describe('expiry', () => {
    it('prunes expired contacts', () => {
      const contact = store.add('Old Contact', makeEmbedding(1), 15000, 30);
      // Manually set createdAt to 60 days ago
      const c = store.get(contact.id)!;
      c.createdAt = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const pruned = store.pruneExpired();
      expect(pruned).toBe(1);
      expect(store.size).toBe(0);
    });

    it('does not prune contacts without expiry', () => {
      store.add('Permanent', makeEmbedding(1), 15000); // No expiry
      const pruned = store.pruneExpired();
      expect(pruned).toBe(0);
      expect(store.size).toBe(1);
    });

    it('does not prune recently matched contacts', () => {
      const contact = store.add('Active', makeEmbedding(1), 15000, 30);
      store.recordMatch(contact.id); // Just matched
      const pruned = store.pruneExpired();
      expect(pruned).toBe(0);
      expect(store.size).toBe(1);
    });
  });

  describe('GDPR', () => {
    it('exports all contacts in portable format', () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      store.add('Marco', makeEmbedding(2), 12000);

      const exported = store.export();
      expect(exported.version).toBe('1.0.0');
      expect(exported.contacts).toHaveLength(2);
      expect(exported.contacts[0].name).toBe('Sarah');
      expect(exported.contacts[0].embeddingDim).toBe(192);
      expect(exported.exportedAt).toBeTruthy();
    });

    it('imports contacts from export without duplicates', () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      const exported = store.export();

      // Import into a fresh store
      localStorageMock.clear();
      const store2 = new ContactStore();
      const imported = store2.import(exported);
      expect(imported).toBe(1);
      expect(store2.size).toBe(1);

      // Import again — no duplicates
      const imported2 = store2.import(exported);
      expect(imported2).toBe(0);
      expect(store2.size).toBe(1);
    });

    it('notifies listeners on changes', () => {
      const listener = vi.fn();
      store.onChange(listener);

      store.add('Sarah', makeEmbedding(1), 15000);
      expect(listener).toHaveBeenCalledTimes(1);

      store.deleteAll();
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('setExpiry', () => {
    it('sets expiry days on an existing contact', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      expect(contact.expiryDays).toBeNull();

      const result = store.setExpiry(contact.id, 90);
      expect(result).toBe(true);
      expect(store.get(contact.id)?.expiryDays).toBe(90);
    });

    it('clears expiry when passed null', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000, 30);
      expect(store.get(contact.id)?.expiryDays).toBe(30);

      store.setExpiry(contact.id, null);
      expect(store.get(contact.id)?.expiryDays).toBeNull();
    });

    it('returns false for unknown contact ID', () => {
      const result = store.setExpiry('nonexistent-id', 30);
      expect(result).toBe(false);
    });

    it('notifies listeners when expiry is changed', () => {
      const listener = vi.fn();
      const contact = store.add('Sarah', makeEmbedding(1), 15000);
      store.onChange(listener);

      store.setExpiry(contact.id, 60);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getExpiryInfo', () => {
    it('returns null for unknown contact ID', () => {
      expect(store.getExpiryInfo('nonexistent-id')).toBeNull();
    });

    it('returns null expiresAt and daysRemaining for contacts with no expiry', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000); // no expiry
      const info = store.getExpiryInfo(contact.id);
      expect(info).not.toBeNull();
      expect(info?.expiresAt).toBeNull();
      expect(info?.daysRemaining).toBeNull();
    });

    it('returns future expiry date for a fresh contact', () => {
      const contact = store.add('Sarah', makeEmbedding(1), 15000, 30);
      const info = store.getExpiryInfo(contact.id);
      expect(info?.expiresAt).toBeInstanceOf(Date);
      expect(info?.daysRemaining).toBeGreaterThan(0);
      expect(info?.daysRemaining).toBeLessThanOrEqual(30);
    });

    it('returns negative daysRemaining for an expired contact', () => {
      const contact = store.add('Old', makeEmbedding(1), 15000, 30);
      // Manually back-date createdAt to 60 days ago
      const c = store.get(contact.id)!;
      c.createdAt = Date.now() - 60 * 24 * 60 * 60 * 1000;

      const info = store.getExpiryInfo(contact.id);
      expect(info?.daysRemaining).toBeLessThan(0);
    });

    it('uses lastMatchedAt as activity baseline when set', () => {
      const contact = store.add('Active', makeEmbedding(1), 15000, 30);
      // Back-date creation but set a recent match
      const c = store.get(contact.id)!;
      c.createdAt = Date.now() - 60 * 24 * 60 * 60 * 1000;
      c.lastMatchedAt = Date.now(); // matched just now

      const info = store.getExpiryInfo(contact.id);
      expect(info?.daysRemaining).toBeGreaterThan(0); // Not expired yet
    });
  });

  describe('importFromFile', () => {
    it('imports contacts from a valid JSON File', async () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      const exported = store.export();

      localStorageMock.clear();
      const store2 = new ContactStore();
      const blob = new Blob([JSON.stringify(exported)], { type: 'application/json' });
      const file = new File([blob], 'export.json', { type: 'application/json' });

      const result = await store2.importFromFile(file);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it('skips duplicate contacts', async () => {
      store.add('Sarah', makeEmbedding(1), 15000);
      const exported = store.export();

      // Import into the same store (already has Sarah)
      const blob = new Blob([JSON.stringify(exported)], { type: 'application/json' });
      const file = new File([blob], 'export.json', { type: 'application/json' });

      const result = await store.importFromFile(file);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('returns error for invalid JSON', async () => {
      const blob = new Blob(['not valid json{{{'], { type: 'application/json' });
      const file = new File([blob], 'bad.json', { type: 'application/json' });

      const result = await store.importFromFile(file);
      expect(result.imported).toBe(0);
      expect(result.error).toBeTruthy();
    });

    it('returns error when contacts array is missing', async () => {
      const bad = JSON.stringify({ version: '1.0.0', exportedAt: new Date().toISOString() });
      const blob = new Blob([bad], { type: 'application/json' });
      const file = new File([blob], 'bad.json', { type: 'application/json' });

      const result = await store.importFromFile(file);
      expect(result.imported).toBe(0);
      expect(result.error).toMatch(/contacts/);
    });
  });

  describe('auto-prune on construction', () => {
    it('prunes expired contacts when a new store is instantiated', () => {
      // Add a contact with a 30-day expiry, back-dated 60 days
      const contact = store.add('OldContact', makeEmbedding(1), 15000, 30);
      const c = store.get(contact.id)!;
      c.createdAt = Date.now() - 60 * 24 * 60 * 60 * 1000;
      // Manually persist the back-dated state
      (store as unknown as { save(): void }).save();

      // Load a fresh instance — should auto-prune
      const store2 = new ContactStore();
      expect(store2.size).toBe(0);
    });
  });
});
