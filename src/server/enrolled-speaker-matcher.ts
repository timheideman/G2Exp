/**
 * EnrolledSpeakerMatcher — the single speaker mechanism: match a chunk of speech
 * to a known voice (or a clustered unknown), giving the TURN and the NAME at once.
 *
 * WHY THIS REPLACES THE OLD MACHINERY (TurnSegmenter + the resolver's online
 * centroids + global assignment + hysteresis): blind online diarization —
 * comparing two noisy short-window embeddings to *each other*, with drifting
 * centroids — is hard and was unreliable here. Measured on real audio, matching
 * a short chunk to a CLEAN ENROLLED voiceprint is easy and robust: 100% correct
 * attribution down to ~1s windows, correct-match cosine ~0.85 vs wrong ~0.25 —
 * a landslide, not a knife-edge. The stable reference is what makes it work.
 *
 * (NB: the older `speaker-matcher.ts` in this folder is a separate, superseded
 * design — keyed by Deepgram index, threshold 0.82, "identify once then never
 * recover". This file is the replacement; that one is dead and pending removal.)
 *
 * MODEL: every ~1-2s of one talker's voiced audio is embedded and handed here.
 *   1. Compare to each ENROLLED voiceprint (cosine). Best ≥ acceptThreshold →
 *      that person. The identity IS the turn — a change of matched person
 *      between consecutive chunks is a turn boundary.
 *   2. No enrolled match → compare to running UNKNOWN centroids (the only place
 *      we still cluster, and only for unenrolled voices). Match an existing one
 *      or spawn a new "Speaker A/B/C". Unknown centroids adapt slowly (EMA) so a
 *      stranger keeps one stable label across the conversation.
 *
 * The returned `speakerKey` is a stable per-identity id the app uses as the
 * speaker/turn id: enrolled → its voiceprint id; unknown → "unk:N".
 *
 * Pure + deterministic (no clock, no I/O) → unit-tested without a model.
 */

export interface MatcherVoiceprint {
  id: string;
  name: string;
  embedding: number[];
}

export interface EnrolledMatcherConfig {
  /**
   * Minimum cosine to accept an ENROLLED match. From real data, correct matches
   * sit ~0.8+ and wrong ones ~0.2-0.3, so this is deliberately forgiving. Below
   * it we treat the voice as unknown rather than risk a wrong name. (The old
   * 0.82 was far too strict — it would reject genuine matches.)
   */
  acceptThreshold: number;
  /**
   * Minimum cosine to fold a chunk into an existing UNKNOWN centroid ("same
   * stranger as before"). Below it the chunk starts a NEW unknown speaker.
   * Higher than acceptThreshold: matching two of-our-own (noisier) embeddings
   * needs more agreement than matching to a clean enrolled print.
   */
  unknownMergeThreshold: number;
  /** EMA weight for adapting an unknown centroid toward a newly-matched chunk. */
  unknownCentroidAlpha: number;
}

export const DEFAULT_ENROLLED_MATCHER: EnrolledMatcherConfig = {
  // Tuned on real audio (1.5s chunks): correct enrolled matches scored 0.61–0.76,
  // wrong ones ~0.2, so 0.45 cleanly accepts the right person and rejects others.
  acceptThreshold: 0.45,
  // 0.40 merges same-stranger chunks (which score ~0.55+ once a centroid forms)
  // while keeping cross-speaker (~0.18) apart. NB: blind unknown clustering is
  // inherently best-effort at short windows — it can briefly over-split at a
  // speaker transition. The ENROLLED path is the reliable one; this is a
  // graceful fallback for unenrolled voices, not a precision diarizer.
  unknownMergeThreshold: 0.4,
  unknownCentroidAlpha: 0.3,
};

export interface EnrolledMatchResult {
  /** Stable id for this identity: a voiceprint id (enrolled) or "unk:N". */
  speakerKey: string;
  /** Display name: the enrolled name, or "Speaker A/B/C" for unknowns. */
  name: string;
  /** True if matched to an enrolled voiceprint (vs a clustered unknown). */
  enrolled: boolean;
  /** Cosine to the chosen identity (enrolled voiceprint or unknown centroid). */
  confidence: number;
}

/** One enrolled voice's score for a chunk (diagnostics only). */
export interface EnrolledScore {
  id: string;
  name: string;
  sim: number;
}

/**
 * Diagnostics view of a single match: the chosen result PLUS the full enrolled
 * scoreboard and the top-1↔top-2 margin. Emitted only when verbose logging is
 * on; it is what lets us tune `acceptThreshold` from real data (is a wrong name
 * a knife-edge margin → threshold problem, or did the wrong voice genuinely
 * out-score the right one → embedding problem?) and spot near-misses that a
 * single confidence number hides.
 */
export interface VerboseMatchResult extends EnrolledMatchResult {
  /** Every enrolled voice's cosine to this chunk, highest first. */
  enrolledScores: EnrolledScore[];
  /**
   * Gap between the best and second-best ENROLLED cosine (Infinity if 0–1
   * enrolled). A small margin on an accepted match = a swap risk: the next noisy
   * chunk could flip to the runner-up.
   */
  topMargin: number;
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

const UNKNOWN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface UnknownSpeaker {
  key: string;     // "unk:N"
  letter: string;  // A, B, C…
  centroid: number[];
}

export class EnrolledSpeakerMatcher {
  private cfg: EnrolledMatcherConfig;
  private enrolled: MatcherVoiceprint[] = [];
  private unknowns: UnknownSpeaker[] = [];
  private nextUnknown = 0;

  constructor(config: Partial<EnrolledMatcherConfig> = {}) {
    this.cfg = { ...DEFAULT_ENROLLED_MATCHER, ...config };
  }

  setConfig(config: Partial<EnrolledMatcherConfig>): void {
    this.cfg = { ...this.cfg, ...config };
  }

  /** Replace the enrolled voiceprint set (on load_voiceprints). */
  setEnrolled(vps: MatcherVoiceprint[]): void {
    this.enrolled = vps.map((v) => ({ id: v.id, name: v.name, embedding: v.embedding }));
  }

  /** Forget unknown clusters (new session). Enrolled prints are kept. */
  reset(): void {
    this.unknowns = [];
    this.nextUnknown = 0;
  }

  get enrolledCount(): number {
    return this.enrolled.length;
  }

  /**
   * Attribute one chunk of voiced audio (its embedding) to a speaker — enrolled
   * by name, or a stable clustered unknown. A change of identity between
   * consecutive chunks is the turn boundary.
   */
  match(embedding: number[]): EnrolledMatchResult {
    // 1. Best enrolled match.
    let bestVp: MatcherVoiceprint | null = null;
    let bestSim = -Infinity;
    for (const vp of this.enrolled) {
      const sim = cosine(embedding, vp.embedding);
      if (sim > bestSim) { bestSim = sim; bestVp = vp; }
    }
    if (bestVp && bestSim >= this.cfg.acceptThreshold) {
      return { speakerKey: bestVp.id, name: bestVp.name, enrolled: true, confidence: bestSim };
    }

    // 2. No enrolled match → match/extend an unknown cluster.
    let bestUnk: UnknownSpeaker | null = null;
    let bestUnkSim = -Infinity;
    for (const u of this.unknowns) {
      const sim = cosine(embedding, u.centroid);
      if (sim > bestUnkSim) { bestUnkSim = sim; bestUnk = u; }
    }
    if (bestUnk && bestUnkSim >= this.cfg.unknownMergeThreshold) {
      this.foldUnknown(bestUnk, embedding);
      return { speakerKey: bestUnk.key, name: `Speaker ${bestUnk.letter}`, enrolled: false, confidence: bestUnkSim };
    }

    // 3. A new stranger.
    const letter = UNKNOWN_LETTERS[this.nextUnknown % UNKNOWN_LETTERS.length];
    const u: UnknownSpeaker = { key: `unk:${this.nextUnknown}`, letter, centroid: embedding.slice() };
    this.unknowns.push(u);
    this.nextUnknown++;
    return { speakerKey: u.key, name: `Speaker ${letter}`, enrolled: false, confidence: 1 };
  }

  /**
   * Like `match()`, but also returns the full enrolled scoreboard and top-1↔2
   * margin for diagnostics. The DECISION is delegated to `match()` so the two
   * can never diverge — this only adds visibility, never changes behavior.
   * (Note: `match()` mutates unknown clusters, so call this EXACTLY once per
   * chunk, in place of `match()`, never alongside it.)
   */
  matchVerbose(embedding: number[]): VerboseMatchResult {
    const enrolledScores: EnrolledScore[] = this.enrolled
      .map((vp) => ({ id: vp.id, name: vp.name, sim: cosine(embedding, vp.embedding) }))
      .sort((a, b) => b.sim - a.sim);
    const topMargin =
      enrolledScores.length >= 2 ? enrolledScores[0].sim - enrolledScores[1].sim : Infinity;
    const result = this.match(embedding);
    return { ...result, enrolledScores, topMargin };
  }

  private foldUnknown(u: UnknownSpeaker, embedding: number[]): void {
    const a = this.cfg.unknownCentroidAlpha;
    for (let i = 0; i < u.centroid.length; i++) {
      u.centroid[i] = u.centroid[i] * (1 - a) + embedding[i] * a;
    }
  }
}
