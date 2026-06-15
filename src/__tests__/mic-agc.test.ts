/**
 * Tests for MicAgc — automatic gain control on the mic→Deepgram branch.
 *
 * Pins the felt behavior that fixes "I can only talk to people right in front
 * of me": faint/distant speech is LIFTED toward a target loudness so Deepgram's
 * VAD hears it, near-field speech is NOT ducked, true silence is NOT cranked
 * into hiss, the lift ramps in smoothly (no per-buffer pumping), and a lifted
 * transient is limited rather than hard-clipped. The raw input is never mutated
 * (the wake-word detector still gets clean PCM).
 */

import { describe, it, expect } from 'vitest';
import { MicAgc, DEFAULT_AGC } from '../glass/mic-agc';

const SAMPLES = 320; // one 20ms frame at 16kHz — a realistic buffer granule

/** Build a 16-bit LE PCM buffer of a sine tone at a target normalized RMS. */
function tone(rms: number, samples = SAMPLES, freq = 220, sr = 16000): Uint8Array {
  // RMS of a full sine is amplitude/√2, so amplitude = rms·√2.
  const amp = rms * Math.SQRT2;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    const s = amp * Math.sin((2 * Math.PI * freq * i) / sr);
    const c = Math.max(-1, Math.min(1, s));
    view.setInt16(i * 2, c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff), true);
  }
  return pcm;
}

/** Deterministic pseudo-noise at a target RMS (no Math.random — repeatable). */
function noise(rms: number, samples = SAMPLES): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  let seed = 12345;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (seed / 0x7fffffff) * 2 - 1; // [-1,1]
    const s = r * rms * Math.SQRT2;
    const c = Math.max(-1, Math.min(1, s));
    view.setInt16(i * 2, c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff), true);
  }
  return pcm;
}

/** Measure the normalized RMS of a 16-bit LE PCM buffer. */
function rmsOf(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = pcm.length >> 1;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

/** Peak absolute normalized sample (for clip checks). */
function peakOf(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = pcm.length >> 1;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true) / 32768));
  return peak;
}

/** Feed the same buffer N times so the gain ramp converges, return the last out. */
function settle(agc: MicAgc, buf: Uint8Array, iters = 400): Uint8Array {
  let out = buf;
  for (let i = 0; i < iters; i++) out = agc.process(buf);
  return out;
}

describe('MicAgc', () => {
  it('lifts faint/distant speech toward the target RMS', () => {
    const agc = new MicAgc();
    // A faint talker across the room: well below target, above the noise gate.
    const faint = tone(0.02);
    expect(rmsOf(faint)).toBeLessThan(DEFAULT_AGC.targetRms);

    const out = settle(agc, faint);
    // Should be lifted close to the target (the whole point: cross DG's floor).
    expect(rmsOf(out)).toBeGreaterThan(0.09);
    expect(rmsOf(out)).toBeLessThanOrEqual(DEFAULT_AGC.targetRms + 0.02);
    expect(agc.stats().appliedGain).toBeGreaterThan(3); // genuinely boosted
  });

  it('does NOT duck near-field speech that is already loud (lift-only)', () => {
    const agc = new MicAgc();
    // Someone right in front: already at/above target.
    const loud = tone(0.25);
    const out = settle(agc, loud);
    // Gain floors at 1× — output RMS stays ~the input (no attenuation).
    expect(agc.stats().appliedGain).toBeCloseTo(1, 1);
    expect(rmsOf(out)).toBeGreaterThan(0.2);
  });

  it('freezes the gain on true silence instead of cranking room tone to hiss', () => {
    const agc = new MicAgc();
    // First, let it ramp up on a faint voice so gain is high…
    settle(agc, tone(0.02));
    const liftedGain = agc.stats().appliedGain;
    expect(liftedGain).toBeGreaterThan(3);

    // …now the talker stops and STAYS stopped: pure near-silence. The level
    // estimate is smoothed, so the gate engages once silence persists (a single
    // quiet buffer — an inter-word gap — deliberately does NOT gate). Feed
    // buffers until the envelope decays below the gate and gating latches.
    const silence = tone(0.001);
    expect(rmsOf(silence)).toBeLessThan(DEFAULT_AGC.noiseGateRms);
    let out = silence;
    for (let i = 0; i < 30 && !agc.stats().gated; i++) out = agc.process(silence);
    expect(agc.stats().gated).toBe(true);

    // The KEY invariant: once gated, gain is FROZEN. Pump many more silent
    // buffers and it must not drift toward maxGain (that's the "crank room tone
    // to hiss" failure) nor chatter back to 1×. It holds dead steady.
    const gatedGain = agc.stats().appliedGain;
    expect(gatedGain).toBeGreaterThan(1); // it IS holding a lift, not unity
    for (let i = 0; i < 200; i++) out = agc.process(silence);
    expect(agc.stats().appliedGain).toBeCloseTo(gatedGain, 6);
    expect(agc.stats().appliedGain).toBeLessThan(DEFAULT_AGC.maxGain); // never cranked to ceiling
    // And the boosted silence is still quiet (gate prevented a hiss explosion).
    expect(rmsOf(out)).toBeLessThan(0.05);
    void liftedGain; // (captured for narrative; the held-steady check is what matters)
  });

  it('treats low-level room noise as gated (does not chase it toward target)', () => {
    const agc = new MicAgc();
    const roomTone = noise(0.002); // below the gate
    settle(agc, roomTone);
    expect(agc.stats().gated).toBe(true);
    // Never ramped up: gain stays at unity because we started gated and held.
    expect(agc.stats().appliedGain).toBeCloseTo(1, 5);
  });

  it('ramps the lift in gradually rather than snapping (no pumping)', () => {
    const agc = new MicAgc();
    const faint = tone(0.02);

    const g1 = (agc.process(faint), agc.stats().appliedGain);
    const g2 = (agc.process(faint), agc.stats().appliedGain);
    const g3 = (agc.process(faint), agc.stats().appliedGain);

    // Monotonically rising, and the FIRST step is small (slow attack) — not an
    // instant jump to full gain (which is what causes audible pumping).
    expect(g1).toBeGreaterThanOrEqual(1);
    expect(g2).toBeGreaterThan(g1);
    expect(g3).toBeGreaterThan(g2);
    expect(g1).toBeLessThan(2); // nowhere near the eventual ~6× after one buffer
  });

  it('backs off faster than it ramps up (asymmetric attack/release)', () => {
    // Release should outrun attack: measure how far each moves the gain in one
    // buffer from the same starting distance to its target.
    const up = new MicAgc();
    up.process(tone(0.02)); // needs MORE gain → attack
    const attackStep = up.stats().appliedGain - 1;

    const down = new MicAgc();
    settle(down, tone(0.02)); // ramp gain high
    const before = down.stats().appliedGain;
    down.process(tone(0.5)); // now needs LESS gain → release
    const releaseStep = before - down.stats().appliedGain;

    expect(releaseStep).toBeGreaterThan(attackStep);
  });

  it('limits a lifted transient instead of hard-clipping it', () => {
    const agc = new MicAgc();
    // Ramp gain up on faint speech…
    settle(agc, tone(0.02));
    // …then a sudden loud word arrives before release catches up. Naive gain
    // would drive this way past full-scale; the soft limiter must keep it inside
    // [-1,1] AND round the knee (no railed square wave at exactly 1.0).
    const transient = tone(0.4);
    const out = agc.process(transient);

    const peak = peakOf(out);
    expect(peak).toBeLessThanOrEqual(1.0); // no overflow/wrap
    // Soft knee: shouldn't be pinned hard at full-scale across the buffer.
    expect(peak).toBeLessThan(0.999);
  });

  it('never mutates the input buffer (wake-word path keeps raw PCM)', () => {
    const agc = new MicAgc();
    settle(agc, tone(0.02)); // get gain well above 1×
    const faint = tone(0.02);
    const snapshot = Uint8Array.from(faint);
    const out = agc.process(faint);

    expect(faint).toEqual(snapshot); // input untouched
    expect(out).not.toBe(faint); // distinct buffer
    expect(rmsOf(out)).toBeGreaterThan(rmsOf(faint)); // and actually amplified
  });

  it('preserves byte length', () => {
    const agc = new MicAgc();
    const buf = tone(0.05, 256);
    expect(agc.process(buf).length).toBe(buf.length);
  });

  it('handles an empty buffer without throwing', () => {
    const agc = new MicAgc();
    const out = agc.process(new Uint8Array(0));
    expect(out.length).toBe(0);
    expect(agc.stats().gated).toBe(true);
  });

  it('reset() returns gain and level to unity/zero', () => {
    const agc = new MicAgc();
    settle(agc, tone(0.02));
    expect(agc.stats().appliedGain).toBeGreaterThan(1);
    agc.reset();
    expect(agc.stats().appliedGain).toBe(1);
    expect(agc.stats().level).toBe(0);
  });

  it('respects a custom maxGain ceiling', () => {
    const agc = new MicAgc({ maxGain: 2 });
    const out = settle(agc, tone(0.01)); // very faint → wants huge gain
    expect(agc.stats().appliedGain).toBeLessThanOrEqual(2 + 1e-6);
    // Capped, so it can't reach target — that's the honest tradeoff of a ceiling.
    expect(rmsOf(out)).toBeLessThan(DEFAULT_AGC.targetRms);
  });
});
