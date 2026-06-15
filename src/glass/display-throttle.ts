/**
 * DisplayThrottle — newest-wins coalescing for glasses display pushes.
 *
 * The G2 link is BLE; production drivers (MentraOS) cap display updates at
 * ~3/sec (≥300 ms apart) and coalesce anything faster — sending more often
 * doesn't update the display faster, it just gets dropped or merged, and can
 * cause flicker/saturation. Live captions naturally want to push far more
 * often than that, so we throttle here.
 *
 * Semantics (leading + trailing, newest-wins):
 *  - The first call fires immediately (no perceptible latency on the first
 *    word of a turn).
 *  - Subsequent calls within the interval are coalesced; only the LATEST
 *    pending value is flushed when the interval elapses.
 *  - If nothing new arrived during the interval, no redundant flush happens.
 *
 * It is value-aware: pushing a value identical to the last one sent is a
 * no-op, so a steady stream of unchanged renders costs nothing.
 */

export type FlushFn = (value: string) => void | Promise<void>;

export class DisplayThrottle {
  private intervalMs: number;
  private flushFn: FlushFn;

  private lastSent: string | null = null;
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // -Infinity so the very first push always satisfies the interval and fires
  // immediately, regardless of the clock's starting value.
  private lastFlushAt = -Infinity;

  /** Injectable clock for deterministic tests. */
  private now: () => number;

  constructor(flushFn: FlushFn, intervalMs = 300, now: () => number = Date.now) {
    this.flushFn = flushFn;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  /** Change the throttle interval (e.g. if a device profile differs). */
  setInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  /**
   * Request that `value` be shown. Fires immediately if the interval has
   * elapsed since the last flush; otherwise schedules a trailing flush of the
   * newest value.
   */
  push(value: string): void {
    if (value === this.lastSent && this.pending === null) return; // nothing to do

    const elapsed = this.now() - this.lastFlushAt;
    if (this.timer === null && elapsed >= this.intervalMs) {
      // Interval already satisfied — flush now (leading edge). We do NOT arm a
      // trailing timer here: with nothing pending there's nothing to flush, and
      // a free-running timer is exactly the "beat" that made captions clump
      // (it fired on a fixed 300ms grid misaligned with word arrivals). The
      // next push() within the interval re-arms it for the remaining time.
      this.doFlush(value);
    } else {
      // Within the interval — coalesce; newest wins. Schedule a single trailing
      // flush for when the interval actually elapses (relative to the last real
      // flush), so push spacing never drops below the BLE-safe floor.
      this.pending = value;
      this.armTrailing();
    }
  }

  /** Force any pending value out immediately (e.g. on important state change). */
  flushNow(): void {
    if (this.pending !== null && this.pending !== this.lastSent) {
      this.doFlush(this.pending);
    }
    this.pending = null;
  }

  /** Cancel scheduled work (teardown). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  // ─── internals ───────────────────────────────────────────────

  private armTrailing(): void {
    if (this.timer !== null) return;
    // Fire when the interval elapses relative to the LAST real flush, not a
    // fresh full interval from "now" — so a value that arrives late in the
    // window isn't delayed by an extra ~300ms, and spacing between flushes
    // stays exactly the BLE floor. (lastFlushAt is -Infinity before the first
    // flush, which would underflow; in that case use the full interval.)
    const sinceFlush = this.now() - this.lastFlushAt;
    const wait = Number.isFinite(sinceFlush)
      ? Math.max(0, this.intervalMs - sinceFlush)
      : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending !== null && this.pending !== this.lastSent) {
        this.doFlush(this.pending);
        this.pending = null;
      }
      // No auto-re-arm: once pending is drained we stop. The next push()
      // re-arms the cadence. This is what stops the self-perpetuating beat
      // after the word stream goes quiet.
    }, wait);
  }

  private doFlush(value: string): void {
    this.lastSent = value;
    this.lastFlushAt = this.now();
    void this.flushFn(value);
  }
}
