/**
 * Tests for TranscriptDisplay — rolling caption formatter for G2 glasses.
 *
 * TranscriptDisplay is now a thin adapter over CaptionEngine (whose stabilization
 * behavior is tested exhaustively in caption-engine.test.ts). These tests pin the
 * string/frame contract the renderers depend on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptDisplay } from '../glass/transcript-display';

describe('TranscriptDisplay', () => {
  let display: TranscriptDisplay;

  beforeEach(() => {
    // Generous window so multi-speaker assertions all stay visible.
    display = new TranscriptDisplay({ maxLines: 12, maxLineChars: 40 });
    // Default to the live state so the happy path shows no status banner.
    display.setStatus('listening');
  });

  describe('basic rendering', () => {
    it('shows a live placeholder when empty', () => {
      expect(display.render()).toContain('Listening');
    });

    it('reflects the live capture state in the empty placeholder', () => {
      display.setStatus('error');
      expect(display.render()).toContain('unavailable');
    });

    it('renders a single speaker line with a turn marker + tag', () => {
      display.addFinal(0, 'Hello everyone');
      const output = display.render();
      expect(output).toContain('[A] Hello everyone');
      // Turn marker precedes the tag on a speaker change
      expect(output).toContain('— [A]');
    });

    it('renders multiple speakers with different labels', () => {
      display.addFinal(0, 'Hello everyone');
      display.addFinal(1, 'Hi there');
      const output = display.render();
      expect(output).toContain('[A] Hello everyone');
      expect(output).toContain('[B] Hi there');
    });

    it('groups consecutive same-speaker lines under one tag', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(0, 'How are you?');
      const output = display.render();
      expect(output).toContain('Hello');
      expect(output).toContain('How are you?');
      // Only one [A] tag for the merged turn
      expect(output.match(/\[A\]/g)?.length).toBe(1);
    });

    it('shows interim text with cursor indicator', () => {
      display.addFinal(0, 'Hello');
      display.updateInterim(1, 'I was thinking');
      const output = display.render();
      expect(output).toContain('[A] Hello');
      expect(output).toContain('[B] I was thinking');
      expect(output).toContain('━'); // Interim cursor
    });
  });

  describe('frame model', () => {
    it('exposes a structured frame with current-speaker emphasis', () => {
      display.addFinal(0, 'first');
      display.addFinal(1, 'second');
      const frame = display.renderFrame();
      const b = frame.lines.find((l) => l.speaker === 1)!;
      expect(b.isCurrentSpeaker).toBe(true);
      const a = frame.lines.find((l) => l.speaker === 0)!;
      expect(a.isCurrentSpeaker).toBe(false);
    });

    it('tags interim tokens distinctly from final tokens', () => {
      display.addFinal(0, 'locked words');
      display.updateInterim(0, 'locked words still coming');
      const frame = display.renderFrame();
      const tokens = frame.lines.flatMap((l) => l.tokens);
      expect(tokens.filter((t) => t.state === 'interim').map((t) => t.text)).toEqual([
        'still',
        'coming',
      ]);
    });
  });

  describe('speaker management', () => {
    it('assigns sequential letters to new speakers', () => {
      display.addFinal(0, 'First');
      display.addFinal(1, 'Second');
      display.addFinal(2, 'Third');
      const output = display.render();
      expect(output).toContain('[A]');
      expect(output).toContain('[B]');
      expect(output).toContain('[C]');
    });

    it('allows renaming speakers', () => {
      display.addFinal(0, 'Hello');
      display.renameSpeaker(0, 'Sarah');
      const speakers = display.getSpeakers();
      expect(speakers[0].name).toBe('Sarah');
    });

    it('uses an external name resolver when set', () => {
      display.setNameResolver((idx) => (idx === 0 ? 'Tim' : ''));
      display.addFinal(0, 'hello');
      expect(display.render()).toContain('[Tim] hello');
    });

    it('returns all known speakers', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(1, 'Hi');
      display.addFinal(2, 'Hey');
      const speakers = display.getSpeakers();
      expect(speakers).toHaveLength(3);
      expect(speakers.map((s) => s.letter)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('utterance management', () => {
    it('finalizes interim on utterance end', () => {
      display.updateInterim(0, 'Hello world');
      display.onUtteranceEnd();
      const output = display.render();
      expect(output).toContain('[A] Hello world');
      expect(output).not.toContain('━');
    });

    it('replaces interim when new interim arrives', () => {
      display.updateInterim(0, 'Hel');
      display.updateInterim(0, 'Hello wor');
      display.updateInterim(0, 'Hello world');
      const output = display.render();
      expect(output.match(/Hello/g)?.length).toBe(1);
    });

    it('clears interim cursor when final for same speaker arrives', () => {
      display.updateInterim(0, 'Hello world');
      display.addFinal(0, 'Hello world!');
      const output = display.render();
      expect(output).not.toContain('━');
      expect(output).toContain('Hello world!');
    });
  });

  describe('rolling window', () => {
    it('limits the visible window to maxLines', () => {
      const small = new TranscriptDisplay({ maxLines: 3, maxLineChars: 30 });
      small.setStatus('listening'); // no status banner in the happy path
      for (let i = 0; i < 30; i++) {
        small.addFinal(i % 3, `This is sentence number ${i + 1} from the conversation.`);
      }
      const output = small.render();
      const lines = output.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(3);
      // Most recent text should still be visible
      expect(output).toContain('30');
    });

    it('keeps most recent content when trimming', () => {
      const small = new TranscriptDisplay({ maxLines: 3, maxLineChars: 30 });
      small.setStatus('listening');
      small.addFinal(0, 'Old message from the very start');
      for (let i = 0; i < 25; i++) {
        small.addFinal(i % 2, `Message ${i + 1} with extra padding text`);
      }
      const output = small.render();
      expect(output).not.toContain('Old message from the very start');
      expect(output).toContain('25');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(1, 'World');
      display.clear();
      expect(display.render()).toContain('Listening');
      expect(display.getSpeakers()).toHaveLength(0);
    });
  });

  describe('paused state', () => {
    it('starts unpaused', () => {
      expect(display.isPaused).toBe(false);
    });

    it('setPaused toggles isPaused', () => {
      display.setPaused(true);
      expect(display.isPaused).toBe(true);
      display.setPaused(false);
      expect(display.isPaused).toBe(false);
    });

    it('surfaces a paused banner in the flat render so the wearer is never left guessing', () => {
      display.addFinal(0, 'Hello');
      const before = display.render();
      expect(before).not.toContain('paused');

      display.setPaused(true);
      const after = display.render();
      // The transcript text is preserved, but a paused banner is added.
      expect(after).toContain('Hello');
      expect(after.toLowerCase()).toContain('paused');
    });

    it('renderFrame carries paused status for the renderer', () => {
      display.setPaused(true);
      expect(display.renderFrame().status).toBe('paused');
    });
  });
});
