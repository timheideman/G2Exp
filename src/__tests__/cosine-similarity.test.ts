/**
 * Tests for cosine similarity — the core math behind voiceprint matching
 */

import { describe, it, expect } from 'vitest';
// cosineSimilarity was the helper exported by the (now-retired) speaker-matcher;
// the identical cosine math lives on the EnrolledSpeakerMatcher module. Aliased
// so these assertions keep testing the same function under its original name.
import { cosine as cosineSimilarity } from '../server/enrolled-speaker-matcher';

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.5, 0.3, -0.2, 0.8, 0.1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns high similarity for similar vectors with noise', () => {
    const a = [0.5, 0.3, -0.2, 0.8, 0.1, -0.4, 0.6, 0.2];
    const b = [0.52, 0.28, -0.18, 0.82, 0.09, -0.42, 0.58, 0.22]; // ~5% noise
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.99);
  });

  it('returns low similarity for different vectors', () => {
    const a = [0.5, 0.3, -0.2, 0.8, 0.1, -0.4, 0.6, 0.2];
    const b = [-0.1, 0.9, 0.4, -0.3, 0.7, 0.2, -0.5, 0.8]; // Very different
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
  });

  it('handles zero vectors gracefully', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles empty vectors gracefully', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('handles mismatched dimensions gracefully', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('is scale-invariant', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // Same direction, 2x magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});
