/**
 * Transcript Display Manager
 *
 * The bridge between the transcription stream and what the wearer reads.
 * Owns a CaptionEngine (the stabilized, research-driven layout core) and
 * exposes:
 *
 *  - render(): string — a flat string for the G2 text container and the
 *    simple preview, with [Tag] prefixes, turn markers and an interim cursor.
 *    Kept for backward compatibility and the on-glasses renderer.
 *
 *  - renderFrame(): CaptionFrame — the structured model the DisplaySimulator
 *    uses to render monochrome-safe emphasis (current speaker brighter, interim
 *    dimmer) without re-parsing strings.
 *
 * Why a stable engine matters: live captions that reflow/jump under the
 * reader's gaze cause fatigue and hurt comprehension for DHH users
 * (Liu et al. CHI 2023; Olwal et al. UIST 2020). The engine guarantees
 * finalized words never move; only the trailing interim tail changes.
 */

import type { SpeakerLabel } from '../types/transcript';
import {
  CaptionEngine,
  type CaptionFrame,
  type CaptionEngineConfig,
  type CaptionTurn,
  type CaptureState,
} from './caption-engine';
import { RevealPacer } from './reveal-pacer';

// G2 display constraints (research-validated against the SDK):
//   576×288 px canvas, fixed firmware font, ~35–40 chars/line × up to ~12 lines.
//   A full-screen text container holds ~400–500 chars (≤2000 via upgrade).
const MAX_CHARS = 1800;         // Hard ceiling on the flat string (under the 2000 upgrade limit)

// Soft live-follow window. ON-DEVICE FACT: the firmware text container does NOT
// auto-scroll to the newest text — it appends at the bottom and parks the
// viewport, so anything past the first screenful sits below the fold until the
// wearer manually scrolls (useless for live captions). It DOES render from the
// TOP of whatever content we send. So to keep captions auto-following, we send
// only ~one panel of the most recent text, re-trimmed every render: the live
// tail then always lands within the visible region and older text rolls off the
// top. Sized a touch under the ~400–500-char visible capacity so the tail is
// comfortably on-screen (erring small just leaves a little bottom whitespace —
// safe; erring large parks the tail off-screen — the bug). Approximate by
// design: the proportional firmware font makes an exact char count impossible,
// and we don't need one — this is "about a screen", not a wrap width.
const LIVE_WINDOW_CHARS = 460;
const SPEAKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class TranscriptDisplay {
  private engine: CaptionEngine;
  private speakerLabels: Map<number, SpeakerLabel> = new Map();
  private nextSpeakerIndex = 0;
  /** Optional external name resolver (from SessionLabels) */
  private nameResolver: ((speakerIndex: number) => string) | null = null;
  /** Whether transcription is currently paused */
  private paused = false;
  /** Live pipeline state for the always-visible status indicator. */
  private status: CaptureState = 'connecting';
  /**
   * Paces the interim tail on the GLASSES path so a burst of new words crawls
   * in (~2 per BLE tick) instead of flashing. Glasses-only — the sim shows full
   * text. Injectable clock for tests.
   */
  private revealPacer: RevealPacer;

  constructor(config?: Partial<CaptionEngineConfig>, now: () => number = Date.now) {
    this.engine = new CaptionEngine(config);
    this.revealPacer = new RevealPacer(2, 300, now);
    // The engine resolves tags through our name resolver / letter fallback.
    this.engine.setTagResolver((idx) => this.tagFor(idx));
  }

  /**
   * Adjust layout/pacing at runtime. Only `maxLines`/`maxLineChars` for the
   * browser SIMULATOR path survive here (they drive the engine's pixel-wrapped
   * `buildFrame`); the glasses path no longer models geometry — the firmware
   * wraps and scrolls itself — so these are inert for on-glasses rendering.
   */
  setConfig(config: Partial<CaptionEngineConfig>): void {
    this.engine.setConfig(config);
  }

  /** Set an external name resolver for speaker display names */
  setNameResolver(resolver: (speakerIndex: number) => string): void {
    this.nameResolver = resolver;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Update the live capture/pipeline state shown in the status indicator. */
  setStatus(status: CaptureState): void {
    this.status = status;
  }

  get captureStatus(): CaptureState {
    return this.status;
  }

  /** Get or create a label for a speaker index */
  private getLabel(speakerIndex: number): SpeakerLabel {
    let label = this.speakerLabels.get(speakerIndex);
    if (!label) {
      const letter = SPEAKER_LETTERS[this.nextSpeakerIndex % SPEAKER_LETTERS.length];
      label = { index: speakerIndex, name: `Speaker ${letter}`, letter };
      this.speakerLabels.set(speakerIndex, label);
      this.nextSpeakerIndex++;
    }
    return label;
  }

  /** Allow user to rename a speaker */
  renameSpeaker(speakerIndex: number, name: string): void {
    this.getLabel(speakerIndex).name = name;
  }

  /** Resolve the short tag for a speaker (name resolver wins, else letter). */
  private tagFor(speakerIndex: number): string {
    if (speakerIndex < 0) return '';
    const label = this.getLabel(speakerIndex);
    if (this.nameResolver) {
      const resolved = this.nameResolver(speakerIndex);
      if (resolved) return resolved;
    }
    return label.letter;
  }

  // ─── Ingest ────────────────────────────────────────────────────

  /** Add a finalized transcript line */
  addFinal(speaker: number, text: string): void {
    if (speaker >= 0) this.getLabel(speaker);
    if (speaker < 0) {
      this.engine.addNotice(text);
    } else {
      this.engine.addFinal(speaker, text);
    }
  }

  /**
   * Add a finalized transcript that Deepgram split across speakers (an
   * interruption caught at the word level). Each contiguous same-speaker run
   * becomes its own turn, so the interrupter's words land on their own tagged
   * line. Falls back to addFinal for a degenerate single/empty run set.
   */
  addFinalRuns(runs: Array<{ speaker: number; text: string }>): void {
    const valid = runs.filter((r) => r && typeof r.text === 'string' && r.text.trim());
    if (valid.length === 0) return;
    if (valid.length === 1) {
      this.addFinal(valid[0].speaker, valid[0].text);
      return;
    }
    for (const r of valid) if (r.speaker >= 0) this.getLabel(r.speaker);
    this.engine.addFinalRuns(valid);
  }

  /** Update the current interim (not yet finalized) transcript */
  updateInterim(speaker: number, text: string): void {
    if (speaker >= 0) this.getLabel(speaker);
    this.engine.updateInterim(speaker, text);
  }

  /** Signal an utterance end — finalize any hanging interim */
  onUtteranceEnd(): void {
    this.engine.onUtteranceEnd();
  }

  // ─── Render ────────────────────────────────────────────────────

  /** The structured frame for rich (monochrome-emphasis) rendering. */
  renderFrame(): CaptionFrame {
    const frame = this.engine.buildFrame();
    frame.status = this.paused ? 'paused' : this.status;
    return frame;
  }

  /**
   * Format the transcript as a flat string for the G2 text container.
   *
   * KEY: the G2 firmware word-wraps the container itself, so we must NOT
   * pre-wrap — we emit ONE full-width line per speaker turn and let the panel
   * fill its real width. (Pre-wrapping at a guessed char count was what left the
   * right side of the screen empty.) Each turn:
   *  - "[Name] " tag prefix on the turn (only on speaker change).
   *  - The whole turn's text on one logical line; the firmware wraps it.
   *  - A trailing " ━" while the turn is still being recognized.
   */
  render(opts: { paceReveal?: boolean } = {}): string {
    const effectiveStatus: CaptureState = this.paused ? 'paused' : this.status;

    // One full-width line per turn — no pre-wrap, no chars-per-line guess: the
    // firmware wraps to the real panel width itself. But it does NOT auto-scroll
    // to the newest text (it parks the viewport), so we bound WHAT we send to a
    // rolling ~one-panel live window anchored at the tail (see LIVE_WINDOW_CHARS
    // and the trim below) — that, not a line budget, is what keeps captions
    // auto-following. MAX_CHARS remains the hard backstop.
    const turns = this.engine.buildTurns();

    // Reveal-pacing (glasses only): crawl the active turn's interim tail in a
    // few words per BLE tick instead of flashing a whole burst. The active turn
    // is the LAST one; only its interim is paced. Finals are never paced (the
    // engine clears interim on a final, so finalized text shows in full at once).
    // When pacing is off (sim / tests), the pacer is untouched.
    if (opts.paceReveal && turns.length > 0) {
      const active = turns[turns.length - 1];
      if (active.interimText) {
        const words = active.interimText.split(' ');
        const show = this.revealPacer.visibleCount(words.length);
        active.interimText = words.slice(0, show).join(' ');
      } else {
        this.revealPacer.visibleCount(0); // keep the pacer's run-state in sync
      }
    }

    if (turns.length === 0) {
      const hint = statusHint(effectiveStatus);
      return `${hint}\n\n  Speak and captions\n  will appear here.`;
    }

    // Live-follow window: keep only the most recent turns that fit ~one panel,
    // accumulating from the NEWEST backward so the live tail is always within
    // the visible region (the firmware shows the top of what we send and won't
    // auto-scroll). The active turn (last) is always kept even if it alone
    // exceeds the budget — a long monologue keeps its newest words on-screen;
    // the MAX_CHARS net below still trims within it from the top if needed.
    const windowed = this.recentWithinBudget(turns, LIVE_WINDOW_CHARS);

    let output = '';
    const banner = statusBanner(effectiveStatus);
    if (banner) output += `${banner}\n`;

    // Merge consecutive turns that resolve to the SAME display tag into one
    // continuous block: the tag is printed once, and same-tag turns are joined
    // on the same logical line (a space, not a newline) so the firmware wraps
    // them as one flowing paragraph. This keys on the RESOLVED tag, not the raw
    // Deepgram index — which fixes the mid-sentence line break when the diarizer
    // flips a speaker's index (or a voiceprint renames it) part-way through:
    // "[A] my name is" → "[Tim] my name is" stays one line, because both turns
    // resolve to the same person. The engine deliberately splits a speaker's
    // successive utterances into separate turns (fresh interim tail per
    // utterance — the streaming fix), but visually they're one speaker still
    // talking, so they read as one labelled block. A system notice (speaker -1)
    // or a genuinely different tag breaks the run and re-prints the next tag.
    let lastTag: string | null = null;
    let started = false;
    for (const turn of windowed) {
      const tagKey = turn.speaker >= 0 ? turn.tag : null;
      const sameAsPrev = started && tagKey !== null && tagKey === lastTag;
      const prefix = turn.tag !== null && turn.speaker >= 0 && !sameAsPrev ? `[${turn.tag}] ` : '';
      const text = turn.interimText
        ? `${turn.finalText}${turn.finalText ? ' ' : ''}${turn.interimText} ━`
        : turn.finalText;
      // Same-tag continuation joins the previous block with a space; a new
      // tag (or the first turn) starts on its own line.
      const sep = started ? (sameAsPrev ? ' ' : '\n') : '';
      output += `${sep}${prefix}${text}`;
      lastTag = tagKey;
      started = true;
    }
    output += '\n';

    // Safety net: keep the flat string under the container ceiling.
    while (output.length > MAX_CHARS) {
      const nl = output.indexOf('\n');
      if (nl === -1) break;
      output = output.slice(nl + 1);
    }

    return output;
  }

  /**
   * Keep the most recent turns whose combined rendered length fits `budget`
   * characters, accumulating from the NEWEST backward. The last (active) turn
   * is always included even if it alone exceeds the budget, so the live tail is
   * never dropped. Returns the kept turns in chronological order (oldest first).
   *
   * This is the live-follow window: the firmware renders from the top of what
   * we send and won't auto-scroll, so bounding the payload to ~one panel keeps
   * the tail on-screen and rolls older text off the top. The per-turn estimate
   * mirrors what `render()` emits (tag prefix + finals + interim); it's
   * approximate (proportional font) and that's fine — this is "about a screen".
   */
  private recentWithinBudget(turns: CaptionTurn[], budget: number): CaptionTurn[] {
    if (turns.length === 0) return turns;
    const cost = (t: CaptionTurn): number => {
      const tagLen = t.tag && t.speaker >= 0 ? t.tag.length + 3 : 0; // "[Tag] "
      const interimLen = t.interimText ? t.interimText.length + 3 : 0; // " … ━"
      return tagLen + t.finalText.length + interimLen + 1; // +1 line separator
    };
    let used = 0;
    let start = turns.length - 1; // always keep the active turn
    used += cost(turns[start]);
    // Walk older turns until the next one would overflow the panel budget.
    for (let i = turns.length - 2; i >= 0; i--) {
      const c = cost(turns[i]);
      if (used + c > budget) break;
      used += c;
      start = i;
    }
    return turns.slice(start);
  }

  /**
   * Whether the glasses reveal pacer is mid-crawl — i.e. the active turn's
   * interim has more recognized words than are currently shown. The app uses
   * this to schedule a follow-up render so a burst's tail keeps revealing even
   * if no new transcript message arrives.
   */
  hasPendingReveal(): boolean {
    return this.revealPacer.hasPending();
  }

  /** Get current speaker labels for the companion UI */
  getSpeakers(): SpeakerLabel[] {
    return Array.from(this.speakerLabels.values());
  }

  /** Clear all transcript data */
  clear(): void {
    this.engine.clear();
    this.speakerLabels.clear();
    this.nextSpeakerIndex = 0;
    this.revealPacer.reset();
  }
}

/** Placeholder shown on the empty screen, reflecting the live state. */
function statusHint(status: CaptureState): string {
  switch (status) {
    case 'listening':
      return '  ● Listening…';
    case 'connecting':
      return '  ◌ Connecting…';
    case 'paused':
      return '  ⏸ Paused';
    case 'no-audio':
      return '  ◌ No audio — check mic';
    case 'error':
      return '  ✕ Captioning unavailable';
  }
}

/**
 * One-line banner for an ABNORMAL state, drawn above active captions.
 * Returns '' for the normal 'listening' state (flowing text is the signal).
 */
function statusBanner(status: CaptureState): string {
  switch (status) {
    case 'listening':
      return '';
    case 'connecting':
      return '◌ reconnecting…';
    case 'paused':
      return '⏸ paused';
    case 'no-audio':
      return '◌ no audio';
    case 'error':
      return '✕ captioning unavailable';
  }
}
