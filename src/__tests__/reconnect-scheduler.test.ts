/**
 * Tests for ReconnectScheduler — exponential backoff WebSocket reconnect
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ReconnectScheduler } from '../glass/settings-manager';

describe('ReconnectScheduler', () => {
  let scheduler: ReconnectScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new ReconnectScheduler();
  });

  afterEach(() => {
    scheduler.cancel();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts with 1s delay', () => {
      expect(scheduler.nextDelay).toBe(1000);
    });
  });

  describe('backoff progression', () => {
    it('first schedule fires at 1s', () => {
      const cb = vi.fn();
      scheduler.schedule(cb);
      expect(cb).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledOnce();
    });

    it('doubles delay after each fired attempt', () => {
      const cb = vi.fn();

      // First attempt: 1s
      scheduler.schedule(cb);
      vi.advanceTimersByTime(1000);
      expect(scheduler.nextDelay).toBe(2000);

      // Second attempt: 2s
      scheduler.schedule(cb);
      vi.advanceTimersByTime(2000);
      expect(scheduler.nextDelay).toBe(4000);

      // Third: 4s
      scheduler.schedule(cb);
      vi.advanceTimersByTime(4000);
      expect(scheduler.nextDelay).toBe(8000);
    });

    it('caps at 30s', () => {
      const cb = vi.fn();

      // Run through many attempts to hit the cap
      for (let i = 0; i < 10; i++) {
        scheduler.schedule(cb);
        vi.advanceTimersByTime(scheduler.nextDelay * 2); // advance enough
      }

      expect(scheduler.nextDelay).toBe(30000);
    });
  });

  describe('reset', () => {
    it('resets delay to 1s after successful connect', () => {
      const cb = vi.fn();
      scheduler.schedule(cb);
      vi.advanceTimersByTime(1000); // fires, doubles to 2s
      expect(scheduler.nextDelay).toBe(2000);

      scheduler.reset();
      expect(scheduler.nextDelay).toBe(1000);
    });

    it('cancels pending timer on reset', () => {
      const cb = vi.fn();
      scheduler.schedule(cb);

      scheduler.reset();
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('prevents scheduled callback from firing', () => {
      const cb = vi.fn();
      scheduler.schedule(cb);
      scheduler.cancel();
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('no double-scheduling', () => {
    it('ignores subsequent schedule calls while timer is pending', () => {
      const cb = vi.fn();
      scheduler.schedule(cb);
      scheduler.schedule(cb); // second call should be ignored
      scheduler.schedule(cb);

      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe('status callback', () => {
    it('emits a reconnecting message when scheduled', () => {
      const statusMessages: string[] = [];
      scheduler.onStatusChange = (msg) => statusMessages.push(msg);

      scheduler.schedule(vi.fn());
      expect(statusMessages).toHaveLength(1);
      expect(statusMessages[0]).toMatch(/Reconnecting in 1s/);
    });

    it('includes updated delay in subsequent messages', () => {
      const statusMessages: string[] = [];
      scheduler.onStatusChange = (msg) => statusMessages.push(msg);
      const cb = vi.fn();

      scheduler.schedule(cb);
      vi.advanceTimersByTime(1000); // fire → delay becomes 2s

      scheduler.schedule(cb);
      expect(statusMessages[1]).toMatch(/Reconnecting in 2s/);
    });
  });
});
