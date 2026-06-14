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
      // Interval already satisfied — flush now (leading edge).
      this.doFlush(value);
      this.armTrailing();
    } else {
      // Within the interval — coalesce; newest wins.
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
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending !== null && this.pending !== this.lastSent) {
        this.doFlush(this.pending);
        this.pending = null;
        // Something was flushed — keep the cadence going in case more arrives.
        this.armTrailing();
      }
    }, this.intervalMs);
  }

  private doFlush(value: string): void {
    this.lastSent = value;
    this.lastFlushAt = this.now();
    void this.flushFn(value);
  }
}
