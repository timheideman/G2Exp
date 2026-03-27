/** A stored voiceprint for a known speaker */
export interface Voiceprint {
  id: string;
  name: string;
  embedding: number[];       // 192-dim vector (resemblyzer) or 256-dim (speechbrain)
  createdAt: number;
  sampleDurationMs: number;
}

/** Result of a speaker identification attempt */
export interface SpeakerMatch {
  speakerIndex: number;      // Deepgram's diarization index (0, 1, 2...)
  voiceprintId: string | null;
  name: string;              // Resolved name or fallback "Speaker A"
  confidence: number;        // 0-1 cosine similarity
  isIdentified: boolean;     // true if matched above threshold
}

/** Configuration for the speaker identification system */
export interface SpeakerIdConfig {
  matchThreshold: number;    // Minimum cosine similarity to accept match (default 0.82)
  minAudioMs: number;        // Minimum audio to buffer before attempting match (default 3000)
  maxStoredVoiceprints: number; // Max enrolled speakers (default 50)
  embeddingDim: number;      // Expected embedding dimension
}

/** Audio buffer for a speaker pending identification */
export interface SpeakerAudioBuffer {
  speakerIndex: number;
  pcmChunks: Uint8Array[];
  totalMs: number;
  matched: boolean;
  matchResult: SpeakerMatch | null;
}

/** Interface for embedding providers (swappable: resemblyzer, speechbrain, pyannote, etc.) */
export interface EmbeddingProvider {
  /** Extract a voice embedding from PCM audio (16kHz, 16-bit LE, mono) */
  extractEmbedding(pcmAudio: Uint8Array, sampleRate: number): Promise<number[]>;
  /** Expected dimension of output embeddings */
  readonly embeddingDim: number;
}
