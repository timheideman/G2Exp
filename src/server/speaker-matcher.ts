/**
 * SpeakerMatcher — Real-time speaker identification via voiceprint matching
 *
 * Buffers audio per speaker index from Deepgram's diarization,
 * extracts embeddings, and matches against stored voiceprints.
 * Runs in parallel with transcription — never blocks caption display.
 */

import type {
  Voiceprint,
  SpeakerMatch,
  SpeakerIdConfig,
  SpeakerAudioBuffer,
  EmbeddingProvider,
} from '../types/speaker';
import type { VoiceprintStore } from './voiceprint-store';

const DEFAULT_CONFIG: SpeakerIdConfig = {
  matchThreshold: 0.82,
  minAudioMs: 3000,
  maxStoredVoiceprints: 50,
  embeddingDim: 192,
};

const SPEAKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class SpeakerMatcher {
  private config: SpeakerIdConfig;
  private store: VoiceprintStore;
  private provider: EmbeddingProvider;
  private buffers: Map<number, SpeakerAudioBuffer> = new Map();
  private identifiedSpeakers: Map<number, SpeakerMatch> = new Map();
  private pendingMatches: Set<number> = new Set();
  private onIdentify?: (match: SpeakerMatch) => void;

  constructor(
    store: VoiceprintStore,
    provider: EmbeddingProvider,
    config?: Partial<SpeakerIdConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store;
    this.provider = provider;
  }

  /** Register callback for when a speaker is identified */
  onSpeakerIdentified(callback: (match: SpeakerMatch) => void): void {
    this.onIdentify = callback;
  }

  /** Feed audio data for a specific speaker index */
  feedAudio(speakerIndex: number, pcmChunk: Uint8Array, durationMs: number): void {
    // Already identified — skip
    if (this.identifiedSpeakers.has(speakerIndex)) return;

    let buffer = this.buffers.get(speakerIndex);
    if (!buffer) {
      buffer = {
        speakerIndex,
        pcmChunks: [],
        totalMs: 0,
        matched: false,
        matchResult: null,
      };
      this.buffers.set(speakerIndex, buffer);
    }

    buffer.pcmChunks.push(pcmChunk);
    buffer.totalMs += durationMs;

    // Attempt identification once we have enough audio
    if (buffer.totalMs >= this.config.minAudioMs && !this.pendingMatches.has(speakerIndex)) {
      this.attemptMatch(speakerIndex, buffer);
    }
  }

  /** Attempt to match a speaker against stored voiceprints */
  private async attemptMatch(speakerIndex: number, buffer: SpeakerAudioBuffer): Promise<void> {
    const voiceprints = this.store.getAll();
    if (voiceprints.length === 0) {
      // No enrolled speakers — assign letter label
      this.assignUnknown(speakerIndex);
      return;
    }

    this.pendingMatches.add(speakerIndex);

    try {
      // Concatenate audio chunks
      const totalLength = buffer.pcmChunks.reduce((sum, c) => sum + c.length, 0);
      const fullAudio = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of buffer.pcmChunks) {
        fullAudio.set(chunk, offset);
        offset += chunk.length;
      }

      // Extract embedding
      const embedding = await this.provider.extractEmbedding(fullAudio, 16000);

      // Compare against all stored voiceprints
      const match = this.findBestMatch(speakerIndex, embedding, voiceprints);

      // Store result
      this.identifiedSpeakers.set(speakerIndex, match);
      buffer.matched = true;
      buffer.matchResult = match;

      // Notify
      if (this.onIdentify) {
        this.onIdentify(match);
      }
    } catch (err) {
      console.error(`[SpeakerMatcher] Match failed for speaker ${speakerIndex}:`, err);
      this.assignUnknown(speakerIndex);
    } finally {
      this.pendingMatches.delete(speakerIndex);
    }
  }

  /** Find the best matching voiceprint for an embedding */
  findBestMatch(
    speakerIndex: number,
    embedding: number[],
    voiceprints: Voiceprint[],
  ): SpeakerMatch {
    let bestScore = -1;
    let bestVoiceprint: Voiceprint | null = null;

    // Skip voiceprints already assigned to other speakers in this session
    const usedVoiceprintIds = new Set<string>();
    for (const [, match] of this.identifiedSpeakers) {
      if (match.voiceprintId) usedVoiceprintIds.add(match.voiceprintId);
    }

    for (const vp of voiceprints) {
      if (usedVoiceprintIds.has(vp.id)) continue;
      const score = cosineSimilarity(embedding, vp.embedding);
      if (score > bestScore) {
        bestScore = score;
        bestVoiceprint = vp;
      }
    }

    if (bestVoiceprint && bestScore >= this.config.matchThreshold) {
      return {
        speakerIndex,
        voiceprintId: bestVoiceprint.id,
        name: bestVoiceprint.name,
        confidence: bestScore,
        isIdentified: true,
      };
    }

    return this.createUnknownMatch(speakerIndex, bestScore);
  }

  /** Assign a letter label to an unidentified speaker */
  private assignUnknown(speakerIndex: number): void {
    const match = this.createUnknownMatch(speakerIndex, 0);
    this.identifiedSpeakers.set(speakerIndex, match);
    if (this.onIdentify) this.onIdentify(match);
  }

  private createUnknownMatch(speakerIndex: number, confidence: number): SpeakerMatch {
    const letter = SPEAKER_LETTERS[this.identifiedSpeakers.size % SPEAKER_LETTERS.length];
    return {
      speakerIndex,
      voiceprintId: null,
      name: `Speaker ${letter}`,
      confidence,
      isIdentified: false,
    };
  }

  /** Get the display name for a speaker index */
  getDisplayName(speakerIndex: number): string {
    const match = this.identifiedSpeakers.get(speakerIndex);
    if (match) return match.name;
    // Not yet identified — return temporary letter
    const letter = SPEAKER_LETTERS[speakerIndex % SPEAKER_LETTERS.length];
    return `Speaker ${letter}`;
  }

  /** Get all identification results */
  getIdentified(): Map<number, SpeakerMatch> {
    return new Map(this.identifiedSpeakers);
  }

  /** Check if a speaker has been identified */
  isIdentified(speakerIndex: number): boolean {
    return this.identifiedSpeakers.has(speakerIndex);
  }

  /** Reset all session state (keeps voiceprints in store) */
  reset(): void {
    this.buffers.clear();
    this.identifiedSpeakers.clear();
    this.pendingMatches.clear();
  }
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
