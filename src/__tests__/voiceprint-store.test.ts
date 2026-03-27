/**
 * Tests for VoiceprintStore — CRUD operations for enrolled speaker voiceprints
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VoiceprintStore } from '../server/voiceprint-store';
import type { Voiceprint } from '../types/speaker';

function makeVoiceprint(name: string, id?: string): Voiceprint {
  return {
    id: id || `vp-${name.toLowerCase()}`,
    name,
    embedding: Array(192).fill(0).map((_, i) => Math.sin(i + name.length)),
    createdAt: Date.now(),
    sampleDurationMs: 15000,
  };
}

describe('VoiceprintStore', () => {
  let store: VoiceprintStore;

  beforeEach(() => {
    store = new VoiceprintStore('/tmp/test-voiceprints.json');
    store.clear();
  });

  it('starts empty', () => {
    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it('adds and retrieves a voiceprint', () => {
    const vp = makeVoiceprint('Sarah');
    store.add(vp);

    expect(store.size).toBe(1);
    expect(store.get('vp-sarah')).toEqual(vp);
  });

  it('updates an existing voiceprint with same ID', () => {
    const vp1 = makeVoiceprint('Sarah');
    store.add(vp1);

    const vp2 = { ...vp1, name: 'Sarah Connor' };
    store.add(vp2);

    expect(store.size).toBe(1);
    expect(store.get('vp-sarah')?.name).toBe('Sarah Connor');
  });

  it('stores multiple voiceprints', () => {
    store.add(makeVoiceprint('Sarah'));
    store.add(makeVoiceprint('Marco'));
    store.add(makeVoiceprint('Tim'));

    expect(store.size).toBe(3);
    expect(store.getAll().map(v => v.name).sort()).toEqual(['Marco', 'Sarah', 'Tim']);
  });

  it('removes a voiceprint by ID', () => {
    store.add(makeVoiceprint('Sarah'));
    store.add(makeVoiceprint('Marco'));

    expect(store.remove('vp-sarah')).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get('vp-sarah')).toBeUndefined();
    expect(store.get('vp-marco')).toBeDefined();
  });

  it('returns false when removing non-existent voiceprint', () => {
    expect(store.remove('non-existent')).toBe(false);
  });

  it('finds voiceprint by name (case-insensitive)', () => {
    const vp = makeVoiceprint('Sarah');
    store.add(vp);

    expect(store.findByName('sarah')).toEqual(vp);
    expect(store.findByName('SARAH')).toEqual(vp);
    expect(store.findByName('Sarah')).toEqual(vp);
  });

  it('returns undefined for unknown name', () => {
    store.add(makeVoiceprint('Sarah'));
    expect(store.findByName('Unknown')).toBeUndefined();
  });

  it('clears all voiceprints', () => {
    store.add(makeVoiceprint('Sarah'));
    store.add(makeVoiceprint('Marco'));
    store.clear();

    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
  });
});
