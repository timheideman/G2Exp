/**
 * segment-homogeneity — reject acoustically MIXED audio before it reaches the
 * voiceprint matcher.
 *
 * THE PROBLEM IT SOLVES: Deepgram's *streaming* diarizer (the unimproved model;
 * the better one is batch-only) routinely lumps two similar voices in one room
 * under a single speaker index. When that happens, the per-index audio we
 * accumulate for embedding is a BLEND of two people. Embedding a blend gives a
 * vector sitting between both speakers, which then drifts close to whichever
 * enrolled voiceprint is nearest — the "speaker B is two people, then gets
 * matched to me" bug. No matcher-threshold tuning fixes this: the input is
 * already corrupted.
 *
 * THE DEFENSE: before trusting a segment as one speaker, test its acoustic
 * self-consistency. Split the voiced audio in half, embed each half, and compare
 * them. One speaker's two halves are highly similar; a segment that straddles a
 * speaker change (A…B) shows two distant halves. If the halves disagree beyond a
 * margin, the segment is mixed → DISCARD it (contribute no evidence) rather than
 * poison the voiceprint. Showing no name for a mixed patch is strictly better
 * than confidently showing the wrong one.
 *
 * When the halves agree, their mean IS the segment embedding (the resolver keeps
 * duration-weighted centroids, so the mean of two equal-length halves is the
 * right summary) — so an accepted segment costs exactly two embeds, not three.
 *
 * Pure (the embedder is injected) + deterministic → unit-tested without a model.
 */

/** Cosine similarity in [-1, 1]; 0 for empty/mismatched vectors. */
export function cosineSim(a: number[], b: number[]): number {
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

export interface HomogeneityResult {
  /** True if the segment looks like ONE speaker (safe to embed/match). */
  homogeneous: boolean;
  /** Cosine between the two half-embeddings (−1..1); null if not split-tested. */
  halfSimilarity: number | null;
  /**
   * The embedding to feed the resolver when homogeneous: the mean of the two
   * half-embeddings (≈ the whole-segment embedding). Null when rejected or
   * when the segment was too short to split (caller falls back to whole-embed).
   */
  embedding: number[] | null;
  /** Why it was/wasn't split-tested, for logging. */
  reason: 'mixed' | 'homogeneous' | 'too-short-to-split';
}

export interface HomogeneityOptions {
  /**
   * Minimum cosine between halves to accept the segment as one speaker. Tuned
   * conservatively: a real speaker-embedder puts same-speaker halves well above
   * this, and a genuine A↔B boundary well below it. Default 0.5.
   *
   * Calibrate per embedder on real two-speaker audio: set it between the
   * same-speaker floor and the cross-speaker ceiling you observe (?diag logs the
   * halfSimilarity of every segment so you can read those distributions live).
   */
  minHalfSimilarity: number;
  /**
   * Each half must contain at least this many PCM bytes (16kHz·16-bit ⇒
   * 2 bytes/sample, 32000 bytes ≈ 1s) to be worth embedding. Below this the
   * split is too noisy to judge, so we skip the test and accept the segment
   * (matching today's behavior for short segments). Default ≈ 600ms/half.
   */
  minHalfBytes: number;
}

export const DEFAULT_HOMOGENEITY: HomogeneityOptions = {
  minHalfSimilarity: 0.5,
  minHalfBytes: 600 * 2 * 16, // 600ms × 16 samples/ms × 2 bytes
};

/**
 * Assess whether `voicedPcm` (16kHz, 16-bit LE, mono — already VAD-trimmed) is
 * one speaker. Splits it in half, embeds each half via `extract`, compares.
 *
 * Returns `homogeneous: false` ⇒ the caller should DROP the segment (do not
 * call resolver.observe). Returns `homogeneous: true` with `embedding` set when
 * split-tested, or `embedding: null` + reason 'too-short-to-split' when the
 * caller should embed the whole segment itself (unchanged short-segment path).
 */
export async function assessSegmentHomogeneity(
  voicedPcm: Uint8Array,
  extract: (pcm: Uint8Array, sampleRate: number) => Promise<number[]>,
  opts: Partial<HomogeneityOptions> = {},
): Promise<HomogeneityResult> {
  const o = { ...DEFAULT_HOMOGENEITY, ...opts };

  // Split on an even byte boundary so neither half straddles a 16-bit sample.
  const mid = (voicedPcm.length >> 2) << 1; // half the samples, ×2 bytes, even
  const firstLen = mid;
  const secondLen = voicedPcm.length - mid;

  if (firstLen < o.minHalfBytes || secondLen < o.minHalfBytes) {
    return { homogeneous: true, halfSimilarity: null, embedding: null, reason: 'too-short-to-split' };
  }

  const first = voicedPcm.subarray(0, mid);
  const second = voicedPcm.subarray(mid);

  const [e1, e2] = await Promise.all([extract(first, 16000), extract(second, 16000)]);
  const sim = cosineSim(e1, e2);

  if (sim < o.minHalfSimilarity) {
    return { homogeneous: false, halfSimilarity: sim, embedding: null, reason: 'mixed' };
  }

  // Same speaker → the mean of the two halves summarizes the segment.
  const mean = new Array(e1.length);
  for (let i = 0; i < e1.length; i++) mean[i] = (e1[i] + e2[i]) / 2;
  return { homogeneous: true, halfSimilarity: sim, embedding: mean, reason: 'homogeneous' };
}
