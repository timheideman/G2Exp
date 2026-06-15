/**
 * CaptionEngine — evidence-based caption layout + stabilization for DHH readers
 *
 * This is the heart of the on-glasses reading experience. It is deliberately
 * pure (no DOM, no canvas, no SDK) so it can be unit-tested exhaustively and
 * reused by both the real glasses renderer and the browser simulator.
 *
 * Design is grounded in research on live captions for deaf/hard-of-hearing
 * users on heads-up displays:
 *
 *  - Stable, fixed-height rolling window of N lines (default 3) — not a
 *    paragraph that grows. Liu et al. (Google, CHI 2023) and Olwal et al.
 *    (Google, UIST 2020): re-flowing/jumping caption text causes measurable
 *    fatigue (and even headaches). The viewport never reflows finalized text.
 *
 *  - Interim (still-being-recognized) text is shown for low latency, but
 *    STABILIZED: once a word has been on screen, it is "committed" and never
 *    rewritten. Only the trailing, still-growing tail can change, and we only
 *    accept a new interim hypothesis when it extends (or meaningfully revises)
 *    what we already showed — preventing the words-shuffling-under-your-eyes
 *    flicker that destroys trust and comprehension.
 *
 *  - Word-by-word reveal onto a stable line window (the BBC live "scrolling
 *    word" model + the "karaoke" mode that scored best in Samaradivakara 2025).
 *
 *  - Phrase-boundary line wrapping: break after punctuation / at word
 *    boundaries, never mid-word (Kushalnagar SubtitleFormatter 2018).
 *
 *  - Reading-rate pacing: finalized words are revealed at a comfortable
 *    cadence (~capped wpm) rather than dumped, so the reader is never
 *    overrun (Jensema 1998: trouble begins ≥170 wpm; AR reads slower still).
 *
 * The engine exposes a plain data model (`CaptionFrame`) describing exactly
 * what should be on screen. Renderers turn that into characters/pixels.
 */

export type CaptionTokenState = 'final' | 'interim';

/** One word as it should appear, with its stability state. */
export interface CaptionToken {
  text: string;
  state: CaptionTokenState;
  /**
   * Stable identity for this token across frames, so a renderer can tell a
   * newly-arrived word from one that was already on screen (and animate only
   * the former). Derived from (turn, word-position, text): a word keeps the
   * same key when its interim is re-sliced or promoted to final, so settled
   * text never re-animates. Optional — only `buildFrame` populates it.
   */
  key?: string;
}

/** A single visual line in the caption viewport. */
export interface CaptionLine {
  /** Speaker index this line belongs to (-1 = system/notice). */
  speaker: number;
  /**
   * Speaker tag to print at the start of the line, or null if this line is a
   * continuation of the same speaker (no repeated tag). Resolved to a display
   * name by the caller via the name resolver.
   */
  tag: string | null;
  /** Whether this is the currently-/most-recently-speaking turn (for emphasis). */
  isCurrentSpeaker: boolean;
  /** The words on this line, each tagged final/interim. */
  tokens: CaptionToken[];
}

/**
 * Live pipeline state, surfaced to the reader so captioning never fails
 * silently — the #1 caption-product anti-pattern (XRAI cautionary tale;
 * Android Live Transcribe's audio-pickup indicator is the model).
 */
export type CaptureState =
  | 'listening' // mic active + server connected + transcribing
  | 'connecting' // establishing / reconnecting to the server
  | 'paused' // wearer paused capture
  | 'no-audio' // connected but no audio detected for a while
  | 'error'; // server/STT error — captions are NOT flowing

/**
 * One unwrapped speaker turn for the G2 text container (which wraps itself).
 * Full-width: we do NOT pre-break the text.
 */
export interface CaptionTurn {
  speaker: number;
  tag: string | null;
  isCurrentSpeaker: boolean;
  finalText: string;
  interimText: string;
}

/**
 * One contiguous same-speaker run of words from a single transcript — the
 * word-level diarization Deepgram emits. A transcript with an interruption
 * yields several runs (e.g. [{speaker:0,text:"so what i think"},
 * {speaker:1,text:"no that's wrong"}]); a normal single-speaker one yields one.
 */
export interface SpeakerRun {
  speaker: number;
  text: string;
}

/** The complete, ready-to-render caption state. */
export interface CaptionFrame {
  lines: CaptionLine[];
  /** Live capture/pipeline state for the status indicator (optional). */
  status?: CaptureState;
}

/** Configuration for the caption viewport. */
export interface CaptionEngineConfig {
  /** Number of visible lines in the rolling window. Default 3. */
  maxLines: number;
  /** Max characters per line before wrapping (incl. tag). Default 30. */
  maxLineChars: number;
  /**
   * Reveal rate cap for finalized words, in words/minute. Words finalize
   * faster than this are queued and revealed at this pace so the reader is
   * never overrun. 0 disables pacing (reveal immediately). Default 0
   * (renderer/caller drives timing); see `pendingWordCount`.
   */
  maxWordsPerMinute: number;
}

export const DEFAULT_CAPTION_CONFIG: CaptionEngineConfig = {
  maxLines: 3,
  maxLineChars: 30,
  maxWordsPerMinute: 0,
};

/** Internal: a committed segment of speech from one speaker. */
interface Segment {
  /**
   * Monotonic id assigned at creation, stable across trims. Used to mint stable
   * per-token keys so a renderer doesn't re-animate settled text when the
   * segment array is sliced.
   */
  seq: number;
  speaker: number;
  /** Words that are finalized and locked — never rewritten. */
  finalWords: string[];
  /**
   * The still-growing interim tail for this segment. Interim words live only in
   * TRAILING segments, but an interruption can leave more than one trailing
   * segment interim at once (e.g. A's tail + B's interjection both unsettled
   * until they finalize). Locked words are moved out of here into finalWords.
   */
  interimWords: string[];
}

/** Resolve a speaker index to a short display tag (≤ ~10 chars). */
export type TagResolver = (speakerIndex: number) => string;

export class CaptionEngine {
  private config: CaptionEngineConfig;
  private segments: Segment[] = [];
  /** The speaker whose turn is "current" (last to produce final/interim). */
  private currentSpeaker = -1;
  private tagResolver: TagResolver | null = null;
  /** Monotonic segment id source (for stable per-token keys across trims). */
  private nextSeq = 0;

  // Cap how much history we retain internally (the viewport shows far less).
  private static readonly MAX_SEGMENTS = 40;

  constructor(config: Partial<CaptionEngineConfig> = {}) {
    this.config = { ...DEFAULT_CAPTION_CONFIG, ...config };
  }

  setConfig(config: Partial<CaptionEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setTagResolver(resolver: TagResolver | null): void {
    this.tagResolver = resolver;
  }

  /** Reset everything (new session / clear). */
  clear(): void {
    this.segments = [];
    this.currentSpeaker = -1;
    // nextSeq is intentionally NOT reset — keeping it monotonic across a clear
    // guarantees post-clear segments can't collide token keys with a stale
    // pre-clear frame still being animated by the renderer.
  }

  // ─── Ingest ────────────────────────────────────────────────────

  /**
   * Add a finalized transcript fragment for a speaker. Words become locked
   * and will never be rewritten or reflowed.
   */
  addFinal(speaker: number, text: string): void {
    const words = tokenize(text);
    if (words.length === 0) return;
    this.ingestFinalRun(speaker, words);
    this.trim();
  }

  /**
   * Finalize a sequence of speaker-tagged RUNS from one transcript — the
   * word-level diarization Deepgram already provides. When a single utterance
   * contains words from more than one speaker (an interruption: "…and then I —
   * no wait, that's wrong"), each contiguous same-speaker run becomes its own
   * turn, so the interrupter's words break onto their own tagged line instead
   * of being appended to the interrupted speaker. A single-run final behaves
   * exactly like addFinal(). Runs are applied in order; same-speaker adjacent
   * runs merge naturally via segmentFor.
   */
  addFinalRuns(runs: SpeakerRun[]): void {
    let ingested = false;
    for (const run of runs) {
      const words = tokenize(run.text);
      if (words.length === 0) continue;
      this.ingestFinalRun(run.speaker, words);
      ingested = true;
    }
    if (ingested) this.trim();
  }

  /** Lock one run's words onto its segment (relabel-aware). No trim. */
  private ingestFinalRun(speaker: number, words: string[]): void {
    const { seg, isRelabel } = this.segmentFor(speaker, words);
    this.currentSpeaker = seg.speaker;

    // The arriving final supersedes any interim tail for this speaker.
    seg.interimWords = [];
    if (isRelabel) {
      // Re-diarization of the active turn: the diarizer moved these same words
      // to `speaker`. The segment ALREADY holds this utterance (under the old
      // index) — we relabelled it in place rather than opening a duplicate line.
      // Append only the genuinely-new tail this final adds beyond what's locked,
      // so we neither drop words nor print them twice.
      const have = seg.finalWords.length;
      if (words.length > have) seg.finalWords.push(...words.slice(have));
    } else {
      seg.finalWords.push(...words);
    }
  }

  /**
   * Update the interim (still-being-recognized) tail for a speaker. We
   * stabilize: any prefix of the interim that has "settled" (i.e. the new
   * hypothesis still agrees with what we already displayed) stays put; only
   * the genuinely new/changed trailing words move. This is what prevents the
   * flicker of words rewriting themselves under the reader's gaze.
   */
  updateInterim(speaker: number, text: string): void {
    const words = tokenize(text);
    const { seg, isRelabel } = this.segmentFor(speaker, words);

    // A streaming ASR interim repeats its OWN utterance from the start, so when
    // the active turn already has locked finals we normally drop the leading
    // words those finals cover and keep only the growing tail. But that holds
    // ONLY while the interim is still the SAME utterance — i.e. it still replays
    // the locked words. After an utterance finalizes and the same speaker starts
    // a NEW sentence, Deepgram's fresh interim does NOT replay the old finalized
    // words; blindly slicing it at finalWords.length would swallow its first
    // words. We detect a new utterance by its interim no longer sharing even the
    // first locked word, and start a fresh turn for the speaker instead. (A mere
    // tail revision within the same utterance still shares the leading word, so
    // this never fires spuriously on normal continuation.)
    //
    // EXCEPT when this interim is a RE-DIARIZATION of the active turn (the
    // diarizer flipped the speaker index mid-utterance — `isRelabel`). Then
    // `segmentFor` has already relabelled the existing segment in place; these
    // are the SAME words under a new index, so we must NOT open a fresh turn or
    // the line breaks mid-sentence (the exact "new line when my name was
    // assigned" bug). We fall through and re-stabilize the tail in place.
    if (
      !isRelabel &&
      seg.finalWords.length > 0 &&
      words.length > 0 &&
      words[0] !== seg.finalWords[0]
    ) {
      const fresh: Segment = { seq: this.nextSeq++, speaker, finalWords: [], interimWords: [] };
      this.segments.push(fresh);
      this.trim();
      this.currentSpeaker = fresh.speaker;
      // The new utterance's whole interim is its tail (nothing locked yet).
      if (!sameWords(fresh.interimWords, words)) fresh.interimWords = words;
      return;
    }
    this.currentSpeaker = seg.speaker;

    // Stabilize against what's already committed (final) for this segment: drop
    // the leading words the finals have already locked, keep the changed tail.
    const lockedCount = seg.finalWords.length;
    const tail = words.slice(lockedCount);

    // Only update the interim tail if it actually changed — avoids redundant
    // re-renders and the subtle jitter of identical re-emits.
    if (!sameWords(seg.interimWords, tail)) {
      seg.interimWords = tail;
    }
  }

  /**
   * Finalize any hanging interim — e.g. on Deepgram's utterance_end. The
   * interim tail (already on screen) is promoted to locked words in place,
   * with zero visual movement.
   */
  onUtteranceEnd(): void {
    const seg = this.segments[this.segments.length - 1];
    if (seg && seg.interimWords.length > 0) {
      seg.finalWords.push(...seg.interimWords);
      seg.interimWords = [];
    }
  }

  /** Append a system notice line (e.g. "Paused"), speaker -1. */
  addNotice(text: string): void {
    this.segments.push({ seq: this.nextSeq++, speaker: -1, finalWords: tokenize(text), interimWords: [] });
    this.currentSpeaker = -1;
    this.trim();
  }

  // ─── Query ─────────────────────────────────────────────────────

  /** Distinct speaker indices seen so far, in first-seen order. */
  getSpeakers(): number[] {
    const seen: number[] = [];
    for (const s of this.segments) {
      if (s.speaker >= 0 && !seen.includes(s.speaker)) seen.push(s.speaker);
    }
    return seen;
  }

  get activeSpeaker(): number {
    return this.currentSpeaker;
  }

  /**
   * Build the stable caption frame: the last `maxLines` visual lines of the
   * rolling window, with phrase-boundary wrapping, speaker tags only on turn
   * change, and current-speaker emphasis.
   */
  buildFrame(): CaptionFrame {
    const allLines: CaptionLine[] = [];

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      // Key each word by (segment-seq, absolute word position): a word keeps its
      // key when its interim is re-sliced or promoted to final, so the renderer
      // can animate only genuinely-new words and never re-fade settled text.
      const tokens: CaptionToken[] = [
        ...seg.finalWords.map((w, p) => ({ text: w, state: 'final' as const, key: `${seg.seq}:${p}` })),
        ...seg.interimWords.map((w, p) => ({
          text: w, state: 'interim' as const, key: `${seg.seq}:${seg.finalWords.length + p}`,
        })),
      ];
      if (tokens.length === 0) continue;

      const tag = seg.speaker >= 0 ? this.resolveTag(seg.speaker) : '';
      const isCurrent = seg.speaker === this.currentSpeaker && seg.speaker >= 0;

      // Wrap this segment into visual lines. The tag prefix occupies space on
      // the first wrapped line only; continuation lines are indent-aligned.
      const wrapped = wrapTokens(tokens, this.config.maxLineChars, tag);
      for (let w = 0; w < wrapped.length; w++) {
        allLines.push({
          speaker: seg.speaker,
          tag: w === 0 ? (seg.speaker >= 0 ? tag : null) : null,
          isCurrentSpeaker: isCurrent,
          tokens: wrapped[w],
        });
      }
    }

    // Keep only the most recent `maxLines` — the stable viewport.
    const visible = allLines.slice(-this.config.maxLines);
    return { lines: visible };
  }

  /**
   * Build the rolling window as UNWRAPPED turns — one entry per speaker turn,
   * words joined into a single string.
   *
   * We deliberately do NOT model the panel's geometry here. The G2 text
   * container is the sole authority on its own layout: it word-wraps at the
   * real panel edge (proportional firmware font — a guessed chars-per-line is
   * meaningless) and, on overflow, scrolls/clips itself. So we emit every
   * retained turn full-width and let the firmware wrap, scroll and clip. The
   * only bound that physically exists is the SDK's content ceiling, enforced
   * downstream in `render()` (which trims from the TOP, favouring the newest
   * text the reader is actively following). There is no line budget and no
   * char-per-line estimate — those were the source of the "wraps too early /
   * only ~5 lines / right side empty" bugs, because the estimate (38 cpl) ran
   * at roughly half the panel's true width and over-counted every turn.
   */
  buildTurns(): CaptionTurn[] {
    const turns: CaptionTurn[] = [];
    for (const seg of this.segments) {
      const finals = seg.finalWords.join(' ');
      const interims = seg.interimWords.join(' ');
      if (!finals && !interims) continue;
      turns.push({
        speaker: seg.speaker,
        tag: seg.speaker >= 0 ? this.resolveTag(seg.speaker) : null,
        isCurrentSpeaker: seg.speaker === this.currentSpeaker && seg.speaker >= 0,
        finalText: finals,
        interimText: interims,
      });
    }
    return turns;
  }

  /** Total words currently waiting in interim tails (for pacing/diagnostics). */
  get pendingWordCount(): number {
    return this.segments.reduce((n, s) => n + s.interimWords.length, 0);
  }

  // ─── Internals ─────────────────────────────────────────────────

  private resolveTag(speaker: number): string {
    if (this.tagResolver) return this.tagResolver(speaker);
    return letterFor(speaker);
  }

  /**
   * Resolve the segment to ingest into for `speaker`, given the fragment's
   * `words`. Three cases:
   *
   *  1. Same speaker as the active turn → append to it (the common case;
   *     consecutive same-speaker fragments merge into one turn/tag).
   *
   *  2. DIFFERENT speaker, but the fragment is a RE-DIARIZATION of the active
   *     turn — Deepgram's streaming diarizer moved the *same words* to a new
   *     index mid-utterance (it warns these indices are unstable: a speaker can
   *     flip index). We must NOT open a second line, or the reader sees the
   *     utterance twice under two tags ("[B] …" then "[Alice] …"). Instead we
   *     relabel the existing segment in place: its words (and stable per-token
   *     keys, since `seq` is preserved) stay put; only `speaker` flips, so the
   *     next frame re-resolves the tag. Returned with isRelabel=true so the
   *     caller appends only the new tail rather than duplicating the words.
   *
   *  3. DIFFERENT speaker with unrelated words → a genuine turn boundary; open
   *     a new segment (its own tag + line), as before.
   */
  private segmentFor(speaker: number, words: string[]): { seg: Segment; isRelabel: boolean } {
    const last = this.segments[this.segments.length - 1];
    if (last && last.speaker === speaker) return { seg: last, isRelabel: false };

    if (last && last.speaker >= 0 && speaker >= 0 && this.isRediarization(last, words)) {
      last.speaker = speaker;
      return { seg: last, isRelabel: true };
    }

    const seg: Segment = { seq: this.nextSeq++, speaker, finalWords: [], interimWords: [] };
    this.segments.push(seg);
    return { seg, isRelabel: false };
  }

  /**
   * Decide whether an incoming fragment for a *different* index is the diarizer
   * re-attributing the active turn's own words (same utterance, new index)
   * rather than a new speaker's turn. True when the fragment and the segment's
   * current words share a positional prefix: the shorter of the two sequences
   * matches the other word-for-word from the start. Deepgram re-emits an
   * utterance from its beginning, so a re-diarized fragment lines up positionally
   * with what we already showed; an unrelated new turn does not.
   *
   * Requiring a *full*-prefix match (not just the first word) keeps a genuine
   * new turn that happens to open with a repeated word ("Yeah…", "So…") from
   * being swallowed into the previous speaker's line.
   */
  private isRediarization(seg: Segment, words: string[]): boolean {
    if (words.length === 0) return false;
    const existing = seg.finalWords.length > 0 || seg.interimWords.length > 0
      ? [...seg.finalWords, ...seg.interimWords]
      : [];
    if (existing.length === 0) return false;

    const n = Math.min(existing.length, words.length);
    for (let i = 0; i < n; i++) {
      if (existing[i] !== words[i]) return false;
    }
    return true;
  }

  private trim(): void {
    if (this.segments.length > CaptionEngine.MAX_SEGMENTS) {
      this.segments = this.segments.slice(-CaptionEngine.MAX_SEGMENTS);
    }
  }
}

// ─── Pure helpers (exported for testing) ─────────────────────────

const SPEAKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function letterFor(speaker: number): string {
  return SPEAKER_LETTERS[speaker % SPEAKER_LETTERS.length];
}

/** Split text into words, collapsing whitespace. */
export function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sameWords(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Wrap a flat list of tokens into visual lines that each fit within
 * `maxChars`, breaking only at word boundaries (never mid-word). The first
 * line reserves room for `[tag] ` if a tag is given; continuation lines use an
 * equivalent indent so wrapped text aligns under the speech, not the tag.
 *
 * Returns an array of lines, each a list of tokens (state preserved).
 */
export function wrapTokens(
  tokens: CaptionToken[],
  maxChars: number,
  tag: string,
): CaptionToken[][] {
  const tagPrefixLen = tag ? `[${tag}] `.length : 0;
  const indentLen = tag ? tagPrefixLen : 0;

  const lines: CaptionToken[][] = [];
  let current: CaptionToken[] = [];
  let lineLen = tagPrefixLen; // first line starts after the tag

  const flush = () => {
    lines.push(current);
    current = [];
    lineLen = indentLen; // continuation lines are indented to align
  };

  for (const tok of tokens) {
    const wordLen = tok.text.length;
    // +1 for the separating space, but not before the first word on a line.
    const sep = current.length > 0 ? 1 : 0;

    if (current.length > 0 && lineLen + sep + wordLen > maxChars) {
      flush();
    }

    // Hard case: a single token longer than the whole line. Place it alone;
    // we don't split mid-word (research: never break mid-word). The renderer's
    // own char wrap is the final safety net.
    current.push(tok);
    lineLen += (current.length > 1 ? 1 : 0) + wordLen;
  }
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) lines.push([]);
  return lines;
}
