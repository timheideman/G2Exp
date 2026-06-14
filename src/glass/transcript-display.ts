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

  constructor(config?: Partial<CaptionEngineConfig>) {
    this.engine = new CaptionEngine(config);
    // The engine resolves tags through our name resolver / letter fallback.
    this.engine.setTagResolver((idx) => this.tagFor(idx));
  }

  /** Adjust the visible line count / wrap width / pacing at runtime. */
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
   * Layout rules (research-driven):
   *  - Speaker tag `[Name]` printed only on a turn change, prefixed with a
   *    turn marker `— ` (monochrome-safe "new speaker" cue, à la BBC dash).
   *  - Continuation lines are indented to align under the speech.
   *  - The still-being-recognized interim tail ends with a ` ━` cursor.
   */
  render(): string {
    const frame = this.engine.buildFrame();
    const effectiveStatus: CaptureState = this.paused ? 'paused' : this.status;

    if (frame.lines.length === 0) {
      const hint = statusHint(effectiveStatus);
      return `${hint}\n\n  Speak and captions\n  will appear here.`;
    }

    let output = '';

    // Always surface an abnormal pipeline state at the top — captioning must
    // never fail silently. In the normal 'listening' state the flowing text is
    // itself the signal, so we don't clutter it.
    const banner = statusBanner(effectiveStatus);
    if (banner) output += `${banner}\n`;

    for (const line of frame.lines) {
      const words = line.tokens.map((t) => t.text).join(' ');
      const hasInterim = line.tokens.some((t) => t.state === 'interim');

      // Tight labels to save horizontal space on the fixed-font panel: the
      // speaker name is "[Name] " on a turn change (no dash marker), and
      // continuation lines use a 2-space hang indent rather than aligning under
      // the tag (which wasted ~7 chars of every wrapped line).
      let prefix: string;
      if (line.tag !== null && line.speaker >= 0) {
        prefix = `[${line.tag}] `;
      } else if (line.speaker >= 0) {
        prefix = '  '; // continuation hang indent
      } else {
        prefix = ''; // system notice
      }

      const suffix = hasInterim ? ' ━' : '';
      output += `${prefix}${words}${suffix}\n`;
    }

    // Safety net: keep the flat string under the container ceiling.
    while (output.length > MAX_CHARS) {
      const nl = output.indexOf('\n');
      if (nl === -1) break;
      output = output.slice(nl + 1);
    }

    return output;
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
