/** A single word with timing and speaker info */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker: number;          // Deepgram speaker index (0, 1, 2, ...)
  punctuated_word?: string; // With smart formatting applied
}

/** A complete utterance from one speaker */
export interface Utterance {
  speaker: number;
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
}

/** What we send from server → client over WebSocket */
export interface TranscriptMessage {
  type: 'interim' | 'final' | 'utterance';
  speaker: number;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

/** Rolling transcript state for display */
export interface TranscriptLine {
  speaker: number;
  text: string;
  isFinal: boolean;
}

/** Speaker labels — user can assign names */
export interface SpeakerLabel {
  index: number;
  name: string;     // e.g., "Speaker A", or user-assigned name
  letter: string;   // e.g., "A", "B", "C"
}
