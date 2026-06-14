/**
 * Tests for the enrollment quality gate — accepts good recordings, rejects
 * too-short / mostly-silent / too-noisy ones with a user-facing reason.
 */

import { describe, it, expect } from 'vitest';
import { assessEnrollmentQuality } from '../server/enrollment-quality';

const SR = 16000;

function pcm(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s * 32767, true);
  }
  return out;
}

/** A speech-like signal: multiple harmonics with amplitude modulation. */
function speechLike(ms: number, amp = 0.4): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / SR); // 4Hz syllable rate
    out[i] = env * amp * (
      Math.sin((2 * Math.PI * 130 * i) / SR) +
      0.5 * Math.sin((2 * Math.PI * 260 * i) / SR) +
      0.3 * Math.sin((2 * Math.PI * 390 * i) / SR)
    ) / 1.8;
  }
  return out;
}

function silence(ms: number): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(i * 0.01) * 0.0005;
  return out;
}

describe('assessEnrollmentQuality', () => {
  it('accepts a clear, sufficiently long speech recording', () => {
    const res = assessEnrollmentQuality(pcm(speechLike(9000)));
    expect(res.ok).toBe(true);
    expect(res.voicedMs).toBeGreaterThan(6000);
    expect(res.voiced.length).toBeGreaterThan(0);
  });

  it('rejects a recording with too little speech', () => {
    const res = assessEnrollmentQuality(pcm(speechLike(2000)));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/enough speech|longer/i);
  });

  it('rejects a mostly-silent recording', () => {
    // 15s wall clock, but only ~1s of speech.
    const sig = new Float32Array(SR * 15);
    sig.set(silence(15000));
    sig.set(speechLike(1000), 0);
    const res = assessEnrollmentQuality(pcm(sig));
    expect(res.ok).toBe(false);
  });

  it('returns voiced-only audio shorter than the raw input', () => {
    const sig = new Float32Array(0);
    const padded = concatF(silence(3000), speechLike(8000), silence(3000));
    const res = assessEnrollmentQuality(pcm(padded));
    expect(res.ok).toBe(true);
    // Voiced audio should be substantially less than the 14s raw input.
    expect(res.voiced.length).toBeLessThan(pcm(padded).length);
    void sig;
  });

  it('respects a custom (lenient) config', () => {
    const res = assessEnrollmentQuality(pcm(speechLike(4500)), {
      minVoicedMs: 3000,
      minSnrDb: 6,
      minVoicedRatio: 0.1,
    });
    expect(res.ok).toBe(true);
  });
});

function concatF(...arrs: Float32Array[]): Float32Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
