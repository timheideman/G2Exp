/**
 * LiveCaption WebSocket Proxy Server
 *
 * - Waits for BOTH config AND first audio before opening Deepgram
 * - Sends keepalive to prevent Deepgram timeout during silence
 * - Reconnects Deepgram if connection drops while client is active
 * - Handles enrollment protocol (enroll_start / enroll_end / enroll_from_buffer)
 * - Maintains per-speaker audio ring buffers for speaker matching
 * - Runs speaker identification pipeline using MFCC embeddings
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';
import { RealEmbeddingProvider } from './real-embedding-provider';
import { VoiceprintStore } from './voiceprint-store';
import { cosineSimilarity } from './speaker-matcher';

const PORT = parseInt(process.env.WS_PORT || '8080', 10);
const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const DG_MODEL = process.env.DG_MODEL || 'nova-3';
const DG_REGION = process.env.DG_REGION || 'eu';
const KEEPALIVE_INTERVAL_MS = 8000; // Deepgram timeout is ~10s

if (!DG_API_KEY) {
  console.error('❌ DEEPGRAM_API_KEY not set in .env');
  process.exit(1);
}

const deepgramUrl = DG_REGION === 'eu'
  ? 'https://api.eu.deepgram.com'
  : undefined;

const deepgram = createClient(DG_API_KEY, {
  global: { url: deepgramUrl },
});

// ─── Shared embedding provider (singleton — mel filterbank cached) ──────────
const embeddingProvider = new RealEmbeddingProvider();

// ─── Speaker matching constants ─────────────────────────────────────────────
const MATCH_THRESHOLD = 0.65;   // MFCC-based embeddings on real audio — keep permissive
const MIN_AUDIO_MS = 3000;      // Need 3s of speech before attempting match
const MATCH_RETRY_MS = 5000;    // Don't retry a failed match within 5s

// ─── Ring buffer sizes ───────────────────────────────────────────────────────
const BYTES_PER_SEC = 16000 * 2;              // 16 kHz, 16-bit
const GLOBAL_RING_BYTES = BYTES_PER_SEC * 35; // 35s global buffer (for time-range extraction)
const SPEAKER_RING_BYTES = BYTES_PER_SEC * 30; // 30s per-speaker buffer

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionConfig {
  language: string;
  smartFormat: boolean;
  profanityFilter: boolean;
}

interface LoadedVoiceprint {
  id: string;
  name: string;
  embedding: number[];
}

interface SpeakerTracker {
  audioChunks: Uint8Array[];
  totalAudioMs: number;
  identified: boolean;
  lastAttemptMs: number;
  matchedVoiceprintId: string | null;
}

interface RingBuffer {
  data: Uint8Array;
  writePos: number;
  totalBytesWritten: number;
}

// ─── Ring buffer utilities ───────────────────────────────────────────────────

function createRingBuffer(sizeBytes: number): RingBuffer {
  return { data: new Uint8Array(sizeBytes), writePos: 0, totalBytesWritten: 0 };
}

function writeRingBuffer(ring: RingBuffer, chunk: Uint8Array): void {
  let left = chunk.length;
  let srcOffset = 0;
  const size = ring.data.length;

  while (left > 0) {
    const n = Math.min(left, size - ring.writePos);
    ring.data.set(chunk.subarray(srcOffset, srcOffset + n), ring.writePos);
    ring.writePos = (ring.writePos + n) % size;
    srcOffset += n;
    left -= n;
    ring.totalBytesWritten += n;
  }
}

/** Extract all available bytes from ring buffer (up to ring size) in chronological order */
function readRingBuffer(ring: RingBuffer): Uint8Array {
  const size = ring.data.length;
  const available = Math.min(ring.totalBytesWritten, size);
  if (available === 0) return new Uint8Array(0);

  const out = new Uint8Array(available);

  if (ring.totalBytesWritten <= size) {
    // Buffer not yet full — valid data is 0..writePos
    out.set(ring.data.subarray(0, ring.writePos));
  } else {
    // Buffer is full — oldest data starts at writePos
    const oldPart = ring.data.subarray(ring.writePos, size);
    const newPart = ring.data.subarray(0, ring.writePos);
    out.set(oldPart, 0);
    out.set(newPart, oldPart.length);
  }

  return out;
}

/**
 * Extract audio bytes for a specific time range from the global ring buffer.
 * startSec/endSec are seconds from stream start (Deepgram word timestamps).
 */
function extractTimeRange(
  ring: RingBuffer,
  startSec: number,
  endSec: number,
): Uint8Array | null {
  const startByte = Math.floor(startSec * BYTES_PER_SEC);
  const endByte = Math.min(
    Math.ceil(endSec * BYTES_PER_SEC),
    ring.totalBytesWritten,
  );

  if (endByte <= startByte) return null;

  const oldestByte = Math.max(0, ring.totalBytesWritten - ring.data.length);
  if (startByte < oldestByte) return null; // Overwritten

  const len = endByte - startByte;
  const out = new Uint8Array(len);
  const size = ring.data.length;

  for (let i = 0; i < len; i++) {
    out[i] = ring.data[(startByte + i) % size];
  }

  return out;
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`🎙️  LiveCaption server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (clientWs: WebSocket) => {
  console.log('📱 Client connected');

  // ── Core session state ──────────────────────────────────────
  let config: SessionConfig | null = null;
  let dgConnection: ListenLiveClient | null = null;
  let isDeepgramOpen = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunkCount = 0;
  let closing = false;

  // ── Enrollment state ────────────────────────────────────────
  let enrollmentMode = false;
  let enrollmentChunks: Buffer[] = [];
  let enrollmentStartMs = 0;

  // ── Global audio ring buffer (for time-range extraction) ────
  const globalRing = createRingBuffer(GLOBAL_RING_BYTES);
  // Tracks how many bytes were already in the ring when Deepgram first opened.
  // Deepgram timestamps are relative to the first byte IT received, not ring byte 0.
  let ringBytesAtDgOpen = 0;

  // ── Per-speaker ring buffers (30s each) ─────────────────────
  const speakerRings = new Map<number, RingBuffer>();

  // ── Speaker matching state ──────────────────────────────────
  const sessionVoiceprintStore = new VoiceprintStore(
    `/tmp/session-vp-${Math.random().toString(36).slice(2)}.json`,
  );
  const speakerTrackers = new Map<number, SpeakerTracker>();

  // ─── Speaker matching helpers ──────────────────────────────

  function getSpeakerRing(speakerIndex: number): RingBuffer {
    if (!speakerRings.has(speakerIndex)) {
      speakerRings.set(speakerIndex, createRingBuffer(SPEAKER_RING_BYTES));
    }
    return speakerRings.get(speakerIndex)!;
  }

  function getSpeakerTracker(speakerIndex: number): SpeakerTracker {
    if (!speakerTrackers.has(speakerIndex)) {
      speakerTrackers.set(speakerIndex, {
        audioChunks: [],
        totalAudioMs: 0,
        identified: false,
        lastAttemptMs: 0,
        matchedVoiceprintId: null,
      });
    }
    return speakerTrackers.get(speakerIndex)!;
  }

  /** Feed PCM audio for a speaker, attempting identification when ready */
  function feedSpeakerAudio(
    speakerIndex: number,
    audio: Uint8Array,
    durationMs: number,
  ): void {
    const tracker = getSpeakerTracker(speakerIndex);

    // Already positively identified — don't accumulate further
    if (tracker.identified) return;

    // Rate limit: don't retry within 5s of last failed attempt
    const sinceLastAttempt = Date.now() - tracker.lastAttemptMs;
    if (tracker.lastAttemptMs > 0 && sinceLastAttempt < MATCH_RETRY_MS) return;

    tracker.audioChunks.push(audio);
    tracker.totalAudioMs += durationMs;

    // Attempt match once we have enough audio
    if (tracker.totalAudioMs >= MIN_AUDIO_MS) {
      attemptSpeakerMatch(speakerIndex, tracker);
    }
  }

  /** Asynchronously extract embedding and match against voiceprints */
  function attemptSpeakerMatch(speakerIndex: number, tracker: SpeakerTracker): void {
    const voiceprints = sessionVoiceprintStore.getAll();
    if (voiceprints.length === 0) return; // Nothing to match against yet

    tracker.lastAttemptMs = Date.now();

    // Concat all buffered audio chunks
    const totalLen = tracker.audioChunks.reduce((s, c) => s + c.length, 0);
    const fullAudio = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of tracker.audioChunks) {
      fullAudio.set(chunk, offset);
      offset += chunk.length;
    }

    // Reset audio accumulator so fresh audio is collected for next attempt
    tracker.audioChunks = [];
    tracker.totalAudioMs = 0;

    (async () => {
      try {
        const embedding = await embeddingProvider.extractEmbedding(fullAudio, 16000);

        // Find best match — skip voiceprints already claimed by other speakers
        const usedIds = new Set<string>();
        for (const [idx, t] of speakerTrackers) {
          if (idx !== speakerIndex && t.identified && t.matchedVoiceprintId) {
            usedIds.add(t.matchedVoiceprintId);
          }
        }

        let bestScore = -1;
        let bestVp: LoadedVoiceprint | null = null;

        for (const vp of voiceprints) {
          if (usedIds.has(vp.id)) continue;
          const score = cosineSimilarity(embedding, vp.embedding);
          if (score > bestScore) {
            bestScore = score;
            bestVp = { id: vp.id, name: vp.name, embedding: vp.embedding };
          }
        }

        console.log(`🔍 Speaker ${speakerIndex} best match: "${bestVp?.name ?? 'none'}" score=${bestScore.toFixed(3)} threshold=${MATCH_THRESHOLD}`);

        if (bestVp && bestScore >= MATCH_THRESHOLD) {
          tracker.identified = true;
          tracker.matchedVoiceprintId = bestVp.id;

          console.log(
            `🎤 Speaker ${speakerIndex} identified as "${bestVp.name}" (confidence=${bestScore.toFixed(3)})`,
          );

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: 'speaker_identified',
                speakerIndex,
                name: bestVp.name,
                voiceprintId: bestVp.id,
                confidence: bestScore,
              }),
            );
          }
        } else {
          console.log(
            `🎤 Speaker ${speakerIndex} not matched (best score=${bestScore.toFixed(3)})`,
          );
        }
      } catch (err) {
        console.error(`[SpeakerMatch] Error matching speaker ${speakerIndex}:`, err);
      }
    })();
  }

  // ─── Deepgram management ─────────────────────────────────────

  function openDeepgram(cfg: SessionConfig): void {
    if (closing) return;

    // Close existing
    stopKeepalive();
    if (dgConnection) {
      isDeepgramOpen = false;
      try { dgConnection.requestClose(); } catch {}
      dgConnection = null;
    }

    console.log(`🔗 Opening Deepgram (lang=${cfg.language})...`);

    dgConnection = deepgram.listen.live({
      model: DG_MODEL,
      language: cfg.language,
      smart_format: cfg.smartFormat,
      diarize: true,
      interim_results: true,
      utterance_end_ms: 1000,  // was 2000 — finalise segments faster in conversation
      vad_events: true,
      profanity_filter: cfg.profanityFilter,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      multichannel: false,
      no_delay: true,
      endpointing: 150,        // was 300 — detect speaker transitions faster
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`✅ Deepgram ready (lang=${cfg.language})`);
      isDeepgramOpen = true;
      ringBytesAtDgOpen = globalRing.totalBytesWritten;
      console.log(`📍 Ring offset at Deepgram open: ${ringBytesAtDgOpen} bytes (${(ringBytesAtDgOpen / BYTES_PER_SEC).toFixed(2)}s)`);
      startKeepalive();

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'server_ready',
          config: {
            language: cfg.language,
            smartFormat: cfg.smartFormat,
            profanityFilter: cfg.profanityFilter,
          },
        }));
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;

      const isFinal = data.is_final;
      const words = alt.words || [];

      // Log speaker data from Deepgram for debugging
      const speakerValues = words.map((w: any) => w.speaker);
      const uniqueSpeakers = [...new Set(speakerValues.filter((s: any) => s !== undefined))];
      if (isFinal) {
        console.log(`📝 [${isFinal ? 'FINAL' : 'interim'}] speakers=${JSON.stringify(uniqueSpeakers)} text="${alt.transcript.substring(0, 60)}"`);
      }

      // Determine primary speaker
      const speakerCounts = new Map<number, number>();
      for (const w of words) {
        if (w.speaker !== undefined) {
          speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
        }
      }
      let speaker = 0;
      let maxCount = 0;
      for (const [s, c] of speakerCounts) {
        if (c > maxCount) { speaker = s; maxCount = c; }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: isFinal ? 'final' : 'interim',
          speaker,
          text: alt.transcript,
          timestamp: Date.now(),
          isFinal,
          words: words.map((w: any) => ({
            word: w.punctuated_word || w.word,
            speaker: w.speaker ?? 0,
            start: w.start,
            end: w.end,
          })),
        }));
      }

      // ── Speaker matching pipeline (finals only) ──────────────
      if (isFinal && words.length > 0) {
        runSpeakerMatchingPipeline(words);
      }
    });

    dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'utterance_end', timestamp: Date.now() }));
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('❌ Deepgram error:', err);
      // Surface to the client so captioning never fails silently.
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          code: (err as any)?.type || 'deepgram_error',
          message: (err as any)?.message || 'Transcription service error',
        }));
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log('🔌 Deepgram closed');
      isDeepgramOpen = false;
      stopKeepalive();

      // Auto-reconnect if client is still connected and we have config
      if (!closing && config && clientWs.readyState === WebSocket.OPEN) {
        console.log('🔄 Auto-reconnecting Deepgram in 1s...');
        setTimeout(() => {
          if (!closing && config) openDeepgram(config);
        }, 1000);
      }
    });
  }

  /** Extract per-speaker PCM chunks from global ring buffer and feed to matching */
  function runSpeakerMatchingPipeline(words: any[]): void {
    const ringOffsetSec = ringBytesAtDgOpen / BYTES_PER_SEC;

    // Group word time ranges by speaker index
    // Deepgram timestamps are relative to first audio byte Deepgram received.
    // Adjust by ringOffsetSec to map into the global ring buffer.
    const speakerRanges = new Map<number, Array<{ start: number; end: number }>>();
    for (const w of words) {
      const s: number = w.speaker ?? 0;
      const start: number = (w.start ?? 0) + ringOffsetSec;
      const end: number   = (w.end   ?? 0) + ringOffsetSec;
      if (end > start) {
        if (!speakerRanges.has(s)) speakerRanges.set(s, []);
        speakerRanges.get(s)!.push({ start, end });
      }
    }

    for (const [speakerIndex, ranges] of speakerRanges) {
      const tracker = getSpeakerTracker(speakerIndex);
      if (tracker.identified) continue;

      const sinceLastAttempt = Date.now() - tracker.lastAttemptMs;
      if (tracker.lastAttemptMs > 0 && sinceLastAttempt < MATCH_RETRY_MS) continue;

      const speakerRing = getSpeakerRing(speakerIndex);
      let extractedMs = 0;
      let nullCount = 0;

      for (const range of ranges) {
        const audio = extractTimeRange(globalRing, range.start, range.end);
        if (!audio || audio.length < 2) { nullCount++; continue; }

        const durationMs = (range.end - range.start) * 1000;
        extractedMs += durationMs;
        writeRingBuffer(speakerRing, audio);
        tracker.audioChunks.push(audio);
        tracker.totalAudioMs += durationMs;
      }

      if (nullCount > 0) {
        console.log(`⚠️  Speaker ${speakerIndex}: ${nullCount}/${ranges.length} word ranges returned null (ring=${globalRing.totalBytesWritten}B, offset=${ringBytesAtDgOpen}B)`);
      }
      if (extractedMs > 0) {
        console.log(`🎙 Speaker ${speakerIndex}: +${extractedMs.toFixed(0)}ms audio, total=${tracker.totalAudioMs.toFixed(0)}ms / ${MIN_AUDIO_MS}ms needed`);
      }

      if (tracker.totalAudioMs >= MIN_AUDIO_MS) {
        attemptSpeakerMatch(speakerIndex, tracker);
      }
    }
  }

  function startKeepalive(): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (dgConnection && isDeepgramOpen) {
        try { dgConnection.keepAlive(); } catch {}
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function sendAudio(data: Buffer): void {
    // Write to global ring buffer for time-range extraction
    writeRingBuffer(globalRing, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;

    audioChunkCount++;

    if (audioChunkCount === 1) {
      console.log('🎤 First audio chunk received');
    }
    if (audioChunkCount % 500 === 0) {
      console.log(`🎤 Audio chunks: ${audioChunkCount}`);
    }

    // Open Deepgram on first audio if we have config but no connection
    if (!dgConnection && config) {
      console.log('🎤 Audio arrived — opening Deepgram...');
      openDeepgram(config);
    }

    if (isDeepgramOpen && dgConnection) {
      dgConnection.send(arrayBuffer);
    }
  }

  // ─── Message handler ──────────────────────────────────────────

  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Route binary audio based on enrollment mode
      if (enrollmentMode) {
        enrollmentChunks.push(Buffer.from(data));
      } else {
        sendAudio(data);
      }
      return;
    }

    // JSON message
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {

        // ── Existing: session configuration ─────────────────
        case 'config': {
          const newConfig: SessionConfig = {
            language: msg.language || 'nl',
            smartFormat: msg.smartFormat ?? true,
            profanityFilter: msg.profanityFilter ?? false,
          };

          const configChanged = !config
            || newConfig.language !== config.language
            || newConfig.smartFormat !== config.smartFormat
            || newConfig.profanityFilter !== config.profanityFilter;

          config = newConfig;
          console.log(`⚙️  Config: lang=${config.language}, smart=${config.smartFormat}, profanity=${config.profanityFilter}`);

          if (configChanged && dgConnection) {
            openDeepgram(config);
          }
          break;
        }

        // ── Enrollment: start recording ──────────────────────
        case 'enroll_start': {
          console.log('🔴 Enrollment started');
          enrollmentMode = true;
          enrollmentChunks = [];
          enrollmentStartMs = Date.now();
          break;
        }

        // ── Enrollment: stop and extract embedding ───────────
        case 'enroll_end': {
          if (!enrollmentMode) {
            clientWs.send(JSON.stringify({
              type: 'enrollment_error',
              message: 'Not in enrollment mode',
            }));
            break;
          }

          const name: string = (msg.name || '').trim();
          if (!name) {
            enrollmentMode = false;
            clientWs.send(JSON.stringify({
              type: 'enrollment_error',
              message: 'Name is required',
            }));
            break;
          }

          const durationMs = Date.now() - enrollmentStartMs;
          const capturedChunks = enrollmentChunks.slice();
          enrollmentMode = false;
          enrollmentChunks = [];

          console.log(`🔴 Enrollment ended for "${name}" (${durationMs}ms, ${capturedChunks.length} chunks)`);

          if (capturedChunks.length === 0) {
            clientWs.send(JSON.stringify({
              type: 'enrollment_error',
              message: 'No audio captured during enrollment',
            }));
            break;
          }

          // Async embedding extraction
          (async () => {
            try {
              const totalLen = capturedChunks.reduce((s, c) => s + c.length, 0);
              const fullAudio = new Uint8Array(totalLen);
              let offset = 0;
              for (const chunk of capturedChunks) {
                fullAudio.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
                offset += chunk.length;
              }

              const embedding = await embeddingProvider.extractEmbedding(fullAudio, 16000);

              console.log(`✅ Enrollment embedding ready for "${name}" (dim=${embedding.length})`);

              clientWs.send(JSON.stringify({
                type: 'enrollment_result',
                name,
                embedding,
                durationMs,
              }));
            } catch (err: any) {
              console.error('[Enrollment] Embedding failed:', err);
              clientWs.send(JSON.stringify({
                type: 'enrollment_error',
                message: err?.message || 'Embedding extraction failed',
              }));
            }
          })();
          break;
        }

        // ── Load voiceprints for this session ────────────────
        case 'load_voiceprints': {
          const voiceprints: LoadedVoiceprint[] = msg.voiceprints || [];
          sessionVoiceprintStore.clear();

          for (const vp of voiceprints) {
            sessionVoiceprintStore.add({
              id: vp.id,
              name: vp.name,
              embedding: vp.embedding,
              createdAt: Date.now(),
              sampleDurationMs: 0,
            });
          }

          console.log(`👤 Loaded ${voiceprints.length} voiceprints for session`);

          // Clear identification state so we can re-match with new voiceprints
          for (const [, tracker] of speakerTrackers) {
            if (!tracker.identified) {
              tracker.audioChunks = [];
              tracker.totalAudioMs = 0;
              tracker.lastAttemptMs = 0;
            }
          }
          break;
        }

        // ── Enroll from session ring buffer ──────────────────
        case 'enroll_from_buffer': {
          const speakerIndex: number = msg.speakerIndex ?? 0;
          const bufferName: string = (msg.name || '').trim();

          if (!bufferName) {
            clientWs.send(JSON.stringify({
              type: 'enrollment_error',
              message: 'Name is required',
            }));
            break;
          }

          const speakerRing = speakerRings.get(speakerIndex);
          if (!speakerRing || speakerRing.totalBytesWritten === 0) {
            clientWs.send(JSON.stringify({
              type: 'enrollment_error',
              message: `No audio buffered for speaker ${speakerIndex}`,
            }));
            break;
          }

          const audio = readRingBuffer(speakerRing);
          const ringDurationMs = Math.floor((audio.length / BYTES_PER_SEC) * 1000);

          console.log(`🔴 Enroll from buffer: speaker ${speakerIndex} → "${bufferName}" (${ringDurationMs}ms)`);

          (async () => {
            try {
              const embedding = await embeddingProvider.extractEmbedding(audio, 16000);

              console.log(`✅ Buffer enrollment embedding ready for "${bufferName}" (dim=${embedding.length})`);

              clientWs.send(JSON.stringify({
                type: 'enrollment_result',
                name: bufferName,
                embedding,
                durationMs: ringDurationMs,
              }));
            } catch (err: any) {
              console.error('[EnrollFromBuffer] Embedding failed:', err);
              clientWs.send(JSON.stringify({
                type: 'enrollment_error',
                message: err?.message || 'Embedding extraction failed',
              }));
            }
          })();
          break;
        }

        default: {
          console.warn(`⚠️  Unknown message type: ${msg.type}`);
        }
      }
    } catch (err) {
      console.error('❌ Parse error:', err);
    }
  });

  clientWs.on('close', () => {
    console.log(`📱 Client disconnected (${audioChunkCount} audio chunks sent)`);
    closing = true;
    enrollmentMode = false;
    stopKeepalive();
    if (dgConnection && isDeepgramOpen) {
      try { dgConnection.requestClose(); } catch {}
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client error:', err);
  });
});
