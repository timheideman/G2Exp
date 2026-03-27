/**
 * BrowserAudioCapture — Fallback audio capture via getUserMedia
 *
 * When the G2 bridge isn't available (testing on laptop), captures
 * audio from the browser mic and converts it to the same PCM format
 * the G2 glasses output: 16kHz, 16-bit signed LE, mono.
 *
 * Handles resampling from whatever rate the browser gives us (usually
 * 44100 or 48000) down to 16000 Hz.
 */

export class BrowserAudioCapture {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onAudioData: ((pcm: Uint8Array) => void) | null = null;
  private _isCapturing = false;
  private nativeSampleRate = 48000;

  static readonly TARGET_SAMPLE_RATE = 16000;

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  /** Register callback for PCM audio chunks */
  onData(callback: (pcm: Uint8Array) => void): void {
    this.onAudioData = callback;
  }

  /** Start capturing from browser mic */
  async start(): Promise<void> {
    if (this._isCapturing) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Disable processing that blends voices — hurts diarization
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });

      // Browser chooses its own sample rate — we'll resample
      this.audioContext = new AudioContext();

      // Resume AudioContext if suspended (browser autoplay policy)
      if (this.audioContext.state === 'suspended') {
        console.log('[BrowserAudio] AudioContext suspended, resuming...');
        await this.audioContext.resume();
      }
      console.log(`[BrowserAudio] AudioContext state: ${this.audioContext.state}`);

      this.nativeSampleRate = this.audioContext.sampleRate;
      console.log(`[BrowserAudio] Native sample rate: ${this.nativeSampleRate} Hz`);

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Check that the stream has audio tracks
      const tracks = this.mediaStream.getAudioTracks();
      console.log(`[BrowserAudio] Audio tracks: ${tracks.length}, enabled: ${tracks[0]?.enabled}`);

      // 4096 samples per buffer
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      let chunkCount = 0;
      this.processor.onaudioprocess = (event) => {
        if (!this.onAudioData) return;

        const float32 = event.inputBuffer.getChannelData(0);

        chunkCount++;
        if (chunkCount === 1) {
          console.log(`[BrowserAudio] First audio chunk (${float32.length} samples)`);
        }
        if (chunkCount % 100 === 0) {
          // Log RMS level every ~100 chunks to verify audio is flowing
          const rms = Math.sqrt(float32.reduce((sum, s) => sum + s * s, 0) / float32.length);
          console.log(`[BrowserAudio] Chunks: ${chunkCount}, RMS: ${rms.toFixed(4)}`);
        }

        // Resample to 16kHz if needed
        const resampled = this.nativeSampleRate === BrowserAudioCapture.TARGET_SAMPLE_RATE
          ? float32
          : resample(float32, this.nativeSampleRate, BrowserAudioCapture.TARGET_SAMPLE_RATE);

        const pcm16 = float32ToPcm16(resampled);
        this.onAudioData(pcm16);
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this._isCapturing = true;
      console.log(`[BrowserAudio] Mic capture started (${this.nativeSampleRate}→16000 Hz)`);
    } catch (err) {
      console.error('[BrowserAudio] Failed to start:', err);
      throw err;
    }
  }

  /** Stop capturing */
  async stop(): Promise<void> {
    if (!this._isCapturing) return;

    this.processor?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach(t => t.stop());

    if (this.audioContext?.state !== 'closed') {
      await this.audioContext?.close();
    }

    this.processor = null;
    this.source = null;
    this.mediaStream = null;
    this.audioContext = null;
    this._isCapturing = false;

    console.log('[BrowserAudio] Mic capture stopped');
  }
}

/**
 * Linear interpolation resampling
 * Simple and fast — good enough for speech at these rates
 */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, input.length - 1);
    const frac = srcIndex - srcFloor;

    output[i] = input[srcFloor] * (1 - frac) + input[srcCeil] * frac;
  }

  return output;
}

/** Convert Float32 samples (-1 to 1) to 16-bit signed LE PCM (Uint8Array) */
function float32ToPcm16(float32: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(i * 2, val, true); // little-endian
  }

  return new Uint8Array(buffer);
}
