/**
 * Integration test — Full pipeline: enrollment → transcription → identification
 *
 * Simulates a complete conversation with 3 speakers:
 * - Sarah and Marco are enrolled (known)
 * - Unknown person is not enrolled
 *
 * Verifies the entire chain: voiceprint storage → audio buffering →
 * embedding extraction → matching → display rendering with names.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VoiceprintStore } from '../server/voiceprint-store';
import { SpeakerMatcher } from '../server/speaker-matcher';
import { MockEmbeddingProvider } from '../server/mock-embedding-provider';
import { TranscriptDisplay } from '../glass/transcript-display';
import type { Voiceprint } from '../types/speaker';

describe('Full Pipeline Integration', () => {
  let store: VoiceprintStore;
  let provider: MockEmbeddingProvider;
  let matcher: SpeakerMatcher;
  let display: TranscriptDisplay;

  const SARAH_SEED = 1001;
  const MARCO_SEED = 2002;
  const UNKNOWN_SEED = 9999;

  beforeEach(() => {
    store = new VoiceprintStore('/tmp/test-integration.json');
    store.clear();
    provider = new MockEmbeddingProvider();
    matcher = new SpeakerMatcher(store, provider, {
      matchThreshold: 0.82,
      minAudioMs: 3000,
      embeddingDim: 192,
    });
    display = new TranscriptDisplay();
  });

  it('end-to-end: enroll → transcribe → identify → display with names', async () => {
    // === PHASE 1: Enrollment (happens in companion phone UI) ===

    // Enroll Sarah
    const sarahEmbedding = provider.generateTestEmbedding(SARAH_SEED);
    const sarahVp: Voiceprint = {
      id: 'vp-sarah',
      name: 'Sarah',
      embedding: sarahEmbedding,
      createdAt: Date.now(),
      sampleDurationMs: 15000,
    };
    store.add(sarahVp);

    // Enroll Marco
    const marcoEmbedding = provider.generateTestEmbedding(MARCO_SEED);
    const marcoVp: Voiceprint = {
      id: 'vp-marco',
      name: 'Marco',
      embedding: marcoEmbedding,
      createdAt: Date.now(),
      sampleDurationMs: 12000,
    };
    store.add(marcoVp);

    expect(store.size).toBe(2);

    // === PHASE 2: Simulate conversation (Deepgram diarization) ===

    // Before identification, speakers show as letters
    display.addFinal(0, 'Hey everyone, shall we get started?');
    display.addFinal(1, 'Sure, I have the agenda ready.');
    display.addFinal(2, 'Sounds good to me.');

    let output = display.render();
    expect(output).toContain('[A]');
    expect(output).toContain('[B]');
    expect(output).toContain('[C]');

    // === PHASE 3: Speaker identification (runs in parallel) ===

    // Simulate matching speaker 0 → Sarah (noisy variant of her voiceprint)
    const speaker0Emb = provider.generateNoisyVariant(sarahEmbedding, 0.03);
    const match0 = matcher.findBestMatch(0, speaker0Emb, store.getAll());

    expect(match0.isIdentified).toBe(true);
    expect(match0.name).toBe('Sarah');
    expect(match0.confidence).toBeGreaterThan(0.9);

    // Simulate matching speaker 1 → Marco
    const speaker1Emb = provider.generateNoisyVariant(marcoEmbedding, 0.04);
    const match1 = matcher.findBestMatch(1, speaker1Emb, store.getAll());

    expect(match1.isIdentified).toBe(true);
    expect(match1.name).toBe('Marco');

    // Simulate matching speaker 2 → Unknown
    const speaker2Emb = provider.generateTestEmbedding(UNKNOWN_SEED);
    const match2 = matcher.findBestMatch(2, speaker2Emb, store.getAll());

    expect(match2.isIdentified).toBe(false);
    expect(match2.name).toMatch(/^Speaker [A-Z]$/);

    // === PHASE 4: Update display with identified names ===

    // In real app, display gets updated when matcher identifies a speaker
    display.renameSpeaker(0, match0.name);
    display.renameSpeaker(1, match1.name);
    // Speaker 2 keeps their letter label

    const speakers = display.getSpeakers();
    expect(speakers.find(s => s.index === 0)?.name).toBe('Sarah');
    expect(speakers.find(s => s.index === 1)?.name).toBe('Marco');

    // === PHASE 5: Conversation continues with names ===

    display.addFinal(0, 'Let me share the timeline.');
    display.addFinal(1, 'Great, that sounds like a solid plan.');
    display.updateInterim(2, 'I have a question about the bud');

    output = display.render();

    // Verify conversation flows correctly
    expect(output).toContain('Let me share the timeline');
    expect(output).toContain('Great, that sounds like a solid plan');
    expect(output).toContain('I have a question about the bud');
    expect(output).toContain('━'); // Interim cursor on unknown speaker's text
  });

  it('handles conversation with zero enrolled speakers', () => {
    // Nobody enrolled
    expect(store.size).toBe(0);

    display.addFinal(0, 'Who is speaking?');
    display.addFinal(1, 'Nobody knows.');

    const output = display.render();
    expect(output).toContain('[A] Who is speaking?');
    expect(output).toContain('[B] Nobody knows.');
  });

  it('handles rapid speaker alternation', () => {
    store.add({
      id: 'vp-sarah',
      name: 'Sarah',
      embedding: provider.generateTestEmbedding(SARAH_SEED),
      createdAt: Date.now(),
      sampleDurationMs: 15000,
    });

    // Quick back-and-forth
    display.addFinal(0, 'Yes?');
    display.addFinal(1, 'No.');
    display.addFinal(0, 'Really?');
    display.addFinal(1, 'Yes, really.');
    display.addFinal(0, 'OK.');

    const output = display.render();
    // Each speaker change should show a label
    const aMatches = output.match(/\[A\]/g);
    const bMatches = output.match(/\[B\]/g);
    expect(aMatches?.length).toBe(3); // 3 turns from speaker A
    expect(bMatches?.length).toBe(2); // 2 turns from speaker B
  });
});
