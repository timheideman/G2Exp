/**
 * SpeakerIdentityResolver — robust Deepgram-index → known-name mapping.
 *
 * Deepgram streaming diarization gives anonymous, *session-local, best-effort*
 * speaker indices (0,1,2…). They are unstable: the same person can flip index,
 * two people can collapse onto one index, a new index can appear cold. The old
 * pipeline matched once, set `identified = true`, and permanently reserved the
 * voiceprint — so a single early mismatch (or an index flip) was unrecoverable.
 *
 * This resolver treats indices as *disposable tracks* and names as *assignments
 * that are re-derived every update*, never welded:
 *
 *  1. Per-index ONLINE CENTROID — a duration-weighted running-mean embedding,
 *     so the identity decision pools many short segments instead of betting on
 *     one noisy 3s clip (short utterances have far higher error).
 *
 *  2. Per-(index,identity) ACCUMULATED EVIDENCE — leaky-decayed sum of match
 *     scores. Robust to the occasional bad segment; grows with consistent
 *     agreement over time.
 *
 *  3. GLOBAL ASSIGNMENT re-run each update — a 1:1 matching between indices and
 *     identities (with an open-set UNKNOWN option) that maximizes total
 *     evidence. This is what gives us, for free:
 *       • no name used by two indices at once (1:1), decided by *global* best
 *         evidence rather than first-come;
 *       • automatic RE-assignment when a person's index flips (their evidence
 *         migrates and the next solve re-routes the name).
 *
 *  4. DISPLAY HYSTERESIS — the *committed* assignment can change freely, but
 *     the *shown* name only switches once the new name wins by a sticky margin,
 *     so the on-screen label never flickers between two candidates.
 *
 * Pure + deterministic (no I/O, no clock unless injected) → fully unit-tested.
 */

export interface EnrolledVoiceprint {
  id: string;
  name: string;
  embedding: number[];
}

export interface ResolverConfig {
  /**
   * Minimum calibrated score for a single observation to contribute evidence.
   * Below this the segment is treated as "no opinion" (avoids drifting toward
   * a name on noise). Cosine in [-1,1]; speech embeddings cluster well above 0.
   */
  acceptThreshold: number;
  /**
   * Minimum *total accumulated evidence* before an index may be assigned a
   * name at all. Higher = more conservative (favors leaving someone "Speaker
   * A" over risking a wrong name — a wrong name is worse than no name).
   */
  commitEvidence: number;
  /**
   * Hysteresis margin: a new candidate must beat the currently-shown name's
   * evidence by this factor before the display switches. 1 = no hysteresis.
   */
  switchMargin: number;
  /** Per-update multiplicative decay applied to old evidence (leaky integrator). */
  decay: number;
  /** EMA weight cap so a single long segment can't dominate the centroid. */
  maxCentroidWeight: number;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  acceptThreshold: 0.55,
  commitEvidence: 1.2,
  switchMargin: 1.25,
  decay: 0.9,
  maxCentroidWeight: 8,
};

/** What the resolver currently believes about one Deepgram index. */
export interface IndexIdentity {
  speakerIndex: number;
  /** Committed identity from the global solve (may differ from shown). */
  assignedVoiceprintId: string | null;
  assignedName: string | null;
  /** The name currently shown to the user (after hysteresis). */
  shownName: string | null;
  /** Confidence in the shown identity (normalized evidence share, 0..1). */
  confidence: number;
}

interface IndexState {
  centroid: number[] | null;
  centroidWeight: number;
  /** voiceprintId → accumulated evidence */
  evidence: Map<string, number>;
  shownVoiceprintId: string | null;
}

export class SpeakerIdentityResolver {
  private config: ResolverConfig;
  private voiceprints: EnrolledVoiceprint[] = [];
  private states = new Map<number, IndexState>();

  constructor(config: Partial<ResolverConfig> = {}) {
    this.config = { ...DEFAULT_RESOLVER_CONFIG, ...config };
  }

  setConfig(config: Partial<ResolverConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Replace the enrolled voiceprint set (e.g. on load_voiceprints). */
  setVoiceprints(vps: EnrolledVoiceprint[]): void {
    this.voiceprints = vps.map((v) => ({ id: v.id, name: v.name, embedding: v.embedding }));
    // New evidence basis — clear stale per-name evidence but keep centroids,
    // so we can immediately re-score the voices we've been hearing.
    for (const st of this.states.values()) st.evidence.clear();
  }

  /** Forget everything (new session). */
  reset(): void {
    this.states.clear();
  }

  /**
   * Observe a new embedding for a Deepgram index (one diarized segment).
   * Updates the index centroid + evidence, then re-runs the global assignment.
   * `weight` should scale with the voiced duration of the segment (seconds).
   * Returns the full, current identity map for all known indices.
   */
  observe(speakerIndex: number, embedding: number[], weight = 1): IndexIdentity[] {
    const st = this.stateFor(speakerIndex);

    // 1. Update online centroid (duration-weighted EMA, capped).
    this.updateCentroid(st, embedding, weight);

    // 2. Decay all evidence (leaky integrator) before adding the new evidence.
    this.decayAll();

    // 3. Score the *centroid* (more stable than the raw segment) against each
    //    voiceprint and add evidence for the ones above threshold.
    if (st.centroid) {
      for (const vp of this.voiceprints) {
        const score = cosine(st.centroid, vp.embedding);
        if (score >= this.config.acceptThreshold) {
          const add = (score - this.config.acceptThreshold) * weight;
          st.evidence.set(vp.id, (st.evidence.get(vp.id) ?? 0) + add);
        }
      }
    }

    // 4. Re-solve the global assignment and apply display hysteresis.
    return this.resolve();
  }

  /** Current identity view without observing anything new. */
  current(): IndexIdentity[] {
    return this.resolve();
  }

  // ─── internals ──────────────────────────────────────────────

  private stateFor(idx: number): IndexState {
    let st = this.states.get(idx);
    if (!st) {
      st = { centroid: null, centroidWeight: 0, evidence: new Map(), shownVoiceprintId: null };
      this.states.set(idx, st);
    }
    return st;
  }

  private updateCentroid(st: IndexState, embedding: number[], weight: number): void {
    if (!st.centroid) {
      st.centroid = embedding.slice();
      st.centroidWeight = weight;
      return;
    }
    // Weighted running mean, with the effective prior weight capped so the
    // centroid stays adaptive (recent voice/condition changes still move it).
    const prior = Math.min(st.centroidWeight, this.config.maxCentroidWeight);
    const total = prior + weight;
    for (let i = 0; i < st.centroid.length; i++) {
      st.centroid[i] = (st.centroid[i] * prior + embedding[i] * weight) / total;
    }
    st.centroidWeight = total;
  }

  private decayAll(): void {
    const d = this.config.decay;
    if (d >= 1) return;
    for (const st of this.states.values()) {
      for (const [id, ev] of st.evidence) {
        const next = ev * d;
        if (next < 1e-4) st.evidence.delete(id);
        else st.evidence.set(id, next);
      }
    }
  }

  /**
   * Global 1:1 assignment of indices → voiceprints maximizing total evidence,
   * with an open-set UNKNOWN option. We use a greedy max-weight matching over
   * (index, voiceprint) evidence pairs — exact enough for the handful of
   * speakers in a real conversation, and order-independent (sorted by weight).
   * Then apply per-index display hysteresis.
   */
  private resolve(): IndexIdentity[] {
    const indices = [...this.states.keys()].sort((a, b) => a - b);

    // Collect candidate (index, vpId, evidence) above the commit floor.
    const pairs: Array<{ idx: number; vpId: string; ev: number }> = [];
    for (const idx of indices) {
      const st = this.states.get(idx)!;
      for (const [vpId, ev] of st.evidence) {
        if (ev >= this.config.commitEvidence) pairs.push({ idx, vpId, ev });
      }
    }
    // Greedy: strongest evidence wins its (index, name) first; both get locked.
    pairs.sort((a, b) => b.ev - a.ev);
    const assignedIndex = new Map<number, string>(); // idx → vpId
    const usedVp = new Set<string>();
    for (const p of pairs) {
      if (assignedIndex.has(p.idx) || usedVp.has(p.vpId)) continue;
      assignedIndex.set(p.idx, p.vpId);
      usedVp.add(p.vpId);
    }

    // Reverse map: which index currently owns each voiceprint id.
    const ownerOf = new Map<string, number>();
    for (const [idx, vpId] of assignedIndex) ownerOf.set(vpId, idx);

    // Build the result with hysteresis on the *shown* name.
    const out: IndexIdentity[] = [];
    for (const idx of indices) {
      const st = this.states.get(idx)!;
      const assignedVp = assignedIndex.get(idx) ?? null;
      const assignedName = assignedVp ? this.nameOf(assignedVp) : null;

      // If our currently-shown name has been globally assigned to a DIFFERENT
      // index (the speaker flipped), we must give it up immediately — showing
      // a duplicate name is worse than briefly showing none.
      let shownVp = st.shownVoiceprintId;
      if (shownVp && ownerOf.get(shownVp) !== undefined && ownerOf.get(shownVp) !== idx) {
        shownVp = null;
      }

      // Display hysteresis: only switch the shown id if the newly-assigned id
      // beats the currently-shown id's evidence by the switch margin.
      if (assignedVp !== shownVp) {
        const newEv = assignedVp ? st.evidence.get(assignedVp) ?? 0 : 0;
        const shownEv = shownVp ? st.evidence.get(shownVp) ?? 0 : 0;
        if (shownVp === null || assignedVp === null || newEv >= shownEv * this.config.switchMargin) {
          shownVp = assignedVp;
        }
      }
      st.shownVoiceprintId = shownVp;

      const totalEv = sum(st.evidence.values());
      const shownEv = shownVp ? st.evidence.get(shownVp) ?? 0 : 0;
      const confidence = totalEv > 0 ? shownEv / totalEv : 0;

      out.push({
        speakerIndex: idx,
        assignedVoiceprintId: assignedVp,
        assignedName,
        shownName: shownVp ? this.nameOf(shownVp) : null,
        confidence,
      });
    }
    return out;
  }

  private nameOf(vpId: string): string | null {
    return this.voiceprints.find((v) => v.id === vpId)?.name ?? null;
  }
}

// ─── math helpers ──────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

function sum(it: Iterable<number>): number {
  let s = 0;
  for (const v of it) s += v;
  return s;
}
