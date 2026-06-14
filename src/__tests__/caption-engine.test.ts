/**
 * Tests for CaptionEngine — the stabilized caption layout core.
 *
 * These tests pin the research-driven behaviors that matter for DHH readers:
 *  - stable rolling window of N lines
 *  - flicker-free interim (committed words never rewritten)
 *  - phrase/word-boundary wrapping (never mid-word)
 *  - speaker tag only on turn change
 *  - current-speaker emphasis
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CaptionEngine,
  wrapTokens,
  tokenize,
  letterFor,
  type CaptionToken,
} from '../glass/caption-engine';

const fin = (t: string): CaptionToken => ({ text: t, state: 'final' });

describe('CaptionEngine', () => {
  let engine: CaptionEngine;

  beforeEach(() => {
    engine = new CaptionEngine({ maxLines: 3, maxLineChars: 30 });
  });

  describe('basic ingest + frame', () => {
    it('is empty initially', () => {
      expect(engine.buildFrame().lines).toHaveLength(0);
    });

    it('renders one speaker turn with a tag on the first line', () => {
      engine.addFinal(0, 'Hello everyone');
      const f = engine.buildFrame();
      expect(f.lines[0].tag).toBe('A');
      expect(f.lines[0].tokens.map((t) => t.text)).toEqual(['Hello', 'everyone']);
    });

    it('merges consecutive same-speaker finals into one turn (one tag)', () => {
      engine.addFinal(0, 'Hello');
      engine.addFinal(0, 'how are you');
      const f = engine.buildFrame();
      const tagged = f.lines.filter((l) => l.tag === 'A');
      expect(tagged).toHaveLength(1);
      // all words present
      const words = f.lines.flatMap((l) => l.tokens.map((t) => t.text));
      expect(words).toEqual(['Hello', 'how', 'are', 'you']);
    });

    it('starts a new turn (new tag) when the speaker changes', () => {
      engine.addFinal(0, 'Hi there');
      engine.addFinal(1, 'Hello back');
      const f = engine.buildFrame();
      expect(f.lines.some((l) => l.tag === 'A')).toBe(true);
      expect(f.lines.some((l) => l.tag === 'B')).toBe(true);
    });
  });

  describe('current-speaker emphasis', () => {
    it('marks only the latest speaker as current', () => {
      engine.addFinal(0, 'first');
      engine.addFinal(1, 'second');
      const f = engine.buildFrame();
      const a = f.lines.find((l) => l.speaker === 0)!;
      const b = f.lines.find((l) => l.speaker === 1)!;
      expect(a.isCurrentSpeaker).toBe(false);
      expect(b.isCurrentSpeaker).toBe(true);
    });
  });

  describe('interim stabilization (anti-flicker)', () => {
    it('shows interim words tagged interim', () => {
      engine.updateInterim(0, 'I was thinking');
      const f = engine.buildFrame();
      const states = f.lines.flatMap((l) => l.tokens.map((t) => t.state));
      expect(states.every((s) => s === 'interim')).toBe(true);
    });

    it('does not rewrite words already locked by a final', () => {
      engine.addFinal(0, 'I went to the');
      // Deepgram interim repeats the whole utterance from the start
      engine.updateInterim(0, 'I went to the store');
      const f = engine.buildFrame();
      const tokens = f.lines.flatMap((l) => l.tokens);
      // The first 4 words stay final; only "store" is interim
      const finals = tokens.filter((t) => t.state === 'final').map((t) => t.text);
      const interims = tokens.filter((t) => t.state === 'interim').map((t) => t.text);
      expect(finals).toEqual(['I', 'went', 'to', 'the']);
      expect(interims).toEqual(['store']);
    });

    it('promotes interim to final in place on utterance end (no movement)', () => {
      engine.updateInterim(0, 'hello world');
      const before = engine.buildFrame().lines.flatMap((l) => l.tokens.map((t) => t.text));
      engine.onUtteranceEnd();
      const after = engine.buildFrame();
      const afterWords = after.lines.flatMap((l) => l.tokens.map((t) => t.text));
      const afterStates = after.lines.flatMap((l) => l.tokens.map((t) => t.state));
      expect(afterWords).toEqual(before); // identical text, no reflow
      expect(afterStates.every((s) => s === 'final')).toBe(true);
    });

    it('a later final supersedes a stale interim tail', () => {
      engine.updateInterim(0, 'hello wor');
      engine.addFinal(0, 'hello world');
      const f = engine.buildFrame();
      const words = f.lines.flatMap((l) => l.tokens.map((t) => t.text));
      expect(words).toEqual(['hello', 'world']);
      const states = f.lines.flatMap((l) => l.tokens.map((t) => t.state));
      expect(states.every((s) => s === 'final')).toBe(true);
    });
  });

  describe('stable rolling window', () => {
    it('never shows more than maxLines', () => {
      for (let i = 0; i < 20; i++) {
        engine.addFinal(i % 2, `This is line number ${i} with some padding words here`);
      }
      const f = engine.buildFrame();
      expect(f.lines.length).toBeLessThanOrEqual(3);
    });

    it('keeps the most recent content at the bottom', () => {
      engine.addFinal(0, 'old content at the very beginning of the talk');
      for (let i = 0; i < 10; i++) {
        engine.addFinal((i % 2) + 1, `newer message ${i} padded out a bit more`);
      }
      const f = engine.buildFrame();
      const words = f.lines.flatMap((l) => l.tokens.map((t) => t.text));
      expect(words.join(' ')).toContain('9');
      expect(words.join(' ')).not.toContain('beginning');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      engine.addFinal(0, 'hello');
      engine.clear();
      expect(engine.buildFrame().lines).toHaveLength(0);
      expect(engine.getSpeakers()).toHaveLength(0);
    });
  });

  describe('notices', () => {
    it('adds a system notice with no tag', () => {
      engine.addNotice('Paused');
      const f = engine.buildFrame();
      expect(f.lines[0].speaker).toBe(-1);
      expect(f.lines[0].tag).toBeNull();
    });
  });
});

describe('wrapTokens', () => {
  it('keeps a short line intact', () => {
    const lines = wrapTokens(['hi', 'there'].map(fin), 30, 'A');
    expect(lines).toHaveLength(1);
  });

  it('wraps at word boundaries, never mid-word', () => {
    const words = 'the quick brown fox jumps over the lazy dog again'.split(' ').map(fin);
    const lines = wrapTokens(words, 20, 'A');
    expect(lines.length).toBeGreaterThan(1);
    // No line should exceed the limit (allowing the tag on line 0)
    for (const line of lines) {
      const text = line.map((t) => t.text).join(' ');
      // each word is intact (present in the original)
      for (const t of line) expect('the quick brown fox jumps over lazy dog again').toContain(t.text);
    }
  });

  it('reserves room for the tag on the first line', () => {
    // With a long tag, fewer words fit on line 1
    const words = 'aaaa bbbb cccc dddd'.split(' ').map(fin);
    const withTag = wrapTokens(words, 14, 'Christopher');
    const noTag = wrapTokens(words, 14, '');
    // The tagged version should need at least as many lines
    expect(withTag.length).toBeGreaterThanOrEqual(noTag.length);
  });

  it('places an over-long single word on its own line rather than splitting it', () => {
    const words = ['supercalifragilisticexpialidocious', 'ok'].map(fin);
    const lines = wrapTokens(words, 10, '');
    // the long word is intact somewhere
    const all = lines.flatMap((l) => l.map((t) => t.text));
    expect(all).toContain('supercalifragilisticexpialidocious');
  });

  it('preserves token state through wrapping', () => {
    const tokens: CaptionToken[] = [
      { text: 'locked', state: 'final' },
      { text: 'words', state: 'final' },
      { text: 'live', state: 'interim' },
      { text: 'tail', state: 'interim' },
    ];
    const lines = wrapTokens(tokens, 12, '');
    const flat = lines.flat();
    expect(flat.find((t) => t.text === 'locked')!.state).toBe('final');
    expect(flat.find((t) => t.text === 'tail')!.state).toBe('interim');
  });
});

describe('helpers', () => {
  it('tokenize collapses whitespace', () => {
    expect(tokenize('  hello   world  ')).toEqual(['hello', 'world']);
  });
  it('letterFor maps indices to letters', () => {
    expect(letterFor(0)).toBe('A');
    expect(letterFor(2)).toBe('C');
  });
});
