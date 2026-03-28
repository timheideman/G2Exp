/**
 * Transcript Display Manager
 *
 * Manages the rolling transcript display on G2 glasses.
 * Formats diarized transcription into a readable scrolling view
 * within the 576×288 px, ~400-500 char text container.
 */

import type { TranscriptLine, SpeakerLabel } from '../types/transcript';

// G2 display constraints
const MAX_CHARS = 900;          // Stay under 1000 char limit with margin
const MAX_LINES_STORED = 50;    // Rolling buffer of transcript lines
const SPEAKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class TranscriptDisplay {
  private lines: TranscriptLine[] = [];
  private interimLine: TranscriptLine | null = null;
  private speakerLabels: Map<number, SpeakerLabel> = new Map();
  private nextSpeakerIndex = 0;
  /** Optional external name resolver (from SessionLabels) */
  private nameResolver: ((speakerIndex: number) => string) | null = null;
  /** Whether transcription is currently paused */
  private paused: boolean = false;

  /** Set an external name resolver for speaker display names */
  setNameResolver(resolver: (speakerIndex: number) => string): void {
    this.nameResolver = resolver;
  }

  /**
   * Mark the display as paused or active.
   * When paused, render() appends a "⏸ Paused" marker that the display
   * simulator can pick up for overlay rendering.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Whether the display is currently in paused state */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Get or create a label for a speaker index */
  private getLabel(speakerIndex: number): SpeakerLabel {
    let label = this.speakerLabels.get(speakerIndex);
    if (!label) {
      const letter = SPEAKER_LETTERS[this.nextSpeakerIndex % SPEAKER_LETTERS.length];
      label = {
        index: speakerIndex,
        name: `Speaker ${letter}`,
        letter,
      };
      this.speakerLabels.set(speakerIndex, label);
      this.nextSpeakerIndex++;
    }
    return label;
  }

  /** Allow user to rename a speaker */
  renameSpeaker(speakerIndex: number, name: string): void {
    const label = this.getLabel(speakerIndex);
    label.name = name;
  }

  /** Add a finalized transcript line */
  addFinal(speaker: number, text: string): void {
    // Ensure speaker is registered
    this.getLabel(speaker);

    // If last line is same speaker, append to it
    const lastLine = this.lines[this.lines.length - 1];
    if (lastLine && lastLine.speaker === speaker && lastLine.isFinal) {
      lastLine.text += ' ' + text;
    } else {
      this.lines.push({ speaker, text, isFinal: true });
    }

    // Trim rolling buffer
    if (this.lines.length > MAX_LINES_STORED) {
      this.lines = this.lines.slice(-MAX_LINES_STORED);
    }

    // Clear interim if it matches
    if (this.interimLine && this.interimLine.speaker === speaker) {
      this.interimLine = null;
    }
  }

  /** Update the current interim (not yet finalized) transcript */
  updateInterim(speaker: number, text: string): void {
    this.interimLine = { speaker, text, isFinal: false };
  }

  /** Signal an utterance end — finalize any hanging interim */
  onUtteranceEnd(): void {
    if (this.interimLine) {
      this.addFinal(this.interimLine.speaker, this.interimLine.text);
      this.interimLine = null;
    }
  }

  /** Format the transcript for G2 text container display */
  render(): string {
    const allLines = [...this.lines];
    if (this.interimLine) {
      allLines.push(this.interimLine);
    }

    if (allLines.length === 0) {
      return '  Listening...\n\n  Speak and captions\n  will appear here.';
    }

    // Build display string, most recent at bottom
    let output = '';
    let lastSpeaker = -1;

    for (const line of allLines) {
      const label = this.getLabel(line.speaker);
      // Use external name resolver if available, else fall back to letter
      const tag = this.nameResolver && line.speaker >= 0
        ? this.nameResolver(line.speaker)
        : label.letter;
      const prefix = line.speaker !== lastSpeaker ? `[${tag}] ` : '    ';
      const suffix = line.isFinal ? '' : ' ━'; // Blinking cursor for interim
      const lineText = `${prefix}${line.text}${suffix}\n`;
      output += lineText;
      lastSpeaker = line.speaker;
    }

    // Trim from the top if too long — keep most recent text visible
    while (output.length > MAX_CHARS) {
      const firstNewline = output.indexOf('\n');
      if (firstNewline === -1) break;
      output = output.slice(firstNewline + 1);
    }

    return output;
  }

  /** Get current speaker labels for the companion UI */
  getSpeakers(): SpeakerLabel[] {
    return Array.from(this.speakerLabels.values());
  }

  /** Clear all transcript data */
  clear(): void {
    this.lines = [];
    this.interimLine = null;
    this.speakerLabels.clear();
    this.nextSpeakerIndex = 0;
  }
}
