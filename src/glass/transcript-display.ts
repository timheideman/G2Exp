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
  type CaptureState,
} from './caption-engine';
import { RevealPacer } from './reveal-pacer';

// G2 display constraints (research-validated against the SDK):
//   576×288 px canvas, fixed firmware font, ~35–40 chars/line × up to ~12 lines.
//   A full-screen text container holds ~400–500 chars (≤2000 via upgrade).
const MAX_CHARS = 1800;         // Hard ceiling on the flat string (under the 2000 upgrade limit)
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
  /** Local mirror of the layout config (used to bound the glasses turn window). */
  private config: { maxLines: number; maxLineChars: number };
  /**
   * Paces the interim tail on the GLASSES path so a burst of new words crawls
   * in (~2 per BLE tick) instead of flashing. Glasses-only — the sim shows full
   * text. Injectable clock for tests.
   */
  private revealPacer: RevealPacer;

  constructor(config?: Partial<CaptionEngineConfig>, now: () => number = Date.now) {
    this.engine = new CaptionEngine(config);
    this.config = { maxLines: config?.maxLines ?? 7, maxLineChars: config?.maxLineChars ?? 40 };
    this.revealPacer = new RevealPacer(2, 300, now);
    // The engine resolves tags through our name resolver / letter fallback.
    this.engine.setTagResolver((idx) => this.tagFor(idx));
  }

  /** Adjust the visible line count / wrap width / pacing at runtime. */
  setConfig(config: Partial<CaptionEngineConfig>): void {
    this.engine.setConfig(config);
    if (config.maxLines !== undefined) this.config.maxLines = config.maxLines;
    if (config.maxLineChars !== undefined) this.config.maxLineChars = config.maxLineChars;
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

    // Approx panel geometry only used to bound how many turns we keep — NOT to
    // wrap. Generous so we don't drop content the firmware could still show.
    const approxCharsPerLine = this.config.maxLineChars;
    const maxVisualLines = this.config.maxLines;
    const turns = this.engine.buildTurns(approxCharsPerLine, maxVisualLines);

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

    let output = '';
    const banner = statusBanner(effectiveStatus);
    if (banner) output += `${banner}\n`;

    // Print the [Tag] only when the speaker CHANGES from the previous turn, so a
    // run of consecutive same-speaker turns reads as one labelled block, not a
    // tag stamped on every line. The engine deliberately splits a speaker's
    // successive sentences into separate turns (so each new utterance gets its
    // own fresh interim tail — the streaming fix), but visually they're the same
    // person still talking, so the label should persist, not repeat. A system
    // notice (speaker -1) or a genuine different speaker breaks the run and the
    // next same-speaker turn re-prints its tag.
    let lastSpeaker: number | null = null;
    for (const turn of turns) {
      const sameAsPrev = turn.speaker >= 0 && turn.speaker === lastSpeaker;
      const prefix = turn.tag !== null && turn.speaker >= 0 && !sameAsPrev ? `[${turn.tag}] ` : '';
      const text = turn.interimText
        ? `${turn.finalText}${turn.finalText ? ' ' : ''}${turn.interimText} ━`
        : turn.finalText;
      output += `${prefix}${text}\n`;
      lastSpeaker = turn.speaker;
    }

    // Safety net: keep the flat string under the container ceiling.
    while (output.length > MAX_CHARS) {
      const nl = output.indexOf('\n');
      if (nl === -1) break;
      output = output.slice(nl + 1);
    }

    return output;
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
