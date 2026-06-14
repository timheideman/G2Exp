/**
 * RealEmbeddingProvider — MFCC-based voice embedding extractor
 *
 * Pure TypeScript implementation — no external ML dependencies.
 * Computes MFCC + delta + delta-delta features from 16kHz mono PCM,
 * then aggregates statistics (mean + std) to produce a 192-dim embedding
 * suitable for cosine similarity speaker identification.
 *
 * Pipeline:
 *   PCM → pre-emphasis → framing → Hamming window → FFT →
 *   mel filterbank → log → DCT → MFCCs →
 *   delta + delta-delta → aggregate stats → L2 normalize
 */

import type { EmbeddingProvider } from '../types/speaker';

// ─── Audio Analysis Constants ──────────────────────────────────
const TARGET_SAMPLE_RATE = 16000;
const FRAME_SIZE = 400;      // 25 ms at 16 kHz
const HOP_SIZE = 160;        // 10 ms at 16 kHz
const FFT_SIZE = 512;        // Next power-of-2 ≥ FRAME_SIZE
const N_MELS = 40;           // Mel filterbank bands
const N_MFCC = 32;           // MFCC coefficients to keep (including c0)
const PRE_EMPHASIS = 0.97;
const DELTA_N = 2;           // Delta window half-size (frames)
const EMBEDDING_DIM = 192;   // 32 * 3 (static+Δ+ΔΔ) * 2 (mean+std) = 192

// ─── Mel scale helpers ────────────────────────────────────────

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

// ─── Cooley-Tukey in-place radix-2 FFT ───────────────────────

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;

        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;

        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

// ─── Signal utilities ─────────────────────────────────────────

/** Convert 16-bit LE PCM Uint8Array → Float64Array (−1 to +1) */
function pcm16ToFloat64(pcm: Uint8Array): Float64Array {
  const numSamples = pcm.length >> 1;
  const out = new Float64Array(numSamples);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < numSamples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768.0;
  }
  return out;
}

/** Linear-interpolation resampler (for non-16 kHz inputs) */
function resampleLinear(
  input: Float64Array,
  fromRate: number,
  toRate: number,
): Float64Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = src - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

// ─── Feature extraction helpers ───────────────────────────────

/** Compute delta features with window half-size N (standard ΔMFCC) */
function computeDelta(matrix: Float64Array[], N: number): Float64Array[] {
  const T = matrix.length;
  if (T === 0) return [];
  const dim = matrix[0].length;

  // Denominator: 2 * Σ(n=1..N) n²
  let denom = 0;
  for (let n = 1; n <= N; n++) denom += n * n;
  denom *= 2;
  if (denom === 0) denom = 1;

  return matrix.map((_, t) => {
    const d = new Float64Array(dim);
    for (let n = 1; n <= N; n++) {
      const tp = Math.min(t + n, T - 1);
      const tm = Math.max(t - n, 0);
      const wp = matrix[tp];
      const wm = matrix[tm];
      for (let i = 0; i < dim; i++) {
        d[i] += n * (wp[i] - wm[i]);
      }
    }
    for (let i = 0; i < dim; i++) d[i] /= denom;
    return d;
  });
}

/** Aggregate mean and std across frames for each dimension */
function aggregateMeanStd(
  matrix: Float64Array[],
  dim: number,
): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(dim);
  const variance = new Float64Array(dim);
  const T = matrix.length || 1;

  for (const row of matrix) {
    for (let i = 0; i < dim; i++) mean[i] += row[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= T;

  for (const row of matrix) {
    for (let i = 0; i < dim; i++) {
      const d = row[i] - mean[i];
      variance[i] += d * d;
    }
  }
  const std = variance.map(v => Math.sqrt(v / T));

  return { mean, std };
}

/**
 * Cepstral Mean-Variance Normalization (CMVN), applied per-utterance to the
 * MFCC matrix in place. A linear channel (mic, room, distance) shows up as an
 * additive offset in the cepstral domain — subtracting the per-coefficient
 * mean removes it; dividing by the per-coefficient std equalizes scale. This is
 * the single biggest lever for far-field / cross-device robustness, and it's
 * essentially free. Done before delta computation so deltas see normalized MFCCs.
 */
function applyCMVN(matrix: Float64Array[]): void {
  const T = matrix.length;
  if (T < 2) return;
  const dim = matrix[0].length;

  const mean = new Float64Array(dim);
  for (const row of matrix) for (let i = 0; i < dim; i++) mean[i] += row[i];
  for (let i = 0; i < dim; i++) mean[i] /= T;

  const std = new Float64Array(dim);
  for (const row of matrix) {
    for (let i = 0; i < dim; i++) {
      const d = row[i] - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / T) || 1;

  for (const row of matrix) {
    for (let i = 0; i < dim; i++) row[i] = (row[i] - mean[i]) / std[i];
  }
}

/** L2-normalize an array in-place (returns same array) */
function l2Normalize(vec: Float64Array): Float64Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

// ─── Main Provider ───────────────────────────────────────────

export class RealEmbeddingProvider implements EmbeddingProvider {
  readonly embeddingDim = EMBEDDING_DIM; // 192

  // Cached, computed once
  private _hammingWindow: Float64Array | null = null;
  private _melFilterbank: Float64Array[] | null = null;

  // FFT scratch buffers (reused to avoid GC pressure)
  private readonly _re = new Float64Array(FFT_SIZE);
  private readonly _im = new Float64Array(FFT_SIZE);

  /** Extract a 192-dim embedding from raw PCM (16kHz, 16-bit LE, mono) */
  async extractEmbedding(pcmAudio: Uint8Array, sampleRate: number): Promise<number[]> {
    let samples = pcm16ToFloat64(pcmAudio);

    // Resample if the caller provides a different rate
    if (sampleRate !== TARGET_SAMPLE_RATE) {
      samples = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
    }

    // Need at least one full frame — pad with zeros if too short
    if (samples.length < FRAME_SIZE) {
      const padded = new Float64Array(FRAME_SIZE);
      padded.set(samples);
      samples = padded;
    }

    return Array.from(this._computeEmbedding(samples));
  }

  // ─── Core computation ─────────────────────────────────────

  private _computeEmbedding(samples: Float64Array): Float64Array {
    const window = this._getHammingWindow();
    const filterbank = this._getMelFilterbank();

    // ── 1. Pre-emphasis ────────────────────────────────────
    const preEmphasized = new Float64Array(samples.length);
    preEmphasized[0] = samples[0];
    for (let i = 1; i < samples.length; i++) {
      preEmphasized[i] = samples[i] - PRE_EMPHASIS * samples[i - 1];
    }

    // ── 2. Frame and extract MFCCs ─────────────────────────
    const numFrames = Math.floor((preEmphasized.length - FRAME_SIZE) / HOP_SIZE) + 1;
    const mfccMatrix: Float64Array[] = new Array(numFrames);

    const re = this._re;
    const im = this._im;

    for (let f = 0; f < numFrames; f++) {
      const start = f * HOP_SIZE;

      // Zero FFT buffers
      re.fill(0);
      im.fill(0);

      // Apply Hamming window to frame
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = preEmphasized[start + i] * window[i];
      }

      // In-place FFT
      fftInPlace(re, im);

      // Power spectrum (one-sided, FFT_SIZE/2 + 1 bins)
      const powerSpec = new Float64Array(FFT_SIZE / 2 + 1);
      for (let k = 0; k <= FFT_SIZE / 2; k++) {
        powerSpec[k] = re[k] * re[k] + im[k] * im[k];
      }

      // Apply mel filterbank → log energies
      const logMel = new Float64Array(N_MELS);
      for (let m = 0; m < N_MELS; m++) {
        let energy = 0;
        const filter = filterbank[m];
        const filterLen = Math.min(filter.length, powerSpec.length);
        for (let k = 0; k < filterLen; k++) {
          if (filter[k] > 0) energy += powerSpec[k] * filter[k];
        }
        logMel[m] = Math.log(Math.max(energy, 1e-10));
      }

      // DCT-II to get MFCCs
      const mfccs = new Float64Array(N_MFCC);
      for (let k = 0; k < N_MFCC; k++) {
        let sum = 0;
        for (let m = 0; m < N_MELS; m++) {
          sum += logMel[m] * Math.cos(Math.PI * k * (2 * m + 1) / (2 * N_MELS));
        }
        // Ortho-normal DCT-II: k=0 → 1/sqrt(N), k>0 → sqrt(2/N)
        mfccs[k] = sum * (k === 0 ? Math.sqrt(1 / N_MELS) : Math.sqrt(2 / N_MELS));
      }

      mfccMatrix[f] = mfccs;
    }

    // ── 2b. CMVN — remove channel/mic offset (far-field robustness) ──
    applyCMVN(mfccMatrix);

    // ── 3. Delta and delta-delta ───────────────────────────
    const deltaMatrix = computeDelta(mfccMatrix, DELTA_N);
    const deltaDeltaMatrix = computeDelta(deltaMatrix, DELTA_N);

    // ── 4. Aggregate: mean + std for each of the 3 feature streams ──
    const embedding = new Float64Array(EMBEDDING_DIM);
    const streams = [mfccMatrix, deltaMatrix, deltaDeltaMatrix];
    let offset = 0;

    for (const stream of streams) {
      const { mean, std } = aggregateMeanStd(stream, N_MFCC);
      embedding.set(mean, offset);
      embedding.set(std, offset + N_MFCC);
      offset += N_MFCC * 2;
    }

    // ── 5. L2 normalize ────────────────────────────────────
    return l2Normalize(embedding);
  }

  // ─── Cached resources ─────────────────────────────────────

  private _getHammingWindow(): Float64Array {
    if (this._hammingWindow) return this._hammingWindow;
    const w = new Float64Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
    }
    this._hammingWindow = w;
    return w;
  }

  private _getMelFilterbank(): Float64Array[] {
    if (this._melFilterbank) return this._melFilterbank;

    const fMin = 0;
    const fMax = TARGET_SAMPLE_RATE / 2; // 8000 Hz

    const mMin = hzToMel(fMin);
    const mMax = hzToMel(fMax);

    // N_MELS + 2 evenly-spaced mel points (including boundary points)
    const melPoints = new Float64Array(N_MELS + 2);
    for (let i = 0; i <= N_MELS + 1; i++) {
      melPoints[i] = mMin + (mMax - mMin) * (i / (N_MELS + 1));
    }

    // Convert mel points to FFT bin indices
    const binPoints = new Uint32Array(N_MELS + 2);
    for (let i = 0; i <= N_MELS + 1; i++) {
      binPoints[i] = Math.floor((FFT_SIZE + 1) * melToHz(melPoints[i]) / TARGET_SAMPLE_RATE);
    }

    // Build triangular filters
    const numBins = FFT_SIZE / 2 + 1;
    const filters: Float64Array[] = [];

    for (let m = 1; m <= N_MELS; m++) {
      const fLeft = binPoints[m - 1];
      const fCenter = binPoints[m];
      const fRight = binPoints[m + 1];
      const filter = new Float64Array(numBins);

      // Rising slope
      if (fCenter > fLeft) {
        for (let k = fLeft; k < fCenter && k < numBins; k++) {
          filter[k] = (k - fLeft) / (fCenter - fLeft);
        }
      }
      // Falling slope
      if (fRight > fCenter) {
        for (let k = fCenter; k <= fRight && k < numBins; k++) {
          filter[k] = (fRight - k) / (fRight - fCenter);
        }
      }

      filters.push(filter);
    }

    this._melFilterbank = filters;
    return filters;
  }
}
