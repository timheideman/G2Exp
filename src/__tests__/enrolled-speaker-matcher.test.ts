/**
 * Tests for EnrolledSpeakerMatcher — the single speaker mechanism (match a chunk
 * to an enrolled voice, or cluster it as an unknown). Validated on real audio in
 * scripts (enrolled path is 100% correct at 1–3s windows); these pin the
 * decision logic deterministically with synthetic embeddings.
 */

import { describe, it, expect } from 'vitest';
import {
  EnrolledSpeakerMatcher,
  cosine,
  DEFAULT_ENROLLED_MATCHER,
} from '../server/enrolled-speaker-matcher';

// Distinct unit vectors as stand-in voices (low mutual cosine).
const TIM = [1, 0, 0, 0];
const JESSE = [0, 1, 0, 0];
const TIM_NOISY = [0.96, 0.12, 0.05, 0]; // ~same as Tim (cos≈0.99)
const STRANGER = [0, 0, 1, 0];

const enroll = (m: EnrolledSpeakerMatcher) =>
  m.setEnrolled([{ id: 'tim', name: 'Tim', embedding: TIM }, { id: 'jesse', name: 'Jesse', embedding: JESSE }]);

describe('cosine', () => {
  it('1 identical, 0 orthogonal', () => {
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});

describe('EnrolledSpeakerMatcher — enrolled matching', () => {
  it('matches a chunk to the nearest enrolled voice by name', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    const r = m.match(TIM_NOISY);
    expect(r.enrolled).toBe(true);
    expect(r.name).toBe('Tim');
    expect(r.speakerKey).toBe('tim');
    expect(r.confidence).toBeGreaterThan(DEFAULT_ENROLLED_MATCHER.acceptThreshold);
  });

  it('distinguishes two enrolled speakers', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    expect(m.match(TIM).name).toBe('Tim');
    expect(m.match(JESSE).name).toBe('Jesse');
  });

  it('a change of matched person between chunks IS the turn boundary', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    const keys = [TIM, TIM_NOISY, JESSE, TIM].map((e) => m.match(e).speakerKey);
    expect(keys).toEqual(['tim', 'tim', 'jesse', 'tim']); // boundaries where key changes
  });

  it('falls back to an unknown when nothing clears the accept threshold', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m); // Tim, Jesse — both orthogonal to STRANGER (cos 0)
    const r = m.match(STRANGER);
    expect(r.enrolled).toBe(false);
    expect(r.name).toBe('Speaker A');
    expect(r.speakerKey).toBe('unk:0');
  });
});

describe('EnrolledSpeakerMatcher — unknown clustering', () => {
  it('keeps one stranger as one stable label across chunks', () => {
    const m = new EnrolledSpeakerMatcher(); // nobody enrolled
    const a1 = m.match([0, 0, 1, 0]);
    const a2 = m.match([0, 0, 0.97, 0.1]); // ~same stranger (cos≈0.99)
    expect(a1.speakerKey).toBe('unk:0');
    expect(a2.speakerKey).toBe('unk:0'); // merged, not a new cluster
    expect(a2.name).toBe('Speaker A');
  });

  it('separates two different strangers into A and B', () => {
    const m = new EnrolledSpeakerMatcher();
    const a = m.match([0, 0, 1, 0]);
    const b = m.match([0, 0, 0, 1]); // orthogonal → different stranger
    expect(a.name).toBe('Speaker A');
    expect(b.name).toBe('Speaker B');
    expect(a.speakerKey).not.toBe(b.speakerKey);
  });

  it('enrolled voices take precedence over unknown clustering', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    m.match(STRANGER); // creates unk:0
    // Tim should still match Tim, not get absorbed into the unknown cluster.
    expect(m.match(TIM).name).toBe('Tim');
  });
});

describe('EnrolledSpeakerMatcher — matchVerbose (diagnostics)', () => {
  it('returns the same decision as match(), plus the full scoreboard', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    const v = m.matchVerbose(TIM_NOISY);
    // Decision identical to match().
    expect(v.name).toBe('Tim');
    expect(v.enrolled).toBe(true);
    expect(v.speakerKey).toBe('tim');
    // Scoreboard: every enrolled voice, highest first.
    expect(v.enrolledScores.map((s) => s.name)).toEqual(['Tim', 'Jesse']);
    expect(v.enrolledScores[0].sim).toBeGreaterThan(v.enrolledScores[1].sim);
  });

  it('computes the top-1↔top-2 margin', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m); // Tim=[1,0,0,0], Jesse=[0,1,0,0]
    const v = m.matchVerbose(TIM); // cos to Tim=1, to Jesse=0
    expect(v.topMargin).toBeCloseTo(1, 6);
  });

  it('reports an infinite margin when fewer than two voices are enrolled', () => {
    const m = new EnrolledSpeakerMatcher();
    m.setEnrolled([{ id: 'tim', name: 'Tim', embedding: TIM }]);
    expect(m.matchVerbose(TIM).topMargin).toBe(Infinity);
  });

  it('surfaces a knife-edge margin between two similar enrolled voices', () => {
    const m = new EnrolledSpeakerMatcher();
    // Two near-identical enrolled voices → a chunk close to both has a tiny margin.
    m.setEnrolled([
      { id: 'a', name: 'A', embedding: [1, 0, 0, 0] },
      { id: 'b', name: 'B', embedding: [0.99, 0.14, 0, 0] },
    ]);
    const v = m.matchVerbose([0.995, 0.07, 0, 0]);
    expect(v.enrolled).toBe(true);
    expect(v.topMargin).toBeLessThan(0.08); // would trip the low-margin flag
  });
});

describe('EnrolledSpeakerMatcher — lifecycle', () => {
  it('reset() forgets unknown clusters but keeps enrolled prints', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    m.match(STRANGER); // unk:0
    m.reset();
    expect(m.enrolledCount).toBe(2); // enrolled kept
    expect(m.match(STRANGER).speakerKey).toBe('unk:0'); // numbering restarts
  });

  it('setEnrolled replaces the enrolled set', () => {
    const m = new EnrolledSpeakerMatcher();
    enroll(m);
    expect(m.enrolledCount).toBe(2);
    m.setEnrolled([{ id: 'x', name: 'X', embedding: TIM }]);
    expect(m.enrolledCount).toBe(1);
    expect(m.match(TIM).name).toBe('X');
  });
});
