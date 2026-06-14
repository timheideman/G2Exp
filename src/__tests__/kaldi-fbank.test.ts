/**
 * Tests for the Kaldi-compatible fbank frontend.
 *
 * We can't cross-check against torchaudio here, so these pin internal
 * correctness: shape, finiteness, snip_edges framing, CMN zero-mean, and that
 * different signals produce different features. The end-to-end correctness vs
 * the real model is enforced at runtime by OnnxEmbeddingProvider.selfCheck().
 */

import { describe, it, expect } from 'vitest';
import { computeFbank, FBANK_DIM } from '../server/kaldi-fbank';

const SR = 16000;

function tone(ms: number, freq: number, amp = 0.3): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('computeFbank', () => {
  it('produces 80-dim features per frame', () => {
    const feats = computeFbank(tone(500, 200), { cmn: false });
    expect(feats.length).toBeGreaterThan(0);
    expect(feats[0].length).toBe(FBANK_DIM);
    expect(FBANK_DIM).toBe(80);
  });

  it('uses snip_edges framing (1 + floor((N-400)/160))', () => {
    // 1 second = 16000 samples → 1 + floor((16000-400)/160) = 1 + 97 = 98
    const feats = computeFbank(tone(1000, 200), { cmn: false });
    expect(feats.length).toBe(98);
  });

  it('returns no frames for sub-frame-length input', () => {
    const feats = computeFbank(new Float32Array(100), { cmn: false });
    expect(feats.length).toBe(0);
  });

  it('produces only finite values', () => {
    const feats = computeFbank(tone(400, 300));
    for (const f of feats) for (const v of f) expect(Number.isFinite(v)).toBe(true);
  });

  it('CMN makes each mel bin zero-mean across frames', () => {
    const feats = computeFbank(tone(600, 250), { cmn: true });
    const T = feats.length;
    for (let m = 0; m < FBANK_DIM; m++) {
      let mean = 0;
      for (const f of feats) mean += f[m];
      mean /= T;
      expect(Math.abs(mean)).toBeLessThan(1e-4);
    }
  });

  it('different spectra yield different feature means', () => {
    const low = computeFbank(tone(600, 120), { cmn: false });
    const high = computeFbank(tone(600, 3000), { cmn: false });
    // Average over frames per bin, then compare — energy lands in different bins.
    const avg = (fs: Float32Array[]) => {
      const a = new Float64Array(FBANK_DIM);
      for (const f of fs) for (let m = 0; m < FBANK_DIM; m++) a[m] += f[m];
      return Array.from(a, (v) => v / fs.length);
    };
    const al = avg(low);
    const ah = avg(high);
    let diff = 0;
    for (let m = 0; m < FBANK_DIM; m++) diff += Math.abs(al[m] - ah[m]);
    expect(diff).toBeGreaterThan(1);
  });
});
