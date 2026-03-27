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
});
