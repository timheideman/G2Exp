/**
 * Tests for SpeakerIdentityResolver — the robust index→name mapping layer.
 *
 * Synthetic embeddings: each identity is a distinct unit direction with a
 * little noise, so cosine separation mirrors real voiceprint behavior without
 * needing audio.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SpeakerIdentityResolver,
  cosine,
  type EnrolledVoiceprint,
} from '../server/speaker-identity-resolver';

const DIM = 32;

/** A deterministic unit vector "pointing" in a per-identity direction. */
function ident(seed: number, noise = 0): number[] {
  const v = new Array(DIM).fill(0).map((_, i) => {
    // smooth, seed-dependent pattern + tiny deterministic "noise"
    const base = Math.sin((i + 1) * (seed + 1) * 0.7);
    const n = noise * Math.sin((i + 7) * (seed + 3) * 1.9);
    return base + n;
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const VP = (id: string, name: string, seed: number): EnrolledVoiceprint => ({
  id,
  name,
  embedding: ident(seed),
});

describe('cosine', () => {
  it('is 1 for identical vectors and ~0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('SpeakerIdentityResolver', () => {
  let r: SpeakerIdentityResolver;
  const alice = VP('vp-alice', 'Alice', 0);
  const bob = VP('vp-bob', 'Bob', 1);

  beforeEach(() => {
    r = new SpeakerIdentityResolver({ commitEvidence: 0.3, decay: 1, switchMargin: 1 });
    r.setVoiceprints([alice, bob]);
  });

  it('assigns a name after enough consistent evidence', () => {
    let view = r.observe(0, ident(0, 0.02), 1);
    // one weak observation may not commit yet depending on thresholds
    view = r.observe(0, ident(0, 0.02), 1);
    view = r.observe(0, ident(0, 0.02), 1);
    const idx0 = view.find((v) => v.speakerIndex === 0)!;
    expect(idx0.shownName).toBe('Alice');
  });

  it('does not assign the same name to two indices', () => {
    // Both indices sound like Alice (diarization split one person in two).
    for (let i = 0; i < 4; i++) {
      r.observe(0, ident(0, 0.01), 1);
      r.observe(1, ident(0, 0.01), 1);
    }
    const view = r.current();
    const names = view.map((v) => v.shownName).filter(Boolean);
    // Alice can only be claimed once.
    expect(names.filter((n) => n === 'Alice').length).toBeLessThanOrEqual(1);
  });

  it('maps two distinct voices to two distinct names', () => {
    for (let i = 0; i < 4; i++) {
      r.observe(0, ident(0, 0.02), 1); // Alice
      r.observe(1, ident(1, 0.02), 1); // Bob
    }
    const view = r.current();
    expect(view.find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');
    expect(view.find((v) => v.speakerIndex === 1)!.shownName).toBe('Bob');
  });

  it('recovers when a speaker flips to a new Deepgram index', () => {
    // Decay is what lets an abandoned index's stale evidence fade — the
    // production setting. (The default-config beforeEach uses decay:1 to keep
    // other assertions deterministic; flip recovery specifically needs decay.)
    const rr = new SpeakerIdentityResolver({
      commitEvidence: 0.3,
      decay: 0.8,
      switchMargin: 1,
    });
    rr.setVoiceprints([alice, bob]);

    // Alice speaks as index 0 for a while.
    for (let i = 0; i < 6; i++) rr.observe(0, ident(0, 0.02), 1);
    expect(rr.current().find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');

    // Diarization flips Alice to a new index 2; her evidence accrues there
    // while index 0 (now silent) decays away.
    let view = rr.current();
    for (let i = 0; i < 12; i++) view = rr.observe(2, ident(0, 0.02), 1);

    // Alice must not be shown on two indices at once, and the live index wins.
    const names = view.map((v) => v.shownName);
    expect(names.filter((n) => n === 'Alice').length).toBe(1);
    expect(view.find((v) => v.speakerIndex === 2)!.shownName).toBe('Alice');
  });

  it('leaves an unknown voice unnamed rather than guessing', () => {
    // A voice unlike any enrolled voiceprint (different direction).
    for (let i = 0; i < 6; i++) r.observe(0, ident(7, 0.02), 1);
    const idx0 = r.current().find((v) => v.speakerIndex === 0)!;
    expect(idx0.shownName).toBeNull();
  });

  it('pools weak evidence over many segments to reach a confident name', () => {
    // Each segment is short/weak (low weight) but consistent.
    let view = r.current();
    for (let i = 0; i < 10; i++) view = r.observe(0, ident(0, 0.05), 0.4);
    expect(view.find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');
  });

  describe('display hysteresis', () => {
    it('does not flip the shown name on a single contradicting segment', () => {
      const rr = new SpeakerIdentityResolver({
        commitEvidence: 0.3,
        decay: 1,
        switchMargin: 3, // strong stickiness
      });
      rr.setVoiceprints([alice, bob]);

      // Establish Alice firmly on index 0.
      for (let i = 0; i < 8; i++) rr.observe(0, ident(0, 0.02), 1);
      expect(rr.current().find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');

      // One stray Bob-ish segment on the same index shouldn't flip the label.
      const view = rr.observe(0, ident(1, 0.02), 1);
      expect(view.find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');
    });
  });

  it('re-scores existing voices when voiceprints are loaded later', () => {
    const rr = new SpeakerIdentityResolver({ commitEvidence: 0.3, decay: 1, switchMargin: 1 });
    // No voiceprints yet — we still accumulate centroids.
    for (let i = 0; i < 5; i++) rr.observe(0, ident(0, 0.02), 1);
    expect(rr.current().find((v) => v.speakerIndex === 0)!.shownName).toBeNull();

    // Voiceprints arrive — the next observation should immediately identify.
    rr.setVoiceprints([alice, bob]);
    const view = rr.observe(0, ident(0, 0.02), 1);
    expect(view.find((v) => v.speakerIndex === 0)!.shownName).toBe('Alice');
  });

  it('reset clears all index state', () => {
    for (let i = 0; i < 5; i++) r.observe(0, ident(0, 0.02), 1);
    r.reset();
    expect(r.current()).toHaveLength(0);
  });

  it('reports a confidence in [0,1]', () => {
    for (let i = 0; i < 5; i++) r.observe(0, ident(0, 0.02), 1);
    const idx0 = r.current().find((v) => v.speakerIndex === 0)!;
    expect(idx0.confidence).toBeGreaterThanOrEqual(0);
    expect(idx0.confidence).toBeLessThanOrEqual(1);
  });
});
