/**
 * MicAgc — automatic gain control for the mic→Deepgram audio branch.
 *
 * THE PROBLEM IT SOLVES: the G2 hands us raw 16-bit PCM with no gain control
 * (the SDK's audioControl() is on/off only). A person right across from the
 * wearer arrives loud and transcribes fine; a person across the room arrives
 * faint, Deepgram's internal VAD hears near-silence, and NOTHING is captioned.
 * That's the "I can only talk to people right in front of me" symptom. On the
 * laptop test path the browser's autoGainControl:true was silently lifting
 * quiet input — which is exactly why this never showed up off-device.
 *
 * WHY AGC AND NOT "GAIN" OR "NORMALIZE":
 *  - Fixed gain (×k) is static: a constant loud enough for the next room badly
 *    clips the person in front of you. One knob can't serve both distances.
 *  - Peak/RMS normalization is per-chunk and backward-looking: on a live stream
 *    you normalize tiny buffers independently, so the gain JUMPS between buffers
 *    (audible pumping) and one cough sets the scale for everything under it.
 *  - AGC keeps a level estimate that PERSISTS across buffers and moves the gain
 *    SMOOTHLY toward a target loudness (fast to back off, slow to ramp up). It's
 *    "continuous, smoothed, level-targeting normalization that's safe on a live
 *    stream" — which is what we actually want, and what autoGainControl did.
 *
 * KEY DESIGN CHOICES:
 *  - LIFT-ONLY. Gain is clamped to [1, maxGain]; we never attenuate. Near-field
 *    speech already transcribes — ducking it gains nothing and risks making a
 *    working case worse. We only ever raise quiet speech toward the floor DG
 *    needs. (A loud transient is handled by the limiter, not by ducking.)
 *  - SQUELCH. When the smoothed level is below a noise gate we FREEZE the gain
 *    ramp (hold, don't climb). Otherwise during true silence the AGC would crank
 *    to maxGain and amplify room hiss into something Deepgram may hallucinate
 *    words from. Speech opens the gate; room tone does not.
 *  - SOFT LIMITER on the output so that when we HAVE lifted gain, a sudden loud
 *    word rounds off against the ceiling (tanh knee) instead of hard-clipping.
 *
 * Applied ONLY to the copy of the PCM sent over the WebSocket to Deepgram. The
 * on-device wake-word detector is deliberately fed the RAW, untouched PCM so its
 * sensitivity tuning is unaffected (see app.ts).
 *
 * Pure + stateful + deterministic (sample-driven, no wall clock), so it unit
 * tests like RevealPacer / DisplayThrottle. process() is allocation-light: it
 * writes a fresh Uint8Array of the same length and mutates only internal scalars.
 */

export interface MicAgcOptions {
  /** Target RMS in normalized [0,1] units the AGC steers quiet speech toward. */
  targetRms: number;
  /** Hard ceiling on applied gain (prevents amplifying near-silence to hiss). */
  maxGain: number;
  /**
   * Per-buffer smoothing for the level estimate (0..1). Higher = the level
   * tracks faster (less smoothing). This is the envelope follower.
   */
  levelSmoothing: number;
  /**
   * How fast the applied gain rises toward the desired gain when we need MORE
   * gain (0..1 per buffer). Small = slow ramp-up (no pumping on quiet patches).
   */
  attack: number;
  /**
   * How fast the applied gain falls toward the desired gain when we need LESS
   * gain (0..1 per buffer). Larger than attack = back off quickly when speech
   * gets loud, so we don't sit over-amplified into a clip.
   */
  release: number;
  /**
   * Noise gate, in normalized RMS. Below this the input is treated as silence
   * and the gain ramp is frozen (held, not climbing). Speech sits well above a
   * typical room-tone floor, so this cleanly separates "lift this voice" from
   * "don't crank the hiss."
   */
  noiseGateRms: number;
}

/**
 * Tuned for 16 kHz speech from the G2 array. Conservative on ceiling (12×) and
 * slow on attack so the lift feels like the room mic "leaning in," not pumping.
 * Every value is overridable for on-device A/B (see app.ts ?agc / __agc()).
 */
export const DEFAULT_AGC: MicAgcOptions = {
  targetRms: 0.12, // ~ -18 dBFS — comfortably above Deepgram's VAD floor
  maxGain: 12, // up to ~+21 dB for a faint, distant talker
  levelSmoothing: 0.2,
  attack: 0.05, // ramp UP slowly (~tens of buffers) → no pumping
  release: 0.4, // back OFF fast when a loud word lands
  noiseGateRms: 0.004, // ~ -48 dBFS — room tone sits below this
};

export interface MicAgcStats {
  /** Smoothed input level (normalized RMS) of the last processed buffer. */
  level: number;
  /** Gain actually applied to the last buffer (after attack/release + clamp). */
  appliedGain: number;
  /** Whether the last buffer was below the noise gate (gain ramp frozen). */
  gated: boolean;
}

export class MicAgc {
  private o: MicAgcOptions;
  /** Smoothed envelope of the input level (normalized RMS). */
  private level = 0;
  /** Gain currently applied; ramps toward the desired gain via attack/release. */
  private gain = 1;
  private last: MicAgcStats = { level: 0, appliedGain: 1, gated: true };

  constructor(opts: Partial<MicAgcOptions> = {}) {
    this.o = { ...DEFAULT_AGC, ...opts };
  }

  /**
   * Apply AGC to one PCM buffer (16-bit signed LE, mono — the G2 format) and
   * return a NEW buffer of the same byte length. The input is not mutated, so
   * the caller can safely hand the original to other consumers (wake-word).
   */
  process(pcm: Uint8Array): Uint8Array {
    // Even byte length only; a stray odd byte (shouldn't happen) is passed through.
    const n = pcm.length >> 1;
    if (n === 0) {
      this.last = { level: this.level, appliedGain: this.gain, gated: true };
      return new Uint8Array(pcm); // copy, keep lift-only/no-alias contract
    }

    const inView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    // 1. Envelope: RMS of this buffer, smoothed into the running level.
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = inView.getInt16(i * 2, true) / 32768;
      sumSq += s * s;
    }
    const bufferRms = Math.sqrt(sumSq / n);
    this.level += this.o.levelSmoothing * (bufferRms - this.level);

    // 2. Desired gain to hit target — LIFT-ONLY, clamped to [1, maxGain].
    const gated = this.level < this.o.noiseGateRms;
    let desiredGain: number;
    if (gated) {
      // Below the gate: this is silence/room tone. HOLD the current gain (don't
      // climb toward maxGain on noise; don't snap to 1 either, which would
      // chatter the gain on every inter-word gap). Frozen = stable.
      desiredGain = this.gain;
    } else {
      const raw = this.o.targetRms / Math.max(this.level, 1e-9);
      desiredGain = Math.min(this.o.maxGain, Math.max(1, raw));
    }

    // 3. Move applied gain toward desired via asymmetric attack/release.
    //    Rising (need more) is slow; falling (need less) is fast.
    const coeff = desiredGain > this.gain ? this.o.attack : this.o.release;
    this.gain += coeff * (desiredGain - this.gain);

    // 4. Apply gain + soft limiter, write a fresh buffer.
    const out = new Uint8Array(pcm.length);
    const outView = new DataView(out.buffer);
    const g = this.gain;
    for (let i = 0; i < n; i++) {
      const s = inView.getInt16(i * 2, true) / 32768;
      outView.setInt16(i * 2, floatToPcm16(softLimit(s * g)), true);
    }
    // Preserve any trailing odd byte verbatim.
    if (pcm.length & 1) out[pcm.length - 1] = pcm[pcm.length - 1];

    this.last = { level: this.level, appliedGain: g, gated };
    return out;
  }

  /** Stats for the last processed buffer (for the ?agc on-device readout). */
  stats(): MicAgcStats {
    return this.last;
  }

  /** Reset envelope + gain (e.g. on pause/resume or session change). */
  reset(): void {
    this.level = 0;
    this.gain = 1;
    this.last = { level: 0, appliedGain: 1, gated: true };
  }
}

/**
 * Soft limiter: linear in the safe region, tanh knee near the ceiling, so a
 * lifted transient compresses smoothly instead of clipping to a square edge
 * (which adds harmonics Deepgram dislikes). Maps R→(-CEIL, CEIL), odd-symmetric.
 *
 * Below the knee (|x| ≤ KNEE) it's identity — most samples pay nothing. Above
 * it, the overshoot is squashed through tanh and re-seated on top of the knee,
 * asymptoting to CEIL (< 1.0) so even an arbitrarily loud transient lands just
 * BELOW full-scale — leaving headroom and never railing/wrapping the sample.
 */
const KNEE = 0.8;
const CEIL = 0.98; // asymptotic output ceiling — always a hair below clip
function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const over = a - KNEE;
  const squashed = KNEE + (CEIL - KNEE) * Math.tanh(over / (CEIL - KNEE));
  return x < 0 ? -squashed : squashed;
}

/** Normalized float (already limited to (-1,1)) → 16-bit signed sample. */
function floatToPcm16(s: number): number {
  // Defensive clamp (softLimit keeps us in range, but rounding could nudge it).
  const c = s < -1 ? -1 : s > 1 ? 1 : s;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}
