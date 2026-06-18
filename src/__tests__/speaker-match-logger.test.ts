/**
 * Tests for SpeakerMatchLogger — the on-device diagnostics recorder.
 *
 * The logger only records, but its swap / low-margin detection is load-bearing:
 * a logger that misses a real swap would send us chasing the wrong fix. These
 * pin the two failure signatures and the threshold-suggestion math with
 * synthetic verbose-match inputs (no model, injected clock).
 */

import { describe, it, expect } from 'vitest';
import { SpeakerMatchLogger } from '../server/speaker-match-logger';
import type { VerboseMatchResult } from '../server/enrolled-speaker-matcher';

/** Build a verbose match result for an ENROLLED hit. */
function enrolledHit(
  id: string,
  name: string,
  confidence: number,
  runnerUpSim = 0.2,
): VerboseMatchResult {
  return {
    speakerKey: id,
    name,
    enrolled: true,
    confidence,
    enrolledScores: [
      { id, name, sim: confidence },
      { id: `${id}-other`, name: `${name}-other`, sim: runnerUpSim },
    ],
    topMargin: confidence - runnerUpSim,
  };
}

/** Build a verbose match result for an UNKNOWN (rejected to cluster). */
function unknownHit(key: string, name: string, bestEnrolledSim: number): VerboseMatchResult {
  return {
    speakerKey: key,
    name,
    enrolled: false,
    confidence: 1,
    enrolledScores: bestEnrolledSim >= 0 ? [{ id: 'x', name: 'X', sim: bestEnrolledSim }] : [],
    topMargin: Infinity,
  };
}

// A monotonic injected clock.
function clock() {
  let t = 0;
  return () => (t += 1);
}

describe('SpeakerMatchLogger — swap detection', () => {
  it('flags when an enrolled identity moves to a different client id', () => {
    const log = new SpeakerMatchLogger({}, clock());
    // Tim first attributed to client 0…
    const r1 = log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    expect(r1.swap).toBe(false);
    // …then the SAME voiceprint id shows up under client 1 → swap.
    const r2 = log.record(enrolledHit('tim', 'Tim', 0.8), 1, 1, 1500);
    expect(r2.swap).toBe(true);
    expect(log.summary().swaps).toBe(1);
  });

  it('flags when one client id flips between two enrolled names', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    const r2 = log.record(enrolledHit('jesse', 'Jesse', 0.8), 0, 1, 1500); // same client 0, new name
    expect(r2.swap).toBe(true);
  });

  it('does NOT flag a stable enrolled identity staying on its client id', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    const r2 = log.record(enrolledHit('tim', 'Tim', 0.7), 0, 0, 1500);
    expect(r2.swap).toBe(false);
    expect(log.summary().swaps).toBe(0);
  });

  it('does NOT treat unknown-cluster churn as a swap (unknowns are best-effort)', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(unknownHit('unk:0', 'Speaker A', -1), 0, 0, 1500);
    const r2 = log.record(unknownHit('unk:0', 'Speaker A', -1), 1, 1, 1500);
    expect(r2.swap).toBe(false);
  });
});

describe('SpeakerMatchLogger — low-margin detection', () => {
  it('flags an accepted enrolled match whose top-1↔top-2 margin is razor-thin', () => {
    const log = new SpeakerMatchLogger({ lowMarginThreshold: 0.08 }, clock());
    // Confidence 0.6, runner-up 0.57 → margin 0.03 < 0.08.
    const r = log.record(enrolledHit('tim', 'Tim', 0.6, 0.57), 0, 0, 1500);
    expect(r.lowMargin).toBe(true);
    expect(log.summary().lowMarginAccepts).toBe(1);
  });

  it('does NOT flag a comfortable margin', () => {
    const log = new SpeakerMatchLogger({ lowMarginThreshold: 0.08 }, clock());
    const r = log.record(enrolledHit('tim', 'Tim', 0.8, 0.2), 0, 0, 1500); // margin 0.6
    expect(r.lowMargin).toBe(false);
  });

  it('never flags an unknown match as low-margin', () => {
    const log = new SpeakerMatchLogger({ lowMarginThreshold: 0.08 }, clock());
    const r = log.record(unknownHit('unk:0', 'Speaker A', 0.3), 0, 0, 1500);
    expect(r.lowMargin).toBe(false);
  });
});

describe('SpeakerMatchLogger — threshold suggestion', () => {
  it('suggests the midpoint when accepted and rejected cosine ranges separate cleanly', () => {
    const log = new SpeakerMatchLogger({}, clock());
    // Accepted enrolled around 0.7–0.8…
    log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    log.record(enrolledHit('tim', 'Tim', 0.7), 0, 0, 1500);
    // …rejected-to-unknown best-enrolled around 0.2–0.3.
    log.record(unknownHit('unk:0', 'Speaker A', 0.3), 1, 1, 1500);
    log.record(unknownHit('unk:0', 'Speaker A', 0.2), 1, 1, 1500);
    const s = log.summary();
    // midpoint of accepted.min (0.7) and rejected.max (0.3) = 0.5.
    expect(s.suggestedAcceptThreshold).toBeCloseTo(0.5, 6);
  });

  it('returns null when the ranges overlap (no clean split exists)', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(enrolledHit('tim', 'Tim', 0.4), 0, 0, 1500); // accepted but low
    log.record(unknownHit('unk:0', 'Speaker A', 0.5), 1, 1, 1500); // rejected but high
    expect(log.summary().suggestedAcceptThreshold).toBeNull();
  });
});

describe('SpeakerMatchLogger — bookkeeping', () => {
  it('tallies enrolled vs unknown and retains records', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    log.record(unknownHit('unk:0', 'Speaker A', 0.1), 1, 1, 1500);
    const s = log.summary();
    expect(s.totalMatches).toBe(2);
    expect(s.enrolledMatches).toBe(1);
    expect(s.unknownMatches).toBe(1);
    expect(log.getRecords()).toHaveLength(2);
  });

  it('bounds retained records to maxRecords (newest kept)', () => {
    const log = new SpeakerMatchLogger({ maxRecords: 3 }, clock());
    for (let i = 0; i < 10; i++) log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    expect(log.getRecords()).toHaveLength(3);
  });

  it('reset() clears records and swap-tracking state', () => {
    const log = new SpeakerMatchLogger({}, clock());
    log.record(enrolledHit('tim', 'Tim', 0.8), 0, 0, 1500);
    log.reset();
    expect(log.summary().totalMatches).toBe(0);
    // After reset, Tim re-appearing under a NEW client id is a fresh baseline,
    // not a swap (we forgot the prior attribution).
    const r = log.record(enrolledHit('tim', 'Tim', 0.8), 5, 0, 1500);
    expect(r.swap).toBe(false);
  });
});
