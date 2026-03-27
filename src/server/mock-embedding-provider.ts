/**
 * MockEmbeddingProvider — Test/development embedding provider
 *
 * Generates deterministic embeddings based on audio content.
 * In production, replace with ResemblyzerProvider or PyannoteProvider.
 *
 * The mock generates embeddings that are:
 * - Deterministic (same audio → same embedding)
 * - Distinguishable (different speakers → different embeddings)
 * - Realistic in dimension and magnitude
 */

import type { EmbeddingProvider } from '../types/speaker';

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly embeddingDim = 192;

  /** Predefined speaker "signatures" for testing */
  private speakerSignatures: Map<string, number[]> = new Map();

  /** Register a test speaker signature */
  registerTestSpeaker(label: string, seed: number): void {
    this.speakerSignatures.set(label, this.generateFromSeed(seed));
  }

  /** Generate embedding — in mock, uses audio hash to select a signature */
  async extractEmbedding(pcmAudio: Uint8Array, _sampleRate: number): Promise<number[]> {
    // Simple hash of the audio content to create a deterministic embedding
    const hash = this.hashAudio(pcmAudio);
    return this.generateFromSeed(hash);
  }

  /** Generate a specific embedding for test enrollment */
  generateTestEmbedding(seed: number): number[] {
    return this.generateFromSeed(seed);
  }

  /** Generate a noisy variant of an embedding (simulates same speaker, different sample) */
  generateNoisyVariant(baseEmbedding: number[], noiseLevel: number = 0.05): number[] {
    const rng = mulberry32(42); // Fixed seed for reproducibility
    return baseEmbedding.map(v => v + (rng() - 0.5) * 2 * noiseLevel);
  }

  private generateFromSeed(seed: number): number[] {
    const rng = mulberry32(seed);
    const embedding = new Array(this.embeddingDim);
    for (let i = 0; i < this.embeddingDim; i++) {
      embedding[i] = (rng() - 0.5) * 2; // Range: -1 to 1
    }
    // L2-normalize (unit vector, like real embeddings)
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.embeddingDim; i++) {
        embedding[i] /= norm;
      }
    }
    return embedding;
  }

  private hashAudio(audio: Uint8Array): number {
    // Simple FNV-1a hash of the audio bytes
    let hash = 2166136261;
    for (let i = 0; i < Math.min(audio.length, 1000); i++) {
      hash ^= audio[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}

/** Mulberry32 PRNG — deterministic, seeded */
function mulberry32(seed: number): () => number {
  let t = seed + 0x6D2B79F5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
