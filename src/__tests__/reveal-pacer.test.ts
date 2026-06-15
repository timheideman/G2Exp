/**
 * Tests for RevealPacer — word-at-a-time interim reveal pacing (glasses path).
 *
 * Pins the felt behavior: a burst of new interim words crawls in (~N per BLE
 * tick) instead of flashing, the leading word is never stalled, settled interim
 * never moves backwards, and a new interim run restarts the crawl. Crucially it
 * is interim-only — it never holds anything back once everything is revealed.
 */

import { describe, it, expect } from 'vitest';
import { RevealPacer } from '../glass/reveal-pacer';

describe('RevealPacer', () => {
  it('reveals the leading words of a fresh run immediately (no stall)', () => {
    let clock = 1000;
    const p = new RevealPacer(2, 300, () => clock);
    // 6 words arrive at once — the first tick shows up to wordsPerTick.
    expect(p.visibleCount(6)).toBe(2);
  });

  it('crawls at most wordsPerTick per interval', () => {
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);

    expect(p.visibleCount(8)).toBe(2); // t=0: leading 2
    expect(p.visibleCount(8)).toBe(2); // same tick (no time passed): no advance
    clock = 300;
    expect(p.visibleCount(8)).toBe(4); // +1 interval → +2
    clock = 600;
    expect(p.visibleCount(8)).toBe(6);
    clock = 900;
    expect(p.visibleCount(8)).toBe(8); // caught up
    clock = 1200;
    expect(p.visibleCount(8)).toBe(8); // stays full, never exceeds
  });

  it('once caught up, shows new words promptly without backwards motion', () => {
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);
    p.visibleCount(2); // shows 2, caught up
    clock = 300;
    expect(p.visibleCount(2)).toBe(2);
    // Interim grew by 1 (settled prefix unchanged) — caught-up path reveals it.
    expect(p.visibleCount(3)).toBe(3);
  });

  it('restarts the crawl when the interim shrinks (new run / superseded tail)', () => {
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);
    clock = 0; p.visibleCount(8);
    clock = 300; p.visibleCount(8); // revealed 4
    // A new, shorter interim run begins (e.g. a new turn) → restart from leading.
    clock = 600;
    expect(p.visibleCount(3)).toBe(2);
  });

  it('reports pending state accurately for the follow-up tick scheduler', () => {
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);
    p.visibleCount(5); // shows 2 of 5
    expect(p.hasPending()).toBe(true);
    clock = 300; p.visibleCount(5); // 4 of 5
    expect(p.hasPending()).toBe(true);
    clock = 600; p.visibleCount(5); // 5 of 5
    expect(p.hasPending()).toBe(false);
  });

  it('snapToFull reveals everything at once and clears pending', () => {
    const p = new RevealPacer(2, 300, () => 0);
    p.visibleCount(10); // 2 of 10
    expect(p.snapToFull(10)).toBe(10);
    expect(p.hasPending()).toBe(false);
  });

  it('empty interim shows nothing and is not pending', () => {
    const p = new RevealPacer(2, 300, () => 0);
    expect(p.visibleCount(0)).toBe(0);
    expect(p.hasPending()).toBe(false);
  });

  it('reset clears all run state', () => {
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);
    p.visibleCount(8);
    p.reset();
    clock = 50; // well within an interval of nothing
    expect(p.visibleCount(8)).toBe(2); // fresh leading reveal again
  });

  it('restarts the crawl cleanly after a final empties the interim (no stale clock)', () => {
    // Regression: a phrase finalizes (interim → 0), then the NEXT phrase's first
    // interim word must begin its own crawl — NOT inherit the previous phrase's
    // advance clock. Previously lastAdvanceAt survived the empty, so the new
    // phrase's pacing depended on how long the speaker paused.
    let clock = 0;
    const p = new RevealPacer(2, 300, () => clock);

    // Phrase 1 crawls and catches up.
    expect(p.visibleCount(3)).toBe(2);
    clock = 300;
    expect(p.visibleCount(3)).toBe(3); // caught up, lastAdvanceAt = 300

    // Final lands → interim cleared. The pacer sees 0 (engine cleared interim).
    clock = 305;
    expect(p.visibleCount(0)).toBe(0);

    // Phrase 2 begins almost immediately (short gap, < interval since the last
    // advance at t=300). It must STILL reveal its leading words — the run clock
    // was reset, so this is a brand-new run, not a mid-interval no-op.
    clock = 310;
    expect(p.visibleCount(5)).toBe(2);
    expect(p.hasPending()).toBe(true);
    // …and continue crawling on the next BLE tick.
    clock = 610;
    expect(p.visibleCount(5)).toBe(4);
  });
});
