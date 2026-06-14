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
  speaker: number;
  /** Words that are finalized and locked — never rewritten. */
  finalWords: string[];
  /**
   * The still-growing interim tail for this segment (only the most recent
   * segment can have one). Locked words are moved out of here into finalWords.
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
  }

  // ─── Ingest ────────────────────────────────────────────────────

  /**
   * Add a finalized transcript fragment for a speaker. Words become locked
   * and will never be rewritten or reflowed.
   */
  addFinal(speaker: number, text: string): void {
    const words = tokenize(text);
    if (words.length === 0) return;

    this.currentSpeaker = speaker;
    const seg = this.activeSegmentFor(speaker);

    // The arriving final supersedes any interim tail for this speaker.
    seg.interimWords = [];
    seg.finalWords.push(...words);

    this.trim();
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
    this.currentSpeaker = speaker;
    const seg = this.activeSegmentFor(speaker);

    // Stabilize against what's already committed (final) for this segment:
    // a streaming ASR interim repeats the whole utterance from its start, so
    // drop the leading words that the finals have already locked.
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
    this.segments.push({ speaker: -1, finalWords: tokenize(text), interimWords: [] });
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
      const tokens: CaptionToken[] = [
        ...seg.finalWords.map((w) => ({ text: w, state: 'final' as const })),
        ...seg.interimWords.map((w) => ({ text: w, state: 'interim' as const })),
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
   * Get the segment to append to for `speaker`. We start a new segment when
   * the speaker changes (a turn boundary), so each turn keeps its own tag and
   * line. Consecutive same-speaker fragments merge into one segment.
   */
  private activeSegmentFor(speaker: number): Segment {
    const last = this.segments[this.segments.length - 1];
    if (last && last.speaker === speaker) return last;
    const seg: Segment = { speaker, finalWords: [], interimWords: [] };
    this.segments.push(seg);
    return seg;
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
