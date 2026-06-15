/**
 * Tests for segment-homogeneity — the mixed-speaker rejection guard that stops a
 * blended Deepgram index ("speaker B is two people") from poisoning a voiceprint.
 *
 * The embedder is injected, so we fake it deterministically: each half of the
 * PCM is tagged with a marker byte, and the mock returns a distinct unit vector
 * per marker. That lets us build "one speaker" (both halves same marker) and
 * "two speakers" (different markers) audio without a real model.
 */

import { describe, it, expect } from 'vitest';
import {
  assessSegmentHomogeneity,
  cosineSim,
  DEFAULT_HOMOGENEITY,
} from '../server/segment-homogeneity';

// One distinct (near-)orthogonal-ish embedding per speaker marker.
const VOICES: Record<number, number[]> = {
  1: [1, 0, 0, 0],
  2: [0, 1, 0, 0],
  3: [0.9, 0.1, 0, 0], // close to voice 1 (similar-sounding speaker)
};

/** Mock embedder: read the first byte of the PCM as the speaker marker. */
async function mockExtract(pcm: Uint8Array): Promise<number[]> {
  const marker = pcm.length > 0 ? pcm[0] : 0;
  return VOICES[marker] ?? [0, 0, 0, 1];
}

/** Build a PCM buffer of `bytes` length whose every byte is `marker`. */
function pcmOf(marker: number, bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(marker);
}

/** Concatenate two equal halves with different markers (a speaker change). */
function mixed(m1: number, m2: number, halfBytes: number): Uint8Array {
  const out = new Uint8Array(halfBytes * 2);
  out.fill(m1, 0, halfBytes);
  out.fill(m2, halfBytes);
  return out;
}

const BIG = DEFAULT_HOMOGENEITY.minHalfBytes * 2; // long enough to split

describe('cosineSim', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('is 0 for empty/mismatched length', () => {
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('assessSegmentHomogeneity', () => {
  it('accepts a single-speaker segment and returns the mean embedding', async () => {
    const audio = pcmOf(1, BIG); // both halves are voice 1
    const r = await assessSegmentHomogeneity(audio, mockExtract);
    expect(r.homogeneous).toBe(true);
    expect(r.reason).toBe('homogeneous');
    expect(r.halfSimilarity).toBeCloseTo(1, 6);
    expect(r.embedding).toEqual(VOICES[1]); // mean of two identical halves
  });

  it('REJECTS a segment that straddles a speaker change (the core bug)', async () => {
    const audio = mixed(1, 2, DEFAULT_HOMOGENEITY.minHalfBytes); // voice1 → voice2
    const r = await assessSegmentHomogeneity(audio, mockExtract);
    expect(r.homogeneous).toBe(false);
    expect(r.reason).toBe('mixed');
    expect(r.embedding).toBeNull(); // caller drops it → no voiceprint poisoning
    expect(r.halfSimilarity!).toBeLessThan(DEFAULT_HOMOGENEITY.minHalfSimilarity);
  });

  it('skips the split test for too-short segments (unchanged short path)', async () => {
    const audio = pcmOf(1, DEFAULT_HOMOGENEITY.minHalfBytes); // only ~one half
    const r = await assessSegmentHomogeneity(audio, mockExtract);
    expect(r.homogeneous).toBe(true);
    expect(r.reason).toBe('too-short-to-split');
    expect(r.embedding).toBeNull(); // signal: caller embeds the whole segment
    expect(r.halfSimilarity).toBeNull();
  });

  it('accepts two similar-but-same-context halves above the margin', async () => {
    // voice 1 vs voice 3 (cosine ≈ 0.994) — same speaker, slightly different take.
    const audio = mixed(1, 3, DEFAULT_HOMOGENEITY.minHalfBytes);
    const r = await assessSegmentHomogeneity(audio, mockExtract);
    expect(r.homogeneous).toBe(true);
    expect(r.halfSimilarity!).toBeGreaterThan(DEFAULT_HOMOGENEITY.minHalfSimilarity);
  });

  it('honors a custom minHalfSimilarity (stricter rejects more)', async () => {
    const audio = mixed(1, 3, DEFAULT_HOMOGENEITY.minHalfBytes); // sim ≈ 0.994
    // A threshold above their similarity now rejects this borderline pair.
    const r = await assessSegmentHomogeneity(audio, mockExtract, { minHalfSimilarity: 0.999 });
    expect(r.homogeneous).toBe(false);
    expect(r.reason).toBe('mixed');
  });

  it('splits on an even byte boundary (no half straddles a 16-bit sample)', async () => {
    // Odd byte length: mid must be even so each half is whole 16-bit samples.
    const audio = pcmOf(1, BIG + 1);
    const r = await assessSegmentHomogeneity(audio, mockExtract);
    // Still single-speaker; the point is it doesn't throw / misalign.
    expect(r.homogeneous).toBe(true);
  });
});
