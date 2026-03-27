/** Privacy modes for speaker identification */
export type IdentificationMode = 'anonymous' | 'contacts';

/** A saved contact with voiceprint */
export interface SavedContact {
  id: string;
  name: string;
  embedding: number[];
  createdAt: number;
  lastMatchedAt: number | null;
  sampleDurationMs: number;
  /** Optional auto-expiry in days (null = never) */
  expiryDays: number | null;
}

/** Temporary session label (not persisted) */
export interface SessionLabel {
  speakerIndex: number;
  label: string;
  assignedAt: number;
}

/** GDPR export format */
export interface VoiceprintExport {
  exportedAt: string;
  version: string;
  contacts: Array<{
    id: string;
    name: string;
    createdAt: string;
    lastMatchedAt: string | null;
    embeddingDim: number;
    // Embedding included for portability but is just numbers
    embedding: number[];
  }>;
}
