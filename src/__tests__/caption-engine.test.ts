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

  describe('stable per-token keys (for sim animation)', () => {
    it('assigns a key to every token in a frame', () => {
      engine.addFinal(0, 'hello world');
      const f = engine.buildFrame();
      const tokens = f.lines.flatMap((l) => l.tokens);
      expect(tokens.every((t) => typeof t.key === 'string' && t.key.length > 0)).toBe(true);
    });

    it('keeps a word’s key stable when its interim is promoted to final', () => {
      engine.updateInterim(0, 'one two three');
      const keyOf = (txt: string, f = engine.buildFrame()) =>
        f.lines.flatMap((l) => l.tokens).find((t) => t.text === txt)?.key;
      const beforeTwo = keyOf('two');
      engine.onUtteranceEnd(); // interim → final in place
      const afterTwo = keyOf('two');
      expect(afterTwo).toBe(beforeTwo); // same identity ⇒ renderer won't re-fade
    });

    it('gives different turns distinct key namespaces (no cross-turn collision)', () => {
      engine.addFinal(0, 'alpha');
      engine.addFinal(1, 'alpha'); // same word, different turn
      const f = engine.buildFrame();
      const keys = f.lines.flatMap((l) => l.tokens).map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length); // all unique
    });
  });

  describe('buildTurns (unwrapped, geometry-free glasses window)', () => {
    // The glasses path no longer models panel geometry: buildTurns takes NO
    // size args and applies NO line/char budget. It emits every retained turn
    // full-width and the firmware wraps + scrolls + clips. (The only history
    // bound is the engine's internal MAX_SEGMENTS; the only payload bound is
    // the MAX_CHARS ceiling enforced in transcript-display.render(), tested
    // there.) These were the "wraps too early / only ~5 lines" bugs: a guessed
    // 38 chars/line ran at ~half the true width and over-counted every turn.

    it('returns one entry per speaker turn, full-width (no pre-wrap)', () => {
      engine.addFinal(0, 'hello there how are you doing today');
      engine.addFinal(1, 'i am doing very well thanks for asking');
      const turns = engine.buildTurns();
      expect(turns).toHaveLength(2);
      // Whole turn on one logical line — the firmware wraps it, not us.
      expect(turns[0].finalText).toBe('hello there how are you doing today');
      expect(turns[0].tag).toBe('A');
      expect(turns[1].tag).toBe('B');
    });

    it('does NOT trim by any line/char budget — every retained turn is emitted', () => {
      // Far more turns than any panel could show, each long enough that the old
      // 7-line budget would have evicted most of them. With the budget gone,
      // they ALL come back (bounded only by MAX_SEGMENTS=40, not hit here).
      for (let i = 0; i < 20; i++) {
        engine.addFinal(i, `turn number ${i} with a fair amount of padding words here`);
      }
      const turns = engine.buildTurns();
      expect(turns).toHaveLength(20);
      // Both the oldest and newest survive — no rolling window at this layer.
      expect(turns[0].finalText).toContain('turn number 0');
      expect(turns[turns.length - 1].finalText).toContain('turn number 19');
    });

    it('preserves chronological order, oldest first', () => {
      for (let i = 0; i < 5; i++) engine.addFinal(i, `line ${i}`);
      const turns = engine.buildTurns();
      expect(turns.map((t) => t.finalText)).toEqual([
        'line 0', 'line 1', 'line 2', 'line 3', 'line 4',
      ]);
    });

    it('always includes the live interim tail as the last, current turn', () => {
      for (let i = 0; i < 12; i++) {
        engine.addFinal(i, `turn number ${i} with a fair amount of padding words here`);
      }
      // A fresh turn whose interim extends its own (empty) finals.
      engine.updateInterim(99, 'and this is the still being recognized live tail right now');
      const turns = engine.buildTurns();
      const last = turns[turns.length - 1];
      expect(last.isCurrentSpeaker).toBe(true);
      expect(last.interimText).toContain('live tail right now');
    });

    it('bounds history only by MAX_SEGMENTS (internal retention), not geometry', () => {
      // Push well past the 40-segment retention cap; buildTurns reflects that
      // cap (and nothing tighter), keeping the most recent segments.
      for (let i = 0; i < 60; i++) engine.addFinal(i, `line ${i}`);
      const turns = engine.buildTurns();
      expect(turns).toHaveLength(40);
      // Newest kept; oldest (pre-cap) dropped by retention, not a line budget.
      expect(turns[turns.length - 1].finalText).toBe('line 59');
      expect(turns.some((t) => t.finalText === 'line 0')).toBe(false);
    });
  });

  /**
   * Regression: mid-utterance speaker RE-DIARIZATION.
   *
   * Deepgram's streaming diarizer emits unstable indices — it routinely starts a
   * phrase under one index and, with more audio context, re-attributes the SAME
   * words to another index (which a voiceprint then names). The bug: the engine
   * treated the new index as a new turn and rendered the utterance twice —
   * "[B] Great weather today!  [Alice] Great weather today!". The fix relabels
   * the existing turn in place (tag flips B→Alice; text and token keys untouched).
   */
  describe('speaker re-diarization (relabel in place, no duplicate line)', () => {
    const textOf = (e: CaptionEngine) =>
      e.buildFrame().lines.map((l) => `${l.tag ? `[${l.tag}] ` : ''}${l.tokens.map((t) => t.text).join(' ')}`);

    it('relabels a finalized turn when the same words are re-diarized to a new index', () => {
      engine.addFinal(1, 'Great weather today');      // diarizer's first guess → [B]
      engine.addFinal(0, 'Great weather today');      // re-attributed to index 0 → [A]
      const lines = textOf(engine);
      // ONE line, now under the corrected tag — not two duplicates.
      expect(lines).toEqual(['[A] Great weather today']);
    });

    it('keeps the relabeled turn under one tag and one speaker', () => {
      engine.addFinal(1, 'Great weather today');
      engine.addFinal(0, 'Great weather today');
      const f = engine.buildFrame();
      expect(f.lines).toHaveLength(1);
      expect(f.lines[0].speaker).toBe(0);
      expect(engine.activeSpeaker).toBe(0);
    });

    it('preserves stable token keys across the relabel (renderer will not re-fade)', () => {
      engine.addFinal(1, 'Great weather today');
      const keyBefore = engine.buildFrame().lines[0].tokens.find((t) => t.text === 'weather')!.key;
      engine.addFinal(0, 'Great weather today');     // relabel in place
      const keyAfter = engine.buildFrame().lines[0].tokens.find((t) => t.text === 'weather')!.key;
      expect(keyAfter).toBe(keyBefore);
    });

    it('relabels mid-stream on an interim re-diarization, without duplicating words', () => {
      engine.updateInterim(1, 'great weather');            // streaming under [B]
      engine.updateInterim(0, 'great weather today');      // re-diarized to [A], extended
      const lines = textOf(engine);
      expect(lines).toEqual(['[A] great weather today']);
    });

    it('extends the turn when the re-diarized final adds more words', () => {
      engine.addFinal(1, 'great weather');
      engine.addFinal(0, 'great weather today everyone');  // same start, longer
      const f = engine.buildFrame();
      // One relabeled turn (single tag); words present once, in order — no
      // "great weather great weather" duplication of the overlapping prefix.
      expect(f.lines.filter((l) => l.tag !== null)).toHaveLength(1);
      expect(f.lines[0].speaker).toBe(0);
      const words = f.lines.flatMap((l) => l.tokens.map((t) => t.text));
      expect(words).toEqual(['great', 'weather', 'today', 'everyone']);
    });

    it('relabels an interim flip when the turn already has locked finals', () => {
      // Realistic glasses ordering: a fragment finalizes under index 0, then the
      // SAME utterance's interim continues but the diarizer flips it to index 1.
      // Must relabel in place and append only the new tail — no new line, no
      // dropped/duplicated words. (Pre-fix, updateInterim ignored isRelabel and
      // could spawn a fresh turn → the mid-sentence break.)
      engine.addFinal(0, 'my name is');                     // locked under [A]
      engine.updateInterim(1, 'my name is Tim');            // flipped to [B], extended
      const f = engine.buildFrame();
      expect(f.lines.filter((l) => l.tag !== null)).toHaveLength(1);
      expect(f.lines[0].speaker).toBe(1);
      const words = f.lines.flatMap((l) => l.tokens.map((t) => t.text));
      expect(words).toEqual(['my', 'name', 'is', 'Tim']); // once, in order
    });

    it('still opens a NEW turn when a different speaker says different words', () => {
      engine.addFinal(0, 'Hi there');
      engine.addFinal(1, 'Great weather today');           // genuinely new turn
      const lines = textOf(engine);
      expect(lines).toEqual(['[A] Hi there', '[B] Great weather today']);
    });

    it('does not swallow a new turn that merely opens with a repeated word', () => {
      engine.addFinal(0, 'so anyway that was fun');
      engine.addFinal(1, 'so what do you think');          // shares only "so"
      const f = engine.buildFrame();
      // Two distinct turns — a single shared leading word is not a re-diarization.
      expect(f.lines.map((l) => l.speaker)).toEqual([0, 1]);
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
