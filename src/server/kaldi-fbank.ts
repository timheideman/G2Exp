/**
 * Kaldi-compatible log-mel filterbank (fbank) frontend.
 *
 * This MUST match the feature extraction the WeSpeaker ECAPA model was trained
 * with (torchaudio.compliance.kaldi.fbank defaults, as used by WeSpeaker's
 * infer_onnx.py). A subtle mismatch produces silently-garbage embeddings, so
 * every parameter here is pinned to the Kaldi/WeSpeaker spec:
 *
 *   num_mel_bins=80, frame_length=25ms, frame_shift=10ms, sample_rate=16000,
 *   window='hamming', use_power=true, use_log_fbank=true (natural log),
 *   low_freq=20, high_freq=8000 (Nyquist), preemphasis=0.97,
 *   remove_dc_offset=true (per frame), round_to_power_of_two=true (FFT=512),
 *   snip_edges=true, dither=0, energy_floor=1.0.
 *   Mel scale: Kaldi/HTK 2595*log10(1+f/700); triangular filters in the mel
 *   domain applied to the POWER spectrum.
 *
 * After computing the [T,80] matrix, WeSpeaker applies per-utterance CMN
 * (subtract the per-bin mean over frames). That is done here too (cmn=true).
 *
 * The output is [frames][80] log-mel features ready for the model's `feats`
 * input tensor of shape [1, T, 80].
 */

const SR = 16000;
const FRAME_LEN = 400; // 25 ms
const FRAME_SHIFT = 160; // 10 ms
const FFT_SIZE = 512; // next pow2 ≥ 400 (round_to_power_of_two)
const NUM_MEL = 80;
const PREEMPH = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SR / 2; // 8000
const ENERGY_FLOOR = 1.0;

// ─── FFT (radix-2, in place) ────────────────────────────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
}

// ─── Mel scale (Kaldi/HTK) ──────────────────────────────────────

function hzToMel(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.exp(mel / 1127) - 1);
}

// ─── Cached windows / filterbank ────────────────────────────────

let _hamming: Float64Array | null = null;
function hamming(): Float64Array {
  if (_hamming) return _hamming;
  const w = new Float64Array(FRAME_LEN);
  // Kaldi hamming: 0.54 - 0.46 cos(2πn/(N-1))
  for (let i = 0; i < FRAME_LEN; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
  }
  _hamming = w;
  return w;
}

/** Triangular mel filters over power-spectrum bins (FFT_SIZE/2+1). */
let _melFb: Float32Array[] | null = null;
function melFilterbank(): Float32Array[] {
  if (_melFb) return _melFb;
  const numBins = FFT_SIZE / 2 + 1;
  const melLow = hzToMel(LOW_FREQ);
  const melHigh = hzToMel(HIGH_FREQ);
  // NUM_MEL+2 edge points spaced evenly in mel.
  const melPts = new Float64Array(NUM_MEL + 2);
  for (let i = 0; i < NUM_MEL + 2; i++) {
    melPts[i] = melLow + ((melHigh - melLow) * i) / (NUM_MEL + 1);
  }
  const hzPts = Array.from(melPts, melToHz);
  const binHz = (k: number) => (k * SR) / FFT_SIZE;

  const filters: Float32Array[] = [];
  for (let m = 1; m <= NUM_MEL; m++) {
    const left = hzPts[m - 1];
    const center = hzPts[m];
    const right = hzPts[m + 1];
    const f = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const hz = binHz(k);
      if (hz < left || hz > right) continue;
      f[k] = hz <= center
        ? (hz - left) / (center - left)
        : (right - hz) / (right - center);
    }
    filters.push(f);
  }
  _melFb = filters;
  return filters;
}

// ─── Main: compute fbank ────────────────────────────────────────

export interface FbankOptions {
  /** Apply per-utterance cepstral mean normalization (default true). */
  cmn: boolean;
}

/**
 * Compute Kaldi-style [T,80] log-mel features from 16kHz mono Float32 samples.
 * Returns one Float32Array(80) per frame.
 */
export function computeFbank(
  samples: Float32Array,
  opts: Partial<FbankOptions> = {},
): Float32Array[] {
  const cmn = opts.cmn ?? true;
  const win = hamming();
  const fb = melFilterbank();

  // snip_edges: only full frames.
  const numFrames = samples.length >= FRAME_LEN
    ? 1 + Math.floor((samples.length - FRAME_LEN) / FRAME_SHIFT)
    : 0;
  if (numFrames <= 0) return [];

  const out: Float32Array[] = new Array(numFrames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  for (let t = 0; t < numFrames; t++) {
    const start = t * FRAME_SHIFT;

    // Copy frame.
    const frame = new Float64Array(FRAME_LEN);
    for (let i = 0; i < FRAME_LEN; i++) frame[i] = samples[start + i];

    // remove_dc_offset (per frame): subtract mean.
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) mean += frame[i];
    mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) frame[i] -= mean;

    // pre-emphasis (Kaldi applies after windowing-prep; uses first sample for
    // the boundary): y[i] = x[i] - 0.97*x[i-1], y[0] = x[0] - 0.97*x[0].
    for (let i = FRAME_LEN - 1; i > 0; i--) frame[i] -= PREEMPH * frame[i - 1];
    frame[0] -= PREEMPH * frame[0];

    // window + zero-pad into FFT buffers.
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LEN; i++) re[i] = frame[i] * win[i];

    fft(re, im);

    // power spectrum.
    const numBins = FFT_SIZE / 2 + 1;
    const power = new Float64Array(numBins);
    for (let k = 0; k < numBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // mel + natural log (energy floor).
    const feat = new Float32Array(NUM_MEL);
    for (let m = 0; m < NUM_MEL; m++) {
      const filt = fb[m];
      let e = 0;
      for (let k = 0; k < numBins; k++) {
        const w = filt[k];
        if (w > 0) e += power[k] * w;
      }
      feat[m] = Math.log(Math.max(e, ENERGY_FLOOR));
    }
    out[t] = feat;
  }

  if (cmn) applyCMN(out);
  return out;
}

/** Per-utterance CMN: subtract per-bin mean over all frames (in place). */
function applyCMN(frames: Float32Array[]): void {
  const T = frames.length;
  if (T === 0) return;
  const mean = new Float64Array(NUM_MEL);
  for (const f of frames) for (let m = 0; m < NUM_MEL; m++) mean[m] += f[m];
  for (let m = 0; m < NUM_MEL; m++) mean[m] /= T;
  for (const f of frames) for (let m = 0; m < NUM_MEL; m++) f[m] -= mean[m];
}

export const FBANK_DIM = NUM_MEL;
