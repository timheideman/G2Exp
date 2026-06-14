/**
 * Tests for DisplayThrottle — BLE-safe newest-wins coalescing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DisplayThrottle } from '../glass/display-throttle';

describe('DisplayThrottle', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the first push immediately (leading edge)', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);
    t.push('a');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('a');
  });

  it('coalesces rapid pushes within the interval — newest wins', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('a'); // leading, fires now
    t.push('b'); // within interval — pending
    t.push('c'); // within interval — pending overwrites b

    expect(flush).toHaveBeenCalledTimes(1);

    clock = 300;
    vi.advanceTimersByTime(300);

    // Only the newest ('c') is flushed, not 'b'
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith('c');
  });

  it('does not flush redundantly when nothing changed', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('a');
    clock = 300;
    vi.advanceTimersByTime(300);

    // No new pushes — no second flush
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('ignores a push identical to the last sent value', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('a'); // fires
    clock = 350;
    t.push('a'); // identical — no-op even though interval elapsed
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('respects the interval across multiple bursts', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('1'); // t=0 leading
    clock = 100;
    t.push('2'); // pending
    clock = 300;
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenLastCalledWith('2'); // 2 flushes

    clock = 400;
    t.push('3'); // still within trailing cadence window -> pending
    clock = 600;
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenLastCalledWith('3');
  });

  it('flushNow forces the pending value out', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('a'); // leading
    t.push('b'); // pending
    t.flushNow();
    expect(flush).toHaveBeenLastCalledWith('b');
  });

  it('cancel stops scheduled flushes', () => {
    const flush = vi.fn();
    const t = new DisplayThrottle(flush, 300, now);

    t.push('a'); // leading
    t.push('b'); // pending
    t.cancel();
    clock = 1000;
    vi.advanceTimersByTime(1000);
    // Only the leading 'a' ever fired
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
