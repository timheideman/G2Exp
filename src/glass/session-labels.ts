/**
 * SessionLabels — Temporary speaker labels for current session
 *
 * Allows the wearer to label speakers during a conversation
 * (e.g., "Doctor", "Cashier") without creating a voiceprint.
 * Labels are discarded when the session ends.
 */

import type { SessionLabel } from '../types/privacy';

const SPEAKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class SessionLabels {
  private labels: Map<number, SessionLabel> = new Map();
  private identifiedNames: Map<number, string> = new Map();

  /** Set a temporary label for a speaker index */
  setLabel(speakerIndex: number, label: string): void {
    this.labels.set(speakerIndex, {
      speakerIndex,
      label,
      assignedAt: Date.now(),
    });
  }

  /** Set a permanent name (from voiceprint match) */
  setIdentified(speakerIndex: number, name: string): void {
    this.identifiedNames.set(speakerIndex, name);
  }

  /**
   * Withdraw a server-resolved identification for a speaker index. Called when
   * the resolver reassigns a name to another index (e.g. after a diarization
   * flip) — showing a stale duplicate name is worse than reverting to a letter.
   */
  clearIdentified(speakerIndex: number): void {
    this.identifiedNames.delete(speakerIndex);
  }

  /**
   * Apply a server-resolved speaker identification.
   *
   * Called when the server sends a `speaker_identified` message after
   * matching audio against the voiceprint store. Updates the session
   * display name for the given speaker index so the glasses show the
   * contact's name instead of a generic letter.
   *
   * @param speakerIndex  Deepgram speaker index (0-based)
   * @param name          Resolved contact name from the voiceprint match
   * @param voiceprintId  ID of the matched voiceprint, or null if unavailable
   */
  applyServerIdentification(
    speakerIndex: number,
    name: string,
    voiceprintId: string | null,
  ): void {
    this.setIdentified(speakerIndex, name);
    // voiceprintId is available for callers that need to cross-reference
    // the contact store (e.g., to update lastMatchedAt in the UI).
    // We don't persist it here since SessionLabels is session-scoped.
    void voiceprintId;
  }

  /** Remove a temporary label */
  removeLabel(speakerIndex: number): void {
    this.labels.delete(speakerIndex);
  }

  /** Get the display name for a speaker, with priority:
   *  1. Voiceprint-identified name (from contacts mode)
   *  2. User-assigned session label
   *  3. Default letter (A, B, C...)
   */
  getDisplayName(speakerIndex: number): string {
    // System messages (speaker -1)
    if (speakerIndex < 0) return '';

    const identified = this.identifiedNames.get(speakerIndex);
    if (identified) return identified;

    const label = this.labels.get(speakerIndex);
    if (label) return label.label;

    return `Speaker ${SPEAKER_LETTERS[speakerIndex % SPEAKER_LETTERS.length]}`;
  }

  /** Get the short tag for display on glasses (max ~8 chars) */
  getShortTag(speakerIndex: number): string {
    if (speakerIndex < 0) return '';

    const identified = this.identifiedNames.get(speakerIndex);
    if (identified) {
      // Use first name or truncate
      const firstName = identified.split(' ')[0];
      return firstName.length <= 8 ? firstName : firstName.slice(0, 7) + '.';
    }

    const label = this.labels.get(speakerIndex);
    if (label) {
      return label.label.length <= 8 ? label.label : label.label.slice(0, 7) + '.';
    }

    return SPEAKER_LETTERS[speakerIndex % SPEAKER_LETTERS.length];
  }

  /** Get all current labels (for UI display) */
  getAllLabels(): Array<{ speakerIndex: number; name: string; type: 'identified' | 'labeled' | 'anonymous' }> {
    const result: Array<{ speakerIndex: number; name: string; type: 'identified' | 'labeled' | 'anonymous' }> = [];
    const allIndices = new Set([
      ...this.identifiedNames.keys(),
      ...this.labels.keys(),
    ]);

    for (const idx of allIndices) {
      if (this.identifiedNames.has(idx)) {
        result.push({ speakerIndex: idx, name: this.identifiedNames.get(idx)!, type: 'identified' });
      } else if (this.labels.has(idx)) {
        result.push({ speakerIndex: idx, name: this.labels.get(idx)!.label, type: 'labeled' });
      }
    }

    return result.sort((a, b) => a.speakerIndex - b.speakerIndex);
  }

  /** Clear all session data */
  reset(): void {
    this.labels.clear();
    this.identifiedNames.clear();
  }
}
