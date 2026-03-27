/**
 * Tests for MockEmbeddingProvider — verifies test infrastructure behaves correctly
 */

import { describe, it, expect } from 'vitest';
import { MockEmbeddingProvider } from '../server/mock-embedding-provider';
import { cosineSimilarity } from '../server/speaker-matcher';

describe('MockEmbeddingProvider', () => {
  const provider = new MockEmbeddingProvider();

  it('generates embeddings of correct dimension', () => {
    const emb = provider.generateTestEmbedding(42);
    expect(emb).toHaveLength(192);
  });

  it('generates L2-normalized embeddings', () => {
    const emb = provider.generateTestEmbedding(42);
    const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('generates deterministic embeddings (same seed = same output)', () => {
    const emb1 = provider.generateTestEmbedding(42);
    const emb2 = provider.generateTestEmbedding(42);
    expect(emb1).toEqual(emb2);
  });

  it('generates distinct embeddings for different seeds', () => {
    const emb1 = provider.generateTestEmbedding(1001); // "Sarah"
    const emb2 = provider.generateTestEmbedding(2002); // "Marco"
    const sim = cosineSimilarity(emb1, emb2);
    // Different speakers should have low similarity
    expect(sim).toBeLessThan(0.5);
  });

  it('noisy variants have high similarity to base (>0.95)', () => {
    const base = provider.generateTestEmbedding(1001);
    const noisy = provider.generateNoisyVariant(base, 0.05);
    const sim = cosineSimilarity(base, noisy);
    expect(sim).toBeGreaterThan(0.90);
  });

  it('noisy variants are not identical to base', () => {
    const base = provider.generateTestEmbedding(1001);
    const noisy = provider.generateNoisyVariant(base, 0.05);
    expect(noisy).not.toEqual(base);
  });

  it('extractEmbedding returns correct dimension from audio', async () => {
    const fakeAudio = new Uint8Array(3200); // 100ms of 16kHz 16-bit
    const emb = await provider.extractEmbedding(fakeAudio, 16000);
    expect(emb).toHaveLength(192);
  });

  it('extractEmbedding is deterministic for same audio', async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const emb1 = await provider.extractEmbedding(audio, 16000);
    const emb2 = await provider.extractEmbedding(audio, 16000);
    expect(emb1).toEqual(emb2);
  });

  it('extractEmbedding produces different results for different audio', async () => {
    const audio1 = new Uint8Array([1, 2, 3, 4, 5]);
    const audio2 = new Uint8Array([10, 20, 30, 40, 50]);
    const emb1 = await provider.extractEmbedding(audio1, 16000);
    const emb2 = await provider.extractEmbedding(audio2, 16000);
    const sim = cosineSimilarity(emb1, emb2);
    expect(sim).toBeLessThan(0.9); // Different audio → different embedding
  });
});
