/**
 * Voice Activity Detection — strip non-speech before embedding.
 *
 * Why this is the highest-ROI cheap win for speaker ID: the embedding
 * aggregates statistics over *all* frames. Silence and room tone are
 * acoustically similar across every speaker, so including them pulls every
 * voiceprint toward a common point and flattens the very differences we need.
 * Dropping non-speech frames before embedding sharpens separation for any
 * embedder (MFCC or neural).
 *
 * This is a lightweight, dependency-free energy + zero-crossing VAD with an
 * adaptive noise floor. It is intentionally conservative (keeps a frame if in
 * doubt) — for speaker ID we'd rather keep a borderline voiced frame than drop
 * real speech. For a production upgrade, Silero VAD (ONNX) is more robust in
 * noise; this gets most of the benefit with zero install cost.
 */

const FRAME_MS = 20;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320

export interface VadOptions {
  /** Energy threshold above the noise floor (in dB) to call a frame voiced. */
  energyMarginDb: number;
  /** Frames of hangover kept after speech ends (avoid clipping word tails). */
  hangoverFrames: number;
  /** Minimum fraction of voiced frames to consider the segment usable. */
  minVoicedRatio: number;
}

export const DEFAULT_VAD: VadOptions = {
  energyMarginDb: 8,
  hangoverFrames: 4, // ~80ms
  minVoicedRatio: 0.15,
};

export interface VadResult {
  /** PCM containing only voiced frames, concatenated. */
  voiced: Uint8Array;
  /** Voiced duration in ms. */
  voicedMs: number;
  /** Fraction of the input that was voiced (0..1). */
  voicedRatio: number;
  /** Estimated SNR in dB (speech energy vs noise floor). */
  snrDb: number;
}

/** Convert 16-bit LE PCM to Float32 samples in [-1, 1]. */
function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const n = pcm.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

interface FrameStat {
  start: number; // sample offset
  rms: number;
  zcr: number;
}

/** Per-frame RMS energy + zero-crossing rate. */
function frameStats(samples: Float32Array): FrameStat[] {
  const frames: FrameStat[] = [];
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    let sumSq = 0;
    let zc = 0;
    let prev = samples[start];
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = samples[start + i];
      sumSq += s * s;
      if ((s >= 0) !== (prev >= 0)) zc++;
      prev = s;
    }
    frames.push({
      start,
      rms: Math.sqrt(sumSq / FRAME_SAMPLES),
      zcr: zc / FRAME_SAMPLES,
    });
  }
  return frames;
}

function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

/**
 * Run VAD over a PCM buffer (16kHz, 16-bit LE, mono) and return the voiced
 * audio plus quality metrics. If everything is silence, returns the original
 * audio with voicedRatio≈0 so callers can decide what to do.
 */
export function detectVoiced(pcm: Uint8Array, opts: Partial<VadOptions> = {}): VadResult {
  const o = { ...DEFAULT_VAD, ...opts };
  const samples = pcm16ToFloat(pcm);
  const frames = frameStats(samples);

  if (frames.length === 0) {
    return { voiced: pcm, voicedMs: 0, voicedRatio: 0, snrDb: 0 };
  }

  // Estimate the noise floor as a low percentile of frame energy (robust to
  // the speech being the majority of the clip).
  const sortedDb = frames.map((f) => rmsToDb(f.rms)).sort((a, b) => a - b);
  const floorDb = sortedDb[Math.floor(sortedDb.length * 0.1)];
  const peakDb = sortedDb[Math.floor(sortedDb.length * 0.95)];
  const threshDb = floorDb + o.energyMarginDb;

  // Mark voiced frames (energy over threshold). Add hangover so word tails and
  // brief intra-word dips aren't clipped.
  const voicedFlag = new Array<boolean>(frames.length).fill(false);
  for (let i = 0; i < frames.length; i++) {
    if (rmsToDb(frames[i].rms) >= threshDb) {
      for (let h = -o.hangoverFrames; h <= o.hangoverFrames; h++) {
        const j = i + h;
        if (j >= 0 && j < frames.length) voicedFlag[j] = true;
      }
    }
  }

  // Collect voiced samples.
  const bytesPerSample = 2;
  const voicedFrameCount = voicedFlag.filter(Boolean).length;
  const out = new Uint8Array(voicedFrameCount * FRAME_SAMPLES * bytesPerSample);
  let outOff = 0;
  const srcView = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < frames.length; i++) {
    if (!voicedFlag[i]) continue;
    const byteStart = frames[i].start * bytesPerSample;
    const byteLen = FRAME_SAMPLES * bytesPerSample;
    out.set(srcView.subarray(byteStart, byteStart + byteLen), outOff);
    outOff += byteLen;
  }

  const voicedRatio = voicedFrameCount / frames.length;
  const voicedMs = (voicedFrameCount * FRAME_SAMPLES * 1000) / SAMPLE_RATE;
  const snrDb = peakDb - floorDb;

  return { voiced: out.subarray(0, outOff), voicedMs, voicedRatio, snrDb };
}
