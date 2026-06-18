/**
 * SpeakerMatchLogger — turns an on-device speaker-ID session into hard data.
 *
 * The matcher (`EnrolledSpeakerMatcher`) is stateless per-chunk: every ~1.5s it
 * independently picks the best-cosine enrolled voice, with no memory of its last
 * decision and no constraint stopping two speakers from grabbing one name. That
 * is the suspected mechanism behind the "names swap mid-session" report — but it
 * was seen once and never quantified. Before tuning thresholds or adding a
 * stability layer, we MEASURE: feed every match here and read back, after a real
 * conversation, exactly what happened.
 *
 * It is pure + clock-injectable (no I/O) so it can be unit-tested, and it only
 * records — it never influences attribution.
 *
 * Two failure signatures it surfaces:
 *
 *  • SWAP — an already-seen enrolled identity (by voiceprint id) is observed
 *    under a DIFFERENT client id than before, or one client id flips between two
 *    enrolled names. Either means a person's label moved. This is the damaging
 *    failure ("wrong name shown").
 *
 *  • LOW-MARGIN accept — an enrolled match accepted with top-1↔top-2 cosine
 *    margin below `lowMarginThreshold`. Not a swap yet, but a knife-edge: the
 *    next noisy chunk could flip to the runner-up. These are the windows where a
 *    stability layer or a threshold tweak would bite.
 *
 * Also accumulates the cosine distributions (accepted-enrolled, rejected-best,
 * unknown) so `acceptThreshold` can be set from the real gap between right and
 * wrong matches instead of guessed.
 */

import type { VerboseMatchResult } from './enrolled-speaker-matcher';

export interface MatchLogConfig {
  /** A match whose top-1↔top-2 enrolled margin is below this is flagged low-margin. */
  lowMarginThreshold: number;
  /** Cap on retained per-match records (newest kept) to bound memory. */
  maxRecords: number;
}

export const DEFAULT_MATCH_LOG_CONFIG: MatchLogConfig = {
  // 0.08: with correct matches ~0.6–0.8 and wrong ~0.2, a sub-0.08 gap between
  // the top two enrolled voices means the matcher is nearly indifferent — a swap
  // waiting to happen. Tunable once real margins are in hand.
  lowMarginThreshold: 0.08,
  maxRecords: 2000,
};

/** One recorded match (what the matcher decided + why), for later read-out. */
export interface MatchRecord {
  t: number;
  /** Deepgram dominant index for the window (turn-detection signal). */
  dgIndex: number;
  /** Stable client id this chunk was attributed to. */
  clientId: number;
  speakerKey: string;
  name: string;
  enrolled: boolean;
  confidence: number;
  topMargin: number;
  /** Voiced ms in the matched window (thin windows are less trustworthy). */
  voicedMs: number;
  /** Top few enrolled scores "name:sim", highest first (for eyeballing). */
  top: string[];
  /** Flags computed at record time. */
  lowMargin: boolean;
  swap: boolean;
}

export interface MatchLogSummary {
  totalMatches: number;
  enrolledMatches: number;
  unknownMatches: number;
  swaps: number;
  lowMarginAccepts: number;
  /** Cosine stats for ACCEPTED enrolled matches (the right tail we want high). */
  acceptedEnrolled: Stats;
  /** Best-enrolled cosine on chunks that were REJECTED to unknown (want low). */
  rejectedBest: Stats;
  /** Suggested acceptThreshold: midpoint between rejected-best max and
   *  accepted-enrolled min when they're separated; null if they overlap. */
  suggestedAcceptThreshold: number | null;
  /** The flagged events, newest last. */
  swapEvents: MatchRecord[];
  lowMarginEvents: MatchRecord[];
}

interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
}

function stats(xs: number[]): Stats {
  if (xs.length === 0) return { n: 0, min: NaN, max: NaN, mean: NaN };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { n: xs.length, min, max, mean: sum / xs.length };
}

export class SpeakerMatchLogger {
  private cfg: MatchLogConfig;
  private now: () => number;
  private records: MatchRecord[] = [];
  /** voiceprint id → the client id it was last attributed to (swap detection). */
  private keyToClient = new Map<string, number>();
  /** client id → the enrolled name last shown for it (swap detection). */
  private clientToName = new Map<number, string>();

  // Running distributions (kept as arrays so we can compute a suggested
  // threshold; bounded by maxRecords via the same trim as `records`).
  private acceptedEnrolledSims: number[] = [];
  private rejectedBestSims: number[] = [];

  constructor(config: Partial<MatchLogConfig> = {}, now: () => number = Date.now) {
    this.cfg = { ...DEFAULT_MATCH_LOG_CONFIG, ...config };
    this.now = now;
  }

  /**
   * Record one match. `r` is the verbose matcher output for the chunk; `clientId`
   * is the stable id it was mapped to; `dgIndex`/`voicedMs` describe the window.
   * Returns the record (with swap/lowMargin flags) so the caller can log it live.
   */
  record(
    r: VerboseMatchResult,
    clientId: number,
    dgIndex: number,
    voicedMs: number,
  ): MatchRecord {
    // SWAP: this enrolled identity previously lived under a different client id,
    // OR this client id previously showed a different enrolled name. Only
    // enrolled identities can "swap" meaningfully (unknowns are best-effort).
    let swap = false;
    if (r.enrolled) {
      const prevClient = this.keyToClient.get(r.speakerKey);
      if (prevClient !== undefined && prevClient !== clientId) swap = true;
      const prevName = this.clientToName.get(clientId);
      if (prevName !== undefined && prevName !== r.name) swap = true;
      this.keyToClient.set(r.speakerKey, clientId);
      this.clientToName.set(clientId, r.name);

      if (r.topMargin < this.cfg.lowMarginThreshold) {
        // recorded below via `lowMargin`
      }
      this.acceptedEnrolledSims.push(r.confidence);
    } else if (r.enrolledScores.length > 0) {
      // Rejected to unknown despite having enrolled voices to compare against:
      // the best enrolled cosine is the "near miss" distribution.
      this.rejectedBestSims.push(r.enrolledScores[0].sim);
    }

    const lowMargin = r.enrolled && r.topMargin < this.cfg.lowMarginThreshold;

    const rec: MatchRecord = {
      t: this.now(),
      dgIndex,
      clientId,
      speakerKey: r.speakerKey,
      name: r.name,
      enrolled: r.enrolled,
      confidence: r.confidence,
      topMargin: r.topMargin,
      voicedMs,
      top: r.enrolledScores.slice(0, 3).map((s) => `${s.name}:${s.sim.toFixed(2)}`),
      lowMargin,
      swap,
    };

    this.records.push(rec);
    this.trim();
    return rec;
  }

  /** Aggregate everything seen so far into a read-out. */
  summary(): MatchLogSummary {
    const swapEvents = this.records.filter((r) => r.swap);
    const lowMarginEvents = this.records.filter((r) => r.lowMargin);
    const enrolledMatches = this.records.filter((r) => r.enrolled).length;

    const accepted = stats(this.acceptedEnrolledSims);
    const rejected = stats(this.rejectedBestSims);
    // A clean, tunable threshold exists only if the worst accepted match still
    // out-scores the best rejected one; then the midpoint separates them.
    const suggested =
      accepted.n > 0 && rejected.n > 0 && accepted.min > rejected.max
        ? (accepted.min + rejected.max) / 2
        : null;

    return {
      totalMatches: this.records.length,
      enrolledMatches,
      unknownMatches: this.records.length - enrolledMatches,
      swaps: swapEvents.length,
      lowMarginAccepts: lowMarginEvents.length,
      acceptedEnrolled: accepted,
      rejectedBest: rejected,
      suggestedAcceptThreshold: suggested,
      swapEvents,
      lowMarginEvents,
    };
  }

  /** All retained records (newest last) — for a full dump / export. */
  getRecords(): readonly MatchRecord[] {
    return this.records;
  }

  /** Forget everything (new session). */
  reset(): void {
    this.records = [];
    this.keyToClient.clear();
    this.clientToName.clear();
    this.acceptedEnrolledSims = [];
    this.rejectedBestSims = [];
  }

  private trim(): void {
    if (this.records.length > this.cfg.maxRecords) {
      this.records = this.records.slice(-this.cfg.maxRecords);
    }
  }
}
