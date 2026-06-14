/**
 * Embedding provider selection.
 *
 * Default: the verified pure-TS MFCC provider (no deps, deterministic, runs
 * anywhere). Opt-in: a neural ONNX provider (WeSpeaker ECAPA) for ~10× lower
 * error — enabled with EMBEDDER=onnx and SPEAKER_MODEL_PATH=/path/model.onnx.
 *
 * Safety: the ONNX provider self-checks at init. If the model is missing or the
 * fbank frontend doesn't match it (which would silently produce garbage), init
 * throws and we fall back to MFCC — we never ship a broken embedder unnoticed.
 *
 * NOTE: MFCC and ONNX embeddings are NOT comparable. Switching backends means
 * re-enrolling contacts. With ~no production users yet this is a non-issue, but
 * the running config is logged so the choice is explicit.
 */

import type { EmbeddingProvider } from '../types/speaker';
import { RealEmbeddingProvider } from './real-embedding-provider';
import { OnnxEmbeddingProvider } from './onnx-embedding-provider';

export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  const backend = (process.env.EMBEDDER || 'mfcc').toLowerCase();

  if (backend === 'onnx') {
    const modelPath = process.env.SPEAKER_MODEL_PATH;
    if (!modelPath) {
      console.warn(
        '⚠️  EMBEDDER=onnx but SPEAKER_MODEL_PATH is not set — falling back to MFCC.',
      );
      return new RealEmbeddingProvider();
    }
    try {
      const provider = new OnnxEmbeddingProvider({
        modelPath,
        inputName: process.env.SPEAKER_MODEL_INPUT,
        outputName: process.env.SPEAKER_MODEL_OUTPUT,
        embeddingDim: process.env.SPEAKER_MODEL_DIM
          ? parseInt(process.env.SPEAKER_MODEL_DIM, 10)
          : 192,
      });
      await provider.init();
      console.log(`🧠 Embedding backend: ONNX neural (${modelPath})`);
      return provider;
    } catch (err: any) {
      console.error(
        `❌ ONNX embedder init/self-check failed — falling back to MFCC.\n   ${err?.message || err}`,
      );
      return new RealEmbeddingProvider();
    }
  }

  console.log('🧠 Embedding backend: MFCC (pure-TS, default)');
  return new RealEmbeddingProvider();
}
