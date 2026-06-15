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

    it('renders a single speaker line with a tight [tag] prefix', () => {
      display.addFinal(0, 'Hello everyone');
      const output = display.render();
      expect(output).toContain('[A] Hello everyone');
      // Tight label style: no dash marker before the tag (saves panel width).
      expect(output).not.toContain('—');
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

  // The reported bug: while a speaker was "unidentified" the text flowed
  // cleanly, but the instant the diarizer corrected the index (and a voiceprint
  // resolved a name) MID-sentence, a new line broke the utterance in two. The
  // fix relabels the turn in place (engine) AND merges consecutive same-NAME
  // turns into one flowing block keyed on the resolved tag, not the raw index.
  describe('mid-utterance relabel does not break the line', () => {
    it('keeps one continuous line when the index flips mid-utterance', () => {
      // Streaming under index 0, then the diarizer re-attributes the SAME words
      // to index 1 and extends them — exactly Deepgram's unstable-index behavior.
      display.updateInterim(0, 'my name is');
      display.updateInterim(1, 'my name is Tim and');
      const output = display.render();
      // Body lines only (drop any status banner): exactly one caption line.
      const bodyLines = output.split('\n').filter((l) => l.trim() && !l.includes('listening'));
      expect(bodyLines).toHaveLength(1);
      expect(output).toContain('my name is Tim and');
      // The words are NOT duplicated across a broken line.
      expect(output.match(/my name is/g)?.length).toBe(1);
    });

    it('merges consecutive turns that resolve to the same NAME under one tag', () => {
      // Two different Deepgram indices that a voiceprint resolves to one person.
      display.setNameResolver((idx) => (idx === 0 || idx === 1 ? 'Tim' : ''));
      display.addFinal(0, 'First sentence.');
      display.addFinal(1, 'Second sentence.'); // different index, same resolved name
      const output = display.render();
      // One flowing block, one [Tim] tag — not two separately-tagged lines.
      expect(output.match(/\[Tim\]/g)?.length).toBe(1);
      expect(output).toContain('First sentence.');
      expect(output).toContain('Second sentence.');
    });

    it('still breaks the line for a genuinely different speaker', () => {
      display.addFinal(0, 'Hello there');
      display.addFinal(1, 'Hi back'); // different speaker, different tag → new line
      const output = display.render();
      const bodyLines = output.split('\n').filter((l) => l.trim() && !l.includes('listening'));
      expect(bodyLines).toHaveLength(2);
      expect(output).toContain('[A] Hello there');
      expect(output).toContain('[B] Hi back');
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

  describe('rolling window (geometry-free: firmware clips, we cap by MAX_CHARS)', () => {
    // The flat string is NO LONGER trimmed to a guessed line count — the
    // firmware wraps and clips to the real panel. We emit every retained turn;
    // the only payload bound is the MAX_CHARS (1800) container ceiling, which
    // trims from the TOP so the newest text the reader is following survives.

    it('follows the live tail: newest always present, oldest rolls off the top', () => {
      const d = new TranscriptDisplay();
      d.setStatus('listening'); // no status banner in the happy path
      for (let i = 0; i < 30; i++) {
        d.addFinal(i % 3, `This is sentence number ${i + 1} from the conversation.`);
      }
      const output = d.render();
      const lines = output.split('\n').filter(Boolean);
      // No guessed line budget — the live window is char-based (~one panel) and
      // holds several turns, more than the old 3-line cap…
      expect(lines.length).toBeGreaterThan(3);
      // …the newest is always shown (auto-follow)…
      expect(output).toContain('number 30 ');
      // …and the oldest has rolled off the top so the tail stays on-screen.
      expect(output).not.toContain('number 1 ');
    });

    it('keeps the most recent content when the MAX_CHARS ceiling forces a trim', () => {
      const d = new TranscriptDisplay();
      d.setStatus('listening');
      d.addFinal(0, 'Old message from the very start');
      // Enough long turns to blow past the 1800-char container ceiling, forcing
      // the top-trim safety net to drop the oldest line(s).
      for (let i = 0; i < 80; i++) {
        d.addFinal(i % 2, `Message ${i + 1} with a generous amount of extra padding text to consume characters quickly`);
      }
      const output = d.render();
      expect(output.length).toBeLessThanOrEqual(1800);
      // Oldest rolled off the top; the newest turn is still there.
      expect(output).not.toContain('Old message from the very start');
      expect(output).toContain('Message 80 ');
    });
  });

  describe('reveal pacing (glasses path)', () => {
    it('default render() shows the full interim (sim/contract path unchanged)', () => {
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 40 });
      d.setStatus('listening');
      d.updateInterim(0, 'one two three four five six seven');
      // No paceReveal → all words present (the existing string contract).
      const out = d.render();
      expect(out).toContain('one two three four five six seven');
    });

    it('paceReveal crawls the interim a few words per tick, then catches up', () => {
      let clock = 0;
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 40 }, () => clock);
      d.setStatus('listening');
      d.updateInterim(0, 'one two three four five six seven');

      const words = (s: string) =>
        s.replace('[A] ', '').replace(' ━', '').trim().split(/\s+/).filter(Boolean);

      const t0 = d.render({ paceReveal: true });
      expect(words(t0).length).toBe(2); // leading reveal
      expect(d.hasPendingReveal()).toBe(true);

      clock = 300;
      const t1 = d.render({ paceReveal: true });
      expect(words(t1).length).toBe(4);

      // One advance per render tick (mirrors the BLE refresh) — keep ticking.
      clock = 600;
      expect(words(d.render({ paceReveal: true })).length).toBe(6);
      clock = 900;
      const t2 = d.render({ paceReveal: true });
      expect(words(t2).length).toBe(7); // fully caught up
      expect(d.hasPendingReveal()).toBe(false);
    });

    it('a final shows in full immediately even while pacing (finals never delayed)', () => {
      let clock = 0;
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 40 }, () => clock);
      d.setStatus('listening');
      d.updateInterim(0, 'streaming words one two three four five');
      d.render({ paceReveal: true }); // only 2 interim words shown
      // The utterance finalizes — engine clears interim, locks all words.
      d.addFinal(0, 'streaming words one two three four five');
      const out = d.render({ paceReveal: true });
      // All finalized words present at once; no interim cursor.
      expect(out).toContain('streaming words one two three four five');
      expect(out).not.toContain('━');
    });
  });

  /**
   * Regression for the on-glasses report: "only the first sentence streams in;
   * after that I only see whole sentences after a pause."
   *
   * The real defect lived in app.ts's render loop, not the pacer: the follow-up
   * reveal tick was only re-armed on the code path that got PAST the
   * `text === lastRenderedText` guard. When speech streams faster than the pacer
   * reveals (the normal case), consecutive renders produce the same visible
   * string, that guard bails early, and the self-sustaining crawl dies — so the
   * screen then only moves when a new transcript message changes the text, i.e.
   * at the next pause/final. These tests model that exact control flow against a
   * real TranscriptDisplay + injectable clock, so the loop logic is pinned.
   */
  describe('glasses reveal loop (app render-loop integration)', () => {
    // Faithful, headless re-implementation of LiveCaptionApp.updateDisplay +
    // scheduleRevealTick — the deterministic core of the on-device render loop.
    function makeLoop(d: TranscriptDisplay, nowFn: () => number, intervalMs = 300) {
      let lastRenderedText = '';
      let tickArmed = false;
      let tickDueAt = Infinity;
      const pushes: string[] = []; // each value actually sent to the glasses

      function updateDisplay() {
        const text = d.render({ paceReveal: true });
        // Fix A: arming happens BEFORE the changed-text guard.
        scheduleRevealTick();
        if (text === lastRenderedText) return;
        lastRenderedText = text;
        pushes.push(text);
      }
      function scheduleRevealTick() {
        if (tickArmed) return;
        if (!d.hasPendingReveal()) return;
        tickArmed = true;
        tickDueAt = nowFn() + intervalMs;
      }
      // Advance wall-clock to `t`, firing the reveal tick if it comes due —
      // mirrors setTimeout(updateDisplay, interval) with no new transcript msg.
      function advanceTo(t: number) {
        while (tickArmed && tickDueAt <= t) {
          // clock is owned by the test; it has already been set to >= tickDueAt
          tickArmed = false;
          tickDueAt = Infinity;
          updateDisplay();
        }
      }
      return { updateDisplay, advanceTo, pushes, isTickArmed: () => tickArmed };
    }

    const visibleWords = (s: string) =>
      s.replace(/\[[^\]]*\]\s*/g, '').replace(' ━', '').trim().split(/\s+/).filter(Boolean);

    it('keeps the crawl alive across ticks when no new transcript message arrives', () => {
      let clock = 0;
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 60 }, () => clock);
      d.setStatus('listening');
      const loop = makeLoop(d, () => clock);

      // A whole phrase's interim arrives at once (8 words) — one transcript msg.
      d.updateInterim(0, 'the quick brown fox jumps over the dog');
      loop.updateDisplay();
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(2); // leading reveal
      expect(loop.isTickArmed()).toBe(true);

      // No further transcript messages. The crawl must finish on ticks alone.
      clock = 300; loop.advanceTo(300);
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(4);
      clock = 600; loop.advanceTo(600);
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(6);
      clock = 900; loop.advanceTo(900);
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(8); // fully revealed

      // Caught up → loop self-terminates (no busy re-arming).
      expect(loop.isTickArmed()).toBe(false);
    });

    it('an interim landing mid-window (same visible text) does not kill the crawl', () => {
      // This is the precise failure: a new interim arrives inside the 300ms tick
      // window before the pacer has advanced, so render() returns the SAME string.
      // Pre-fix, that identical render hit the early-return and the tick was never
      // re-armed → crawl frozen until the next pause. Post-fix the tick survives.
      let clock = 0;
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 80 }, () => clock);
      d.setStatus('listening');
      const loop = makeLoop(d, () => clock);

      d.updateInterim(0, 'alpha beta gamma delta epsilon zeta eta theta');
      loop.updateDisplay();              // shows 2, tick armed for t=300
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(2);

      // 100ms later a longer interim arrives — but the pacer can't advance yet
      // (only 100ms elapsed), so the visible string is unchanged.
      clock = 100;
      d.updateInterim(0, 'alpha beta gamma delta epsilon zeta eta theta iota');
      loop.updateDisplay();              // same 2 words → early-return path
      expect(loop.isTickArmed()).toBe(true); // ← the crux: still armed post-fix

      // The crawl proceeds on schedule despite that identical render.
      clock = 300; loop.advanceTo(300);
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(4);
      clock = 600; loop.advanceTo(600);
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(6);
    });

    it('the SECOND phrase streams just like the first (the actual bug report)', () => {
      let clock = 0;
      const d = new TranscriptDisplay({ maxLines: 12, maxLineChars: 80 }, () => clock);
      d.setStatus('listening');
      const loop = makeLoop(d, () => clock);

      // Same-speaker turns merge into ONE flowing block (tag once), so phrase
      // 1's finals and phrase 2's crawling interim share the active line. The
      // interim tail = the visible words BEYOND phrase 1's finalized prefix.
      const PHRASE1 = 'alpha bravo charlie delta echo foxtrot';
      const PHRASE1_FINAL_COUNT = PHRASE1.split(' ').length; // 6
      const activeInterimWords = (push: string) => {
        const lastLine = push.trimEnd().split('\n').at(-1)!;
        // Active turn with a live tail ends in the interim cursor.
        if (!lastLine.includes('━')) return [];
        // Words after the finalized prefix are the still-crawling interim.
        return visibleWords(lastLine).slice(PHRASE1_FINAL_COUNT);
      };

      // ── Phrase 1: streams in fine ── (no finals yet, so all visible = interim)
      d.updateInterim(0, PHRASE1);
      loop.updateDisplay();
      clock = 300; loop.advanceTo(300);
      clock = 600; loop.advanceTo(600);
      // Pre-finalize, the whole active line is interim; no prefix to skip yet.
      expect(visibleWords(loop.pushes.at(-1)!).length).toBe(6); // all 6 shown
      // Phrase 1 finalizes (Deepgram is_final / utterance_end). Interim cleared.
      clock = 650;
      d.addFinal(0, PHRASE1);
      loop.updateDisplay();

      const pushesAfterPhrase1 = loop.pushes.length;

      // ── Phrase 2: a short pause, then a new burst (a fresh utterance) ──
      clock = 2000; // the wearer paused ~1.3s, then resumed
      d.updateInterim(0, 'golf hotel india juliet kilo lima mike november');
      loop.updateDisplay();
      // The active block's INTERIM tail shows only the LEADING words of phrase 2
      // — it crawls in, exactly like phrase 1 did (just appended to the same
      // speaker's block). Pre-fix this either showed the whole phrase at once or
      // nothing until the next pause.
      const firstP2 = activeInterimWords(loop.pushes.at(-1)!);
      expect(firstP2).toEqual(['golf', 'hotel']);

      // And — the regression — phrase 2 keeps crawling on ticks alone, with NO
      // further transcript messages, just like phrase 1.
      clock = 2300; loop.advanceTo(2300);
      expect(activeInterimWords(loop.pushes.at(-1)!).length).toBe(4);
      clock = 2600; loop.advanceTo(2600);
      expect(activeInterimWords(loop.pushes.at(-1)!).length).toBe(6);
      clock = 2900; loop.advanceTo(2900);
      expect(activeInterimWords(loop.pushes.at(-1)!).length).toBe(8); // all revealed

      // The crawl produced multiple distinct frames for phrase 2 (it genuinely
      // streamed word-by-word), not a single dump.
      expect(loop.pushes.length).toBeGreaterThan(pushesAfterPhrase1 + 2);
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
