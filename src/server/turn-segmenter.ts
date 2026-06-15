/**
 * TurnSegmenter — ACOUSTIC turn boundaries, independent of Deepgram's index.
 *
 * WHY: measured on real audio, Deepgram's *streaming* diarizer (a) merges two
 * overlapping voices onto one index entirely, and (b) on back-to-back turns lags
 * by a sentence or two — the new speaker's first words land under the previous
 * speaker's index and only get corrected later. Both make an interrupter's words
 * append to the wrong person's line. The provider can't fix this (its better
 * diarizer is batch-only), so we detect the boundary ourselves from the voice.
 *
 * HOW: we keep a running *centroid* embedding of the CURRENT turn's voice. For
 * each new chunk of speech (with its embedding) we compute cosine similarity to
 * that centroid:
 *   • similar (≥ stayThreshold)  → same speaker, extend the current turn; fold
 *     the embedding into the centroid (EMA) so it tracks the voice.
 *   • dissimilar (< switchThreshold) → a DIFFERENT voice → open a NEW turn with
 *     a fresh effective-speaker id; the centroid resets to this new voice.
 *   • in-between → ambiguous; hold the current turn (hysteresis band) to avoid
 *     flip-flopping on a noisy embedding.
 *
 * The output is an *effective speaker id* — a monotonic turn counter, NOT
 * Deepgram's index. The caption engine already splits turns on whatever speaker
 * id it's handed, so emitting a corrected id makes interruptions render as their
 * own tagged line with zero engine change. Naming (matching to enrolled
 * voiceprints) stays a separate, slower concern.
 *
 * This is the *fast* path: it judges on whatever voiced audio a transcript
 * carries (even ~0.5s), because a binary same/different decision tolerates a
 * noisier embedding than a 1-of-N identity match does. Pure + deterministic
 * (no clock, no I/O) → unit-tested without a model.
 */

export interface TurnSegmenterConfig {
  /**
   * Cosine ≥ this ⇒ definitely the same speaker (extend turn, update centroid).
   * ECAPA same-speaker similarity sits high; tuned against ?diag logs.
   */
  stayThreshold: number;
  /**
   * Cosine < this ⇒ definitely a different speaker (new turn). Below stay and
   * switch is a hysteresis band where we hold the current turn — prevents a
   * single noisy embedding from spuriously splitting a turn.
   */
  switchThreshold: number;
  /**
   * EMA weight for folding a same-speaker embedding into the running centroid
   * (0..1). Small = stable centroid (resists drift); large = adapts faster to
   * changing mic/voice conditions. The centroid is what each new chunk is
   * compared against, so this trades stability vs. adaptiveness.
   */
  centroidAlpha: number;
}

export const DEFAULT_TURN_SEGMENTER: TurnSegmenterConfig = {
  // Calibrated on REAL two-speaker recordings (scripts/measure-voice-separation
  // .mts) with the corrected fbank: on ≥1.5s windows, same-speaker cosine p10
  // ≈0.37 and cross-speaker p90 ≈0.25 — a clean ~0.11 gap. We split only on a
  // clear miss (switch=0.30, just above the cross-speaker mass) and treat the
  // band up to stay=0.42 as "hold current turn", so a single noisy window never
  // splits one person mid-sentence. Re-tune per deployment via SEGMENTER_* env
  // against the ?diag cosine logs. NOTE: discrimination needs ~1.5s of audio —
  // the caller must not feed sub-second windows (see MIN_TURN_EVAL_MS).
  stayThreshold: 0.42,
  switchThreshold: 0.3,
  centroidAlpha: 0.3,
};

export interface TurnDecision {
  /** Effective speaker id for this chunk — a turn counter, not a DG index. */
  effectiveSpeaker: number;
  /** True if this chunk opened a NEW turn (voice changed). */
  boundary: boolean;
  /** Cosine to the prior turn centroid (null for the very first chunk). */
  similarity: number | null;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

export class TurnSegmenter {
  private cfg: TurnSegmenterConfig;
  private centroid: number[] | null = null;
  /** Monotonic id for the current turn (the effective speaker). */
  private turnId = -1;

  constructor(config: Partial<TurnSegmenterConfig> = {}) {
    this.cfg = { ...DEFAULT_TURN_SEGMENTER, ...config };
  }

  setConfig(config: Partial<TurnSegmenterConfig>): void {
    this.cfg = { ...this.cfg, ...config };
  }

  /** Forget all voice state (new session). */
  reset(): void {
    this.centroid = null;
    this.turnId = -1;
  }

  /** The current effective-speaker id (turn counter); -1 before any audio. */
  get currentTurn(): number {
    return this.turnId;
  }

  /**
   * Decide whether `embedding` (one chunk of voiced audio) continues the current
   * turn or starts a new one, and return the effective speaker id to attribute
   * this chunk to. Updates internal state.
   */
  observe(embedding: number[]): TurnDecision {
    // First voice we've ever heard → turn 0, seed the centroid.
    if (this.centroid === null || this.turnId < 0) {
      this.turnId = Math.max(0, this.turnId + 1);
      this.centroid = embedding.slice();
      return { effectiveSpeaker: this.turnId, boundary: true, similarity: null };
    }

    const sim = cosine(embedding, this.centroid);

    if (sim < this.cfg.switchThreshold) {
      // Clearly a different voice → new turn; reset centroid to it.
      this.turnId += 1;
      this.centroid = embedding.slice();
      return { effectiveSpeaker: this.turnId, boundary: true, similarity: sim };
    }

    // Same speaker (≥ stay) OR ambiguous (hysteresis band): stay in this turn.
    // Only fold confidently-same embeddings into the centroid, so an ambiguous
    // chunk doesn't drag the voice model toward a possible interloper.
    if (sim >= this.cfg.stayThreshold) {
      this.foldIntoCentroid(embedding);
    }
    return { effectiveSpeaker: this.turnId, boundary: false, similarity: sim };
  }

  private foldIntoCentroid(embedding: number[]): void {
    const a = this.cfg.centroidAlpha;
    const c = this.centroid!;
    for (let i = 0; i < c.length; i++) c[i] = c[i] * (1 - a) + embedding[i] * a;
  }
}
