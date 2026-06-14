/**
 * Enrollment quality gate.
 *
 * A voiceprint is trusted for months; one bad enrollment poisons every future
 * match. The old flow accepted any 15s blob. We now require a minimum amount of
 * *net* (voiced) speech and a reasonable SNR, and reject otherwise so the user
 * can re-record. Net-speech duration is the single largest enrollment-quality
 * lever (short utterances raise EER sharply).
 */

import { detectVoiced } from './vad';

export interface EnrollmentQualityConfig {
  /** Minimum NET (voiced) speech in ms required to enroll. */
  minVoicedMs: number;
  /** Minimum SNR (dB) — rejects enrollment recorded in heavy noise. */
  minSnrDb: number;
  /** Minimum fraction of the clip that is voiced (rejects mostly-silence). */
  minVoicedRatio: number;
}

export const DEFAULT_ENROLLMENT_QUALITY: EnrollmentQualityConfig = {
  minVoicedMs: 6000, // ~6s of actual speech (research target is higher; this is the floor)
  minSnrDb: 12,
  minVoicedRatio: 0.2,
};

export interface EnrollmentQualityResult {
  ok: boolean;
  /** Voiced-only PCM to actually embed (silence stripped). */
  voiced: Uint8Array;
  voicedMs: number;
  snrDb: number;
  /** User-facing reason when ok=false. */
  reason?: string;
}

/**
 * Run VAD over enrollment audio and decide whether it's good enough to enroll.
 * Returns the voiced-only audio to embed when ok, or a reason to reprompt.
 */
export function assessEnrollmentQuality(
  pcm: Uint8Array,
  config: Partial<EnrollmentQualityConfig> = {},
): EnrollmentQualityResult {
  const cfg = { ...DEFAULT_ENROLLMENT_QUALITY, ...config };
  const vad = detectVoiced(pcm);

  if (vad.voicedMs < cfg.minVoicedMs) {
    return {
      ok: false,
      voiced: vad.voiced,
      voicedMs: vad.voicedMs,
      snrDb: vad.snrDb,
      reason: `Not enough speech — please talk continuously for longer (got ${(vad.voicedMs / 1000).toFixed(1)}s of speech, need ${(cfg.minVoicedMs / 1000).toFixed(0)}s).`,
    };
  }

  if (vad.voicedRatio < cfg.minVoicedRatio) {
    return {
      ok: false,
      voiced: vad.voiced,
      voicedMs: vad.voicedMs,
      snrDb: vad.snrDb,
      reason: 'Too much silence — please speak more continuously while recording.',
    };
  }

  if (vad.snrDb < cfg.minSnrDb) {
    return {
      ok: false,
      voiced: vad.voiced,
      voicedMs: vad.voicedMs,
      snrDb: vad.snrDb,
      reason: 'Too noisy — please re-record somewhere quieter.',
    };
  }

  return { ok: true, voiced: vad.voiced, voicedMs: vad.voicedMs, snrDb: vad.snrDb };
}
