/**
 * Tests for TurnSegmenter — acoustic turn boundary detection.
 *
 * Built but NOT yet wired into the server: it's the fallback for when Deepgram's
 * streaming diarizer lags/merges speakers (measured to happen on real audio).
 * Thresholds were calibrated on real two-speaker recordings AFTER the fbank
 * scaling fix (see scripts/measure-voice-separation.mts). These tests pin the
 * decision logic with synthetic embeddings (no model needed).
 */

import { describe, it, expect } from 'vitest';
import { TurnSegmenter, cosine, DEFAULT_TURN_SEGMENTER } from '../server/turn-segmenter';

// Two clearly-distinct unit-ish vectors (low mutual cosine), plus a near-copy.
const VOICE_A = [1, 0, 0, 0];
const VOICE_B = [0, 1, 0, 0];
const A_NOISY = [0.95, 0.1, 0.05, 0]; // same speaker, slight variation (cos≈0.99 to A)

describe('cosine', () => {
  it('1 for identical, 0 for orthogonal', () => {
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});

describe('TurnSegmenter', () => {
  it('the first voice opens turn 0 with a boundary', () => {
    const s = new TurnSegmenter();
    const d = s.observe(VOICE_A);
    expect(d.effectiveSpeaker).toBe(0);
    expect(d.boundary).toBe(true);
    expect(d.similarity).toBeNull();
  });

  it('keeps the same turn while the voice stays similar', () => {
    const s = new TurnSegmenter();
    s.observe(VOICE_A);
    const d = s.observe(A_NOISY); // high cosine to A
    expect(d.boundary).toBe(false);
    expect(d.effectiveSpeaker).toBe(0);
  });

  it('opens a NEW turn when a clearly different voice arrives', () => {
    const s = new TurnSegmenter();
    s.observe(VOICE_A);          // turn 0
    const d = s.observe(VOICE_B); // cos(A,B)=0 < switchThreshold → new turn
    expect(d.boundary).toBe(true);
    expect(d.effectiveSpeaker).toBe(1);
  });

  it('keeps incrementing turn ids across alternating speakers', () => {
    const s = new TurnSegmenter();
    expect(s.observe(VOICE_A).effectiveSpeaker).toBe(0);
    expect(s.observe(VOICE_B).effectiveSpeaker).toBe(1);
    expect(s.observe(VOICE_A).effectiveSpeaker).toBe(2); // A again = a NEW turn
    expect(s.observe(VOICE_B).effectiveSpeaker).toBe(3);
  });

  it('holds the current turn in the hysteresis band (no spurious split)', () => {
    // similarity between switch (0.30) and stay (0.42) → ambiguous → hold.
    const s = new TurnSegmenter({ switchThreshold: 0.3, stayThreshold: 0.42 });
    s.observe([1, 0, 0, 0]);
    // Construct a vector at cosine ≈0.36 to the centroid (in the band).
    const band = [0.36, Math.sqrt(1 - 0.36 * 0.36), 0, 0];
    const sim = cosine(band, [1, 0, 0, 0]);
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.42);
    const d = s.observe(band);
    expect(d.boundary).toBe(false); // held, not split
    expect(d.effectiveSpeaker).toBe(0);
  });

  it('tracks a drifting voice via the centroid EMA (stays one turn)', () => {
    const s = new TurnSegmenter({ centroidAlpha: 0.5, stayThreshold: 0.5, switchThreshold: 0.3 });
    s.observe([1, 0, 0, 0]);
    // A sequence each highly similar to the running centroid keeps one turn,
    // even as the centroid migrates.
    for (const v of [[0.9, 0.2, 0, 0], [0.8, 0.4, 0, 0], [0.7, 0.5, 0, 0]]) {
      expect(s.observe(v).boundary).toBe(false);
    }
    expect(s.currentTurn).toBe(0);
  });

  it('reset() forgets all voice state', () => {
    const s = new TurnSegmenter();
    s.observe(VOICE_A);
    s.observe(VOICE_B);
    s.reset();
    const d = s.observe(VOICE_B); // first voice again → turn 0
    expect(d.effectiveSpeaker).toBe(0);
    expect(d.boundary).toBe(true);
  });

  it('exposes the calibrated default thresholds', () => {
    // Pin the real-data-derived defaults so a careless edit is caught.
    expect(DEFAULT_TURN_SEGMENTER.switchThreshold).toBeCloseTo(0.3, 5);
    expect(DEFAULT_TURN_SEGMENTER.stayThreshold).toBeCloseTo(0.42, 5);
  });
});
