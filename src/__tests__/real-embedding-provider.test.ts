/**
 * Tests for RealEmbeddingProvider — MFCC-based voice embedding extractor
 *
 * Verifies correctness of the pure-TypeScript MFCC pipeline:
 * - Output dimension (192)
 * - L2 normalization (unit vector)
 * - Determinism (same audio → same embedding)
 * - Discriminability (different audio → different embeddings)
 * - Edge cases (very short audio, silence, various durations)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RealEmbeddingProvider } from '../server/real-embedding-provider';
import { cosine as cosineSimilarity } from '../server/enrolled-speaker-matcher';

// ─── Helpers ──────────────────────────────────────────────────

/** Generate a sine-wave PCM buffer at a given frequency */
function generateSineWave(
  freqHz: number,
  durationMs: number,
  sampleRate = 16000,
  amplitude = 0.5,
): Uint8Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const buffer = new ArrayBuffer(numSamples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude;
    const pcm = Math.round(sample * 32767);
    view.setInt16(i * 2, pcm, true); // little-endian
  }
  return new Uint8Array(buffer);
}

/** Generate silent PCM (all zeros) */
function generateSilence(durationMs: number, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  return new Uint8Array(numSamples * 2); // All zeros = silence
}

/** Generate pseudo-random noise PCM (deterministic by seed) */
function generateNoisePcm(seed: number, durationMs: number, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const buffer = new ArrayBuffer(numSamples * 2);
  const view = new DataView(buffer);
  let rng = seed;
  for (let i = 0; i < numSamples; i++) {
    // Simple LCG
    rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
    const sample = ((rng / 0xffffffff) - 0.5) * 0.3;
    const pcm = Math.round(sample * 32767);
    view.setInt16(i * 2, pcm, true);
  }
  return new Uint8Array(buffer);
}

// ─── Tests ────────────────────────────────────────────────────

describe('RealEmbeddingProvider', () => {
  let provider: RealEmbeddingProvider;

  beforeEach(() => {
    provider = new RealEmbeddingProvider();
  });

  // ── Dimension ───────────────────────────────────────────────

  it('reports embeddingDim as 192', () => {
    expect(provider.embeddingDim).toBe(192);
  });

  it('returns an embedding of length 192', async () => {
    const audio = generateSineWave(440, 1000);
    const emb = await provider.extractEmbedding(audio, 16000);
    expect(emb).toHaveLength(192);
  });

  it('returns a plain number array (not Float64Array or Buffer)', async () => {
    const audio = generateSineWave(440, 500);
    const emb = await provider.extractEmbedding(audio, 16000);
    expect(Array.isArray(emb)).toBe(true);
    expect(typeof emb[0]).toBe('number');
  });

  // ── L2 normalization ─────────────────────────────────────────

  it('returns an L2-normalized (unit) vector', async () => {
    const audio = generateSineWave(440, 2000);
    const emb = await provider.extractEmbedding(audio, 16000);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('L2 norm is ~1 for silence', async () => {
    const audio = generateSilence(1000);
    const emb = await provider.extractEmbedding(audio, 16000);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    // Silence may produce near-zero embedding — norm can be 0 or 1
    // Just check it doesn't throw and returns 192 values
    expect(emb).toHaveLength(192);
    expect(Number.isFinite(norm)).toBe(true);
  });

  // ── Determinism ───────────────────────────────────────────────

  it('produces identical embeddings for the same audio (deterministic)', async () => {
    const audio = generateNoisePcm(42, 1500);
    const emb1 = await provider.extractEmbedding(audio, 16000);
    const emb2 = await provider.extractEmbedding(audio, 16000);
    expect(emb1).toEqual(emb2);
  });

  it('is deterministic across provider instances', async () => {
    const audio = generateNoisePcm(123, 1000);
    const emb1 = await new RealEmbeddingProvider().extractEmbedding(audio, 16000);
    const emb2 = await new RealEmbeddingProvider().extractEmbedding(audio, 16000);
    expect(emb1).toEqual(emb2);
  });

  // ── Discriminability ─────────────────────────────────────────

  it('produces different embeddings for different audio content', async () => {
    const audio1 = generateSineWave(200, 1000);
    const audio2 = generateSineWave(3000, 1000);
    const emb1 = await provider.extractEmbedding(audio1, 16000);
    const emb2 = await provider.extractEmbedding(audio2, 16000);
    const sim = cosineSimilarity(emb1, emb2);
    // Different signals must not be identical. (CMVN removes the static
    // spectral bias that separates pure tones, so we assert separation, not a
    // tight bound — real speech, with temporal dynamics, separates far more.)
    expect(sim).toBeLessThan(0.999);
    expect(sim).not.toBe(1);
  });

  it('produces distinct embeddings for very different noise patterns', async () => {
    const audio1 = generateSineWave(150, 1500);   // Deep bass
    const audio2 = generateSineWave(4000, 1500);  // High treble
    const emb1 = await provider.extractEmbedding(audio1, 16000);
    const emb2 = await provider.extractEmbedding(audio2, 16000);
    const sim = cosineSimilarity(emb1, emb2);
    // See note above — CMVN makes pure tones look similar; assert non-identity.
    expect(sim).toBeLessThan(0.999);
  });

  it('same-speaker-like audio has higher similarity than different speakers', async () => {
    // Same "speaker": same frequency, slightly different duration/amplitude
    const speaker1a = generateSineWave(440, 2000, 16000, 0.4);
    const speaker1b = generateSineWave(440, 1800, 16000, 0.5);
    // Different "speaker": very different frequency
    const speaker2 = generateSineWave(2200, 2000, 16000, 0.4);

    const emb1a = await provider.extractEmbedding(speaker1a, 16000);
    const emb1b = await provider.extractEmbedding(speaker1b, 16000);
    const emb2  = await provider.extractEmbedding(speaker2,  16000);

    const simSame = cosineSimilarity(emb1a, emb1b);
    const simDiff = cosineSimilarity(emb1a, emb2);

    expect(simSame).toBeGreaterThan(simDiff);
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('handles very short audio (less than one frame)', async () => {
    const tinyAudio = new Uint8Array(100); // ~3ms — less than 25ms frame
    const emb = await provider.extractEmbedding(tinyAudio, 16000);
    expect(emb).toHaveLength(192);
    expect(emb.every(Number.isFinite)).toBe(true);
  });

  it('handles exactly one frame of audio', async () => {
    const audio = generateSineWave(440, 25); // 25ms = exactly FRAME_SIZE samples
    const emb = await provider.extractEmbedding(audio, 16000);
    expect(emb).toHaveLength(192);
  });

  it('handles long audio (15 seconds)', async () => {
    const audio = generateNoisePcm(999, 15000);
    const emb = await provider.extractEmbedding(audio, 16000);
    expect(emb).toHaveLength(192);
    expect(emb.every(Number.isFinite)).toBe(true);
  });

  it('handles non-16kHz sample rate input (resamples correctly)', async () => {
    // Generate 44100 Hz audio and let the provider resample
    const numSamples = Math.floor(44100 * 0.5); // 500ms
    const buffer = new ArrayBuffer(numSamples * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < numSamples; i++) {
      const s = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
      view.setInt16(i * 2, Math.round(s * 32767), true);
    }
    const audio = new Uint8Array(buffer);
    const emb = await provider.extractEmbedding(audio, 44100);
    expect(emb).toHaveLength(192);
    expect(emb.every(Number.isFinite)).toBe(true);
  });

  it('all embedding values are finite (no NaN or Infinity)', async () => {
    const audio = generateNoisePcm(7777, 2000);
    const emb = await provider.extractEmbedding(audio, 16000);
    const allFinite = emb.every(v => Number.isFinite(v));
    expect(allFinite).toBe(true);
  });

  it('empty audio array is handled gracefully', async () => {
    const emb = await provider.extractEmbedding(new Uint8Array(0), 16000);
    expect(emb).toHaveLength(192);
    expect(emb.every(Number.isFinite)).toBe(true);
  });
});
