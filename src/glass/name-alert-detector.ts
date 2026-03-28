/**
 * NameAlertDetector — On-device wake word detection via Picovoice Porcupine
 *
 * Runs entirely in the browser (WASM). When the user's name is called,
 * fires onDetected with the configured label. Feeds on the same PCM stream
 * used for Deepgram STT.
 *
 * Usage:
 *   const det = new NameAlertDetector();
 *   await det.init(accessKey, ppnBuffer, 'Tim', 0.5);
 *   det.onDetected = (label) => console.log(`${label} was called!`);
 *   // then call det.process(pcm) on every audio chunk
 */

import { PorcupineWorker } from '@picovoice/porcupine-web';

/** Convert an ArrayBuffer to a base64 string (works in browser). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class NameAlertDetector {
  /** Fires when wake word is detected (after cooldown). */
  onDetected?: (label: string) => void;

  /** Minimum ms between successive alerts. Default 6000. */
  cooldownMs = 6000;

  private _isActive = false;
  private _worker: PorcupineWorker | null = null;
  private _label = '';
  private _lastDetectedAt = 0;

  /**
   * PCM accumulator buffer.
   * Porcupine needs exactly frameLength (512) Int16 samples per call.
   * We buffer incoming Uint8Array chunks here and drain 512-sample frames.
   */
  private _accumulator: Int16Array = new Int16Array(0);
  private _frameLength = 512; // updated from worker after init

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Initialize Porcupine with an AccessKey and a custom .ppn wake word file.
   *
   * @param accessKey   Picovoice AccessKey from console.picovoice.ai
   * @param keywordBuffer  ArrayBuffer of the downloaded .ppn file
   * @param label          Arbitrary display label (e.g. user's name)
   * @param sensitivity    0.0–1.0, default 0.5
   */
  async init(
    accessKey: string,
    keywordBuffer: ArrayBuffer,
    label: string,
    sensitivity = 0.5,
  ): Promise<void> {
    // Destroy any previous instance
    if (this._worker) {
      await this.destroy();
    }

    this._label = label;
    this._isActive = false;

    try {
      const ppnBase64 = arrayBufferToBase64(keywordBuffer);

      const keywordModel = {
        base64: ppnBase64,
        label,
        sensitivity: Math.max(0, Math.min(1, sensitivity)),
        customWritePath: `kw_${label.toLowerCase().replace(/\s+/g, '_')}`,
        forceWrite: true,
      };

      const languageModel = {
        publicPath: '/porcupine_params.pv',
        customWritePath: 'porcupine_params',
        forceWrite: false,
      };

      this._worker = await PorcupineWorker.create(
        accessKey,
        keywordModel,
        (detection) => this._handleDetection(detection.label),
        languageModel,
        {
          processErrorCallback: (err) => {
            console.error('[NameAlert] Porcupine process error:', err);
          },
        },
      );

      this._frameLength = this._worker.frameLength;
      this._accumulator = new Int16Array(0);
      this._isActive = true;
      console.log(
        `[NameAlert] Active — label="${label}", frameLength=${this._frameLength}, sensitivity=${sensitivity}`,
      );
    } catch (err) {
      console.error('[NameAlert] Failed to initialize Porcupine:', err);
      this._isActive = false;
      // Do NOT re-throw — degrade gracefully
    }
  }

  /**
   * Feed raw PCM audio (Uint8Array, 16-bit LE, 16 kHz mono).
   * Buffers internally and drains 512-sample frames to Porcupine.
   */
  process(pcm: Uint8Array): void {
    if (!this._isActive || !this._worker) return;

    // Convert Uint8Array (16-bit LE) → Int16Array
    const incoming = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);

    // Append to accumulator
    const merged = new Int16Array(this._accumulator.length + incoming.length);
    merged.set(this._accumulator, 0);
    merged.set(incoming, this._accumulator.length);

    // Drain full frames
    let offset = 0;
    while (offset + this._frameLength <= merged.length) {
      const frame = merged.subarray(offset, offset + this._frameLength);
      try {
        this._worker.process(frame);
      } catch (err) {
        console.error('[NameAlert] process() error:', err);
      }
      offset += this._frameLength;
    }

    // Keep remainder
    this._accumulator = merged.slice(offset);
  }

  /** True if Porcupine is initialised and running. */
  get isActive(): boolean {
    return this._isActive;
  }

  /** Release resources and stop detection. */
  async destroy(): Promise<void> {
    this._isActive = false;
    if (this._worker) {
      try {
        await this._worker.release();
        this._worker.terminate();
      } catch (err) {
        console.error('[NameAlert] Error during destroy:', err);
      }
      this._worker = null;
    }
    this._accumulator = new Int16Array(0);
  }

  // ─── Private ─────────────────────────────────────────────────

  private _handleDetection(label: string): void {
    const now = Date.now();
    if (now - this._lastDetectedAt < this.cooldownMs) {
      console.log(`[NameAlert] Detected "${label}" (cooldown — suppressed)`);
      return;
    }
    this._lastDetectedAt = now;
    console.log(`[NameAlert] ✅ Detected: "${label}"`);
    this.onDetected?.(label);
  }
}
