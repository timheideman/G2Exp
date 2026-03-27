/**
 * BrowserAudioCapture — Fallback audio capture via getUserMedia
 *
 * When the G2 bridge isn't available (testing on laptop), captures
 * audio from the browser mic and converts it to the same PCM format
 * the G2 glasses output: 16kHz, 16-bit signed LE, mono.
 */

export class BrowserAudioCapture {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onAudioData: ((pcm: Uint8Array) => void) | null = null;
  private _isCapturing = false;

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
      // Request mic access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Create audio processing pipeline
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      // ScriptProcessor for raw PCM access (4096 samples per buffer)
      // Note: ScriptProcessorNode is deprecated but AudioWorklet requires
      // a separate file and HTTPS. This works fine for dev/testing.
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (event) => {
        if (!this.onAudioData) return;

        const float32 = event.inputBuffer.getChannelData(0);
        const pcm16 = float32ToPcm16(float32);
        this.onAudioData(pcm16);
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this._isCapturing = true;
      console.log('[BrowserAudio] Mic capture started (16kHz PCM)');
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

/** Convert Float32 samples (-1 to 1) to 16-bit signed LE PCM (Uint8Array) */
function float32ToPcm16(float32: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32.length; i++) {
    // Clamp to [-1, 1] and convert to int16
    const s = Math.max(-1, Math.min(1, float32[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(i * 2, val, true); // true = little-endian
  }

  return new Uint8Array(buffer);
}
