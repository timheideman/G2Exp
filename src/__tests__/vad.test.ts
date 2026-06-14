/**
 * Tests for the energy VAD — verifies it isolates voiced regions and reports
 * sane quality metrics on synthetic signals.
 */

import { describe, it, expect } from 'vitest';
import { detectVoiced } from '../server/vad';

const SR = 16000;

/** Build 16-bit LE PCM from a float sample generator. */
function pcm(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s * 32767, true);
  }
  return out;
}

function silence(ms: number, amp = 0.0005): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  // a touch of low-level noise so it's realistic room tone
  for (let i = 0; i < n; i++) out[i] = (Math.sin(i * 0.013) * amp);
  return out;
}

function tone(ms: number, freq = 180, amp = 0.3): Float32Array {
  const n = (SR * ms) / 1000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function concat(...arrs: Float32Array[]): Float32Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

describe('detectVoiced', () => {
  it('keeps a strongly voiced region and reports high voiced ratio', () => {
    const sig = concat(silence(200), tone(600), silence(200));
    const res = detectVoiced(pcm(sig));
    // ~600ms of 1000ms is voiced (plus hangover) — well above the floor.
    expect(res.voicedRatio).toBeGreaterThan(0.4);
    expect(res.voicedMs).toBeGreaterThan(400);
  });

  it('strips near-silence so voiced output is much shorter than input', () => {
    const sig = concat(silence(800), tone(200), silence(800));
    const res = detectVoiced(pcm(sig));
    const inputMs = (sig.length / SR) * 1000;
    expect(res.voicedMs).toBeLessThan(inputMs * 0.5);
    expect(res.voiced.length).toBeLessThan(pcm(sig).length);
  });

  it('reports a positive SNR when speech is well above the floor', () => {
    const sig = concat(silence(200), tone(500, 200, 0.4), silence(200));
    const res = detectVoiced(pcm(sig));
    expect(res.snrDb).toBeGreaterThan(10);
  });

  it('reports a low voiced ratio for an all-silence clip', () => {
    const res = detectVoiced(pcm(silence(1000)));
    // With only room tone, almost nothing should clear the margin.
    expect(res.voicedRatio).toBeLessThan(0.3);
  });

  it('handles an empty/tiny buffer without throwing', () => {
    const res = detectVoiced(new Uint8Array(0));
    expect(res.voicedMs).toBe(0);
    expect(res.voicedRatio).toBe(0);
  });
});
