/**
 * EnrollmentRecorder — Client-side enrollment orchestration
 *
 * Coordinates with the server to enroll a speaker's voice:
 *   1. Send enroll_start → server switches to enrollment mode
 *   2. Stream PCM audio chunks via the existing WebSocket
 *   3. Send enroll_end → server extracts embedding, returns enrollment_result
 *   4. On result: save contact to ContactStore
 *
 * Also supports enrollment from a buffered session speaker:
 *   enroll_from_buffer { speakerIndex, name } → enrollment_result
 *
 * Privacy guarantee: the server returns only the numeric embedding vector.
 * The actual voice audio never persists on the server; embeddings are
 * stored exclusively in the browser's ContactStore (localStorage).
 */

import { BrowserAudioCapture } from './browser-audio';
import type { ContactStore } from './contact-store';
import type { SavedContact } from '../types/privacy';

export interface EnrollmentResult {
  success: true;
  contact: SavedContact;
  durationMs: number;
}

export interface EnrollmentError {
  success: false;
  error: string;
}

export type EnrollmentOutcome = EnrollmentResult | EnrollmentError;

const ENROLLMENT_TIMEOUT_MS = 45_000; // 45s server-side timeout

export class EnrollmentRecorder {
  private audio: BrowserAudioCapture | null = null;
  private sendFn: ((data: string | ArrayBuffer) => void) | null = null;
  private _isEnrolling = false;

  // Pending promise resolvers (set when waiting for server response)
  private pendingResolve: ((outcome: EnrollmentOutcome) => void) | null = null;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly contactStore: ContactStore) {}

  // ─── Configuration ─────────────────────────────────────────

  /**
   * Provide a function to send data over the main WebSocket.
   * Called by main.ts after the app initialises.
   */
  setSendFn(fn: (data: string | ArrayBuffer) => void): void {
    this.sendFn = fn;
  }

  get isEnrolling(): boolean {
    return this._isEnrolling;
  }

  // ─── Enrollment from mic ───────────────────────────────────

  /**
   * Begin capturing audio from the microphone for enrollment.
   * Binary PCM chunks are streamed over the WebSocket.
   * Call stopEnrollment(name) to finish.
   */
  async startEnrollment(): Promise<void> {
    if (this._isEnrolling) {
      await this.cancelEnrollment();
    }

    if (!this.sendFn) throw new Error('WebSocket not connected');

    this._isEnrolling = true;

    // Tell server to start buffering audio for enrollment
    this.sendFn(JSON.stringify({ type: 'enroll_start' }));

    // Start mic capture
    this.audio = new BrowserAudioCapture();
    this.audio.onData((pcm: Uint8Array) => {
      if (this._isEnrolling && this.sendFn) {
        // Slice out exactly this chunk's bytes as a plain ArrayBuffer.
        // pcm.buffer is ArrayBufferLike (possibly Shared / over-allocated);
        // the WebSocket send signature wants a concrete ArrayBuffer.
        const ab = pcm.buffer.slice(
          pcm.byteOffset,
          pcm.byteOffset + pcm.byteLength,
        ) as ArrayBuffer;
        this.sendFn(ab);
      }
    });

    await this.audio.start();
  }

  /**
   * Stop mic capture, send the name, and wait for the server to return an embedding.
   * Returns when the server responds (or times out).
   */
  async stopEnrollment(name: string): Promise<EnrollmentOutcome> {
    if (!this._isEnrolling) {
      return { success: false, error: 'Not currently enrolling' };
    }

    // Stop mic capture
    try {
      await this.audio?.stop();
    } catch {
      // Ignore stop errors
    }
    this.audio = null;
    this._isEnrolling = false;

    if (!this.sendFn) {
      return { success: false, error: 'WebSocket not connected' };
    }

    // Tell server to process the buffered audio
    this.sendFn(JSON.stringify({ type: 'enroll_end', name }));

    // Wait for server response
    return this._waitForServerResult(name);
  }

  /** Cancel an in-progress enrollment (no result saved) */
  async cancelEnrollment(): Promise<void> {
    this._isEnrolling = false;
    try {
      await this.audio?.stop();
    } catch {}
    this.audio = null;
    this._clearPending();
  }

  // ─── Enrollment from session buffer ───────────────────────

  /**
   * Ask the server to build a voiceprint from its buffered audio
   * for a specific diarized speaker index (accumulated during the session).
   */
  async enrollFromBuffer(
    speakerIndex: number,
    name: string,
  ): Promise<EnrollmentOutcome> {
    if (!this.sendFn) {
      return { success: false, error: 'WebSocket not connected' };
    }

    this.sendFn(
      JSON.stringify({ type: 'enroll_from_buffer', speakerIndex, name }),
    );

    return this._waitForServerResult(name);
  }

  // ─── Server message handling ───────────────────────────────

  /**
   * Handle an incoming WebSocket message.
   * Returns true if the message was consumed (enrollment-related).
   * Returns false if it should be forwarded to the app's normal handler.
   */
  handleServerMessage(msg: any): boolean {
    switch (msg.type) {
      case 'enrollment_result': {
        const embedding: number[] = msg.embedding;
        const name: string = msg.name;
        const durationMs: number = msg.durationMs ?? 0;

        if (!Array.isArray(embedding) || embedding.length === 0) {
          this._resolvePending({
            success: false,
            error: 'Server returned invalid embedding',
          });
          return true;
        }

        // Save to ContactStore (voiceprint stays on device). addOrMerge
        // averages into an existing same-name contact, so re-enrolling the
        // same person strengthens their voiceprint instead of duplicating it.
        const contact = this.contactStore.addOrMerge(name, embedding, durationMs);

        this._resolvePending({ success: true, contact, durationMs });
        return true;
      }

      case 'enrollment_error': {
        this._resolvePending({
          success: false,
          error: msg.message || 'Enrollment failed',
        });
        return true;
      }

      default:
        return false;
    }
  }

  // ─── Private helpers ───────────────────────────────────────

  private _waitForServerResult(_name: string): Promise<EnrollmentOutcome> {
    // Cancel any previous pending waiter
    this._clearPending();

    return new Promise<EnrollmentOutcome>((resolve) => {
      this.pendingResolve = resolve;

      this.pendingTimeout = setTimeout(() => {
        this._resolvePending({
          success: false,
          error: 'Server did not respond in time',
        });
      }, ENROLLMENT_TIMEOUT_MS);
    });
  }

  private _resolvePending(outcome: EnrollmentOutcome): void {
    const resolve = this.pendingResolve;
    this._clearPending();
    resolve?.(outcome);
  }

  private _clearPending(): void {
    if (this.pendingTimeout !== null) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    this.pendingResolve = null;
  }
}
