/**
 * Tests for TranscriptDisplay — rolling caption formatter for G2 glasses
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptDisplay } from '../glass/transcript-display';

describe('TranscriptDisplay', () => {
  let display: TranscriptDisplay;

  beforeEach(() => {
    display = new TranscriptDisplay();
  });

  describe('basic rendering', () => {
    it('shows placeholder when empty', () => {
      const output = display.render();
      expect(output).toContain('Listening...');
    });

    it('renders a single speaker line', () => {
      display.addFinal(0, 'Hello everyone');
      const output = display.render();
      expect(output).toContain('[A] Hello everyone');
    });

    it('renders multiple speakers with different labels', () => {
      display.addFinal(0, 'Hello everyone');
      display.addFinal(1, 'Hi there');
      const output = display.render();
      expect(output).toContain('[A] Hello everyone');
      expect(output).toContain('[B] Hi there');
    });

    it('groups consecutive same-speaker lines', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(0, 'How are you?');
      const output = display.render();
      // Should be merged into one line
      expect(output).toContain('[A] Hello How are you?');
      // Should NOT have two [A] labels
      const matches = output.match(/\[A\]/g);
      expect(matches?.length).toBe(1);
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
      // Note: renameSpeaker changes the name but the render uses the letter
      // This is by design — the letter comes from the label assignment
      const speakers = display.getSpeakers();
      expect(speakers[0].name).toBe('Sarah');
    });

    it('returns all known speakers', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(1, 'Hi');
      display.addFinal(2, 'Hey');
      const speakers = display.getSpeakers();
      expect(speakers).toHaveLength(3);
      expect(speakers.map(s => s.letter)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('utterance management', () => {
    it('finalizes interim on utterance end', () => {
      display.updateInterim(0, 'Hello world');
      display.onUtteranceEnd();
      const output = display.render();
      expect(output).toContain('[A] Hello world');
      expect(output).not.toContain('━'); // No interim cursor after finalization
    });

    it('replaces interim when new interim arrives', () => {
      display.updateInterim(0, 'Hel');
      display.updateInterim(0, 'Hello wor');
      display.updateInterim(0, 'Hello world');
      const output = display.render();
      // Should only show the latest interim
      expect(output.match(/Hello/g)?.length).toBe(1);
    });

    it('clears interim when final for same speaker arrives', () => {
      display.updateInterim(0, 'Hello world');
      display.addFinal(0, 'Hello world!');
      const output = display.render();
      expect(output).not.toContain('━'); // Interim cleared
      expect(output).toContain('[A] Hello world!');
    });
  });

  describe('display constraints', () => {
    it('trims old lines when exceeding character limit', () => {
      // Add a lot of text to exceed the 900-char limit
      for (let i = 0; i < 30; i++) {
        display.addFinal(i % 3, `This is a moderately long sentence number ${i + 1} from the conversation.`);
      }
      const output = display.render();
      expect(output.length).toBeLessThanOrEqual(900);
      // Most recent text should still be visible
      expect(output).toContain('sentence number 30');
    });

    it('keeps most recent content when trimming', () => {
      display.addFinal(0, 'Old message from the start of the conversation');
      for (let i = 0; i < 25; i++) {
        // Alternate speakers so lines don't merge
        display.addFinal(i % 2, `Message ${i + 1} with extra padding text to fill up space.`);
      }
      const output = display.render();
      // Old message should be trimmed
      expect(output).not.toContain('Old message from the start');
      // Recent messages should survive
      expect(output).toContain('Message 25');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      display.addFinal(0, 'Hello');
      display.addFinal(1, 'World');
      display.clear();

      expect(display.render()).toContain('Listening...');
      expect(display.getSpeakers()).toHaveLength(0);
    });
  });
});
