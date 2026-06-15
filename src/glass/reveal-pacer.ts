/**
 * RevealPacer — word-at-a-time reveal pacing for the glasses interim tail.
 *
 * On the real G2 the display can only refresh ~3×/sec (BLE ceiling). When a
 * burst of interim words arrives between refreshes, they all appear in one
 * repaint — the "words suddenly flash into view" Tim flagged. We can't refresh
 * faster, but we CAN reveal fewer new words per refresh so growth feels like a
 * steady crawl instead of a clump.
 *
 * The pacer caps how far the visible cutoff into the interim tail advances per
 * reveal interval. It is STRICTLY for interim (still-being-recognized) text:
 *
 *  - It never holds back finalized words. Finalized text is committed by the
 *    engine (interim is cleared on a final), so when a final lands the interim
 *    count drops to 0 and there is nothing to pace — the final shows in full,
 *    immediately. The caller passes only the interim word count here.
 *  - It only ever advances (never hides a word it already revealed within the
 *    same interim run), so settled interim text doesn't flicker backwards.
 *  - When the interim shrinks or resets (new turn, or the tail was superseded),
 *    the cutoff resets so the next interim run starts its own crawl.
 *
 * Pure + clock-injectable so it's deterministic under test, mirroring
 * DisplayThrottle.
 */
export class RevealPacer {
  private wordsPerTick: number;
  private intervalMs: number;
  private now: () => number;

  /** Words of the current interim run already revealed. */
  private revealed = 0;
  /** The interim length we last saw, to detect shrink/reset. */
  private lastInterimLen = 0;
  private lastAdvanceAt = -Infinity;

  constructor(
    wordsPerTick = 2,
    intervalMs = 300,
    now: () => number = Date.now,
  ) {
    this.wordsPerTick = wordsPerTick;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /**
   * Given the full interim word count for the active turn, return how many of
   * those words should currently be visible. Call once per render of the
   * glasses string.
   */
  visibleCount(interimLen: number): number {
    // Interim reset or shrank (new turn, or tail superseded by a shorter
    // hypothesis) — restart the crawl for the new run.
    if (interimLen < this.lastInterimLen) {
      this.revealed = 0;
      this.lastAdvanceAt = -Infinity;
    }
    this.lastInterimLen = interimLen;

    if (interimLen === 0) {
      // Interim emptied (a final landed / utterance ended). Fully reset the run
      // clock too — otherwise the FIRST interim word of the next phrase is timed
      // against the previous phrase's stale lastAdvanceAt, making that phrase's
      // crawl start depend on how long the speaker paused. A fresh run must
      // start its crawl cleanly.
      this.revealed = 0;
      this.lastAdvanceAt = -Infinity;
      return 0;
    }

    // Already caught up — keep showing everything (no backwards motion).
    if (this.revealed >= interimLen) {
      this.revealed = interimLen;
      return this.revealed;
    }

    // Advance at most wordsPerTick, and only once per interval, so the crawl
    // tracks the BLE refresh rate rather than the message rate.
    const elapsed = this.now() - this.lastAdvanceAt;
    if (elapsed >= this.intervalMs) {
      this.revealed = Math.min(interimLen, this.revealed + this.wordsPerTick);
      this.lastAdvanceAt = this.now();
    } else if (this.revealed === 0) {
      // First word of a brand-new run shows immediately (no perceptible stall
      // on the leading word), then the rest crawls.
      this.revealed = Math.min(interimLen, this.wordsPerTick);
      this.lastAdvanceAt = this.now();
    }
    return this.revealed;
  }

  /** True when there are recognized interim words not yet revealed (mid-crawl). */
  hasPending(): boolean {
    return this.revealed < this.lastInterimLen;
  }

  /** Force the whole interim visible now (e.g. on a state flush). */
  snapToFull(interimLen: number): number {
    this.revealed = interimLen;
    this.lastInterimLen = interimLen;
    return interimLen;
  }

  /** Reset between sessions / on clear. */
  reset(): void {
    this.revealed = 0;
    this.lastInterimLen = 0;
    this.lastAdvanceAt = -Infinity;
  }
}
