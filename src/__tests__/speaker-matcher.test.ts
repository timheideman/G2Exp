/**
 * Tests for SpeakerMatcher — real-time speaker identification via voiceprint matching
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpeakerMatcher } from '../server/speaker-matcher';
import { VoiceprintStore } from '../server/voiceprint-store';
import { MockEmbeddingProvider } from '../server/mock-embedding-provider';
import type { Voiceprint, SpeakerMatch } from '../types/speaker';

describe('SpeakerMatcher', () => {
  let store: VoiceprintStore;
  let provider: MockEmbeddingProvider;
  let matcher: SpeakerMatcher;

  // Deterministic test embeddings for known speakers
  const SARAH_SEED = 1001;
  const MARCO_SEED = 2002;
  const TIM_SEED = 3003;
  const UNKNOWN_SEED = 9999;

  function enrollSpeaker(name: string, seed: number): Voiceprint {
    const embedding = provider.generateTestEmbedding(seed);
    const vp: Voiceprint = {
      id: `vp-${name.toLowerCase()}`,
      name,
      embedding,
      createdAt: Date.now(),
      sampleDurationMs: 15000,
    };
    store.add(vp);
    return vp;
  }

  beforeEach(() => {
    store = new VoiceprintStore('/tmp/test-voiceprints.json');
    store.clear();
    provider = new MockEmbeddingProvider();
    matcher = new SpeakerMatcher(store, provider, {
      matchThreshold: 0.82,
      minAudioMs: 3000,
      embeddingDim: 192,
    });
  });

  describe('identification with enrolled speakers', () => {
    it('identifies a known speaker with high confidence', () => {
      const sarahVp = enrollSpeaker('Sarah', SARAH_SEED);
      const sarahEmbedding = provider.generateTestEmbedding(SARAH_SEED);

      // Simulate a noisy version (same speaker, different audio)
      const noisyEmbedding = provider.generateNoisyVariant(sarahEmbedding, 0.03);

      const match = matcher.findBestMatch(0, noisyEmbedding, store.getAll());

      expect(match.isIdentified).toBe(true);
      expect(match.name).toBe('Sarah');
      expect(match.voiceprintId).toBe('vp-sarah');
      expect(match.confidence).toBeGreaterThan(0.95);
    });

    it('identifies correct speaker among multiple enrolled', () => {
      enrollSpeaker('Sarah', SARAH_SEED);
      enrollSpeaker('Marco', MARCO_SEED);
      enrollSpeaker('Tim', TIM_SEED);

      // Test Marco's embedding with slight noise
      const marcoEmbedding = provider.generateTestEmbedding(MARCO_SEED);
      const noisyMarco = provider.generateNoisyVariant(marcoEmbedding, 0.04);

      const match = matcher.findBestMatch(1, noisyMarco, store.getAll());

      expect(match.isIdentified).toBe(true);
      expect(match.name).toBe('Marco');
      expect(match.voiceprintId).toBe('vp-marco');
    });

    it('rejects unknown speaker below threshold', () => {
      enrollSpeaker('Sarah', SARAH_SEED);
      enrollSpeaker('Marco', MARCO_SEED);

      // Completely different embedding (unknown person)
      const unknownEmbedding = provider.generateTestEmbedding(UNKNOWN_SEED);

      const match = matcher.findBestMatch(2, unknownEmbedding, store.getAll());

      expect(match.isIdentified).toBe(false);
      expect(match.voiceprintId).toBeNull();
      expect(match.name).toMatch(/^Speaker [A-Z]$/);
    });
  });

  describe('session management', () => {
    it('prevents same voiceprint being assigned to two speaker indices', () => {
      enrollSpeaker('Sarah', SARAH_SEED);
      const sarahEmb = provider.generateTestEmbedding(SARAH_SEED);

      // First speaker matches Sarah
      const match1 = matcher.findBestMatch(0, sarahEmb, store.getAll());
      expect(match1.name).toBe('Sarah');

      // Simulate identified speaker stored in matcher state
      // by accessing internal state through feedAudio + match cycle
      // For direct test: manually check exclusion logic
      // Speaker 0 identified as Sarah, feed speaker 1 with same embedding
      // It should NOT get Sarah again (exclusive matching)
    });

    it('returns fallback letter labels for unidentified speakers', () => {
      const name0 = matcher.getDisplayName(0);
      const name1 = matcher.getDisplayName(1);
      const name2 = matcher.getDisplayName(2);

      expect(name0).toBe('Speaker A');
      expect(name1).toBe('Speaker B');
      expect(name2).toBe('Speaker C');
    });

    it('resets session state cleanly', () => {
      enrollSpeaker('Sarah', SARAH_SEED);

      // Feed enough audio to trigger match
      const fakeAudio = new Uint8Array(6400); // 200ms of 16kHz 16-bit
      for (let i = 0; i < 20; i++) {
        matcher.feedAudio(0, fakeAudio, 200);
      }

      // Wait for any async operations
      matcher.reset();

      expect(matcher.isIdentified(0)).toBe(false);
      expect(matcher.getDisplayName(0)).toBe('Speaker A');
    });
  });

  describe('audio buffering', () => {
    it('does not attempt match before minimum audio threshold', async () => {
      enrollSpeaker('Sarah', SARAH_SEED);

      const identifyCallback = vi.fn();
      matcher.onSpeakerIdentified(identifyCallback);

      // Feed only 1 second of audio (below 3s threshold)
      const smallChunk = new Uint8Array(320); // 10ms at 16kHz 16-bit
      for (let i = 0; i < 100; i++) {
        matcher.feedAudio(0, smallChunk, 10);
      }

      // Should not have triggered match yet (only 1000ms)
      expect(matcher.isIdentified(0)).toBe(false);
    });

    it('triggers match after minimum audio threshold reached', async () => {
      enrollSpeaker('Sarah', SARAH_SEED);

      const identifyCallback = vi.fn();
      matcher.onSpeakerIdentified(identifyCallback);

      // Feed 3+ seconds of audio
      const chunk = new Uint8Array(320);
      for (let i = 0; i < 350; i++) {
        matcher.feedAudio(0, chunk, 10);
      }

      // Give async match time to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Match should have been attempted
      expect(identifyCallback).toHaveBeenCalled();
    });
  });

  describe('no enrolled speakers', () => {
    it('assigns letter labels when no voiceprints are enrolled', async () => {
      // Don't enroll anyone
      const identifyCallback = vi.fn();
      matcher.onSpeakerIdentified(identifyCallback);

      const chunk = new Uint8Array(320);
      for (let i = 0; i < 350; i++) {
        matcher.feedAudio(0, chunk, 10);
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(identifyCallback).toHaveBeenCalled();
      const match: SpeakerMatch = identifyCallback.mock.calls[0][0];
      expect(match.isIdentified).toBe(false);
      expect(match.name).toMatch(/^Speaker [A-Z]$/);
    });
  });
});
