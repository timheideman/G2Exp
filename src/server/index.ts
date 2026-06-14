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
import { VoiceprintStore } from './voiceprint-store';
import { SpeakerIdentityResolver } from './speaker-identity-resolver';
import { detectVoiced } from './vad';
import { assessEnrollmentQuality } from './enrollment-quality';
import { createEmbeddingProvider } from './embedding-provider-factory';
import type { EmbeddingProvider } from '../types/speaker';

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

// ─── Shared embedding provider (singleton; selected at startup) ─────────────
// Resolved asynchronously (ONNX backend self-checks at init). Until ready,
// matching simply doesn't run — captions are unaffected.
let embeddingProvider: EmbeddingProvider | null = null;
createEmbeddingProvider()
  .then((p) => { embeddingProvider = p; })
  .catch((err) => { console.error('Failed to init embedding provider:', err); });

// ─── Speaker matching constants ─────────────────────────────────────────────
// Identity is resolved by the SpeakerIdentityResolver (online centroids +
// global assignment + hysteresis), not a single first-match-wins decision.
// We embed a per-index segment once it has accumulated this much speech.
const SEGMENT_MIN_MS = 1500;    // embed a segment after ~1.5s of that speaker's speech

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

/** Accumulates audio for one Deepgram index until there's enough to embed. */
interface SegmentAccumulator {
  audioChunks: Uint8Array[];
  totalAudioMs: number;
  embedding: Promise<void> | null; // in-flight embedding guard
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

  // ── Speaker identity state ──────────────────────────────────
  // Voiceprints loaded for this session (kept for enroll/diagnostics).
  const sessionVoiceprintStore = new VoiceprintStore(
    `/tmp/session-vp-${Math.random().toString(36).slice(2)}.json`,
  );
  // The robust resolver: online centroids + global assignment + hysteresis.
  const resolver = new SpeakerIdentityResolver();
  // Per-index audio accumulators (embed once enough speech is collected).
  const segmentAccumulators = new Map<number, SegmentAccumulator>();
  // Last shown name we told the client, per index — to send only on change.
  const lastShownByIndex = new Map<number, string | null>();

  // ─── Speaker identity helpers ──────────────────────────────

  function getSpeakerRing(speakerIndex: number): RingBuffer {
    if (!speakerRings.has(speakerIndex)) {
      speakerRings.set(speakerIndex, createRingBuffer(SPEAKER_RING_BYTES));
    }
    return speakerRings.get(speakerIndex)!;
  }

  function getAccumulator(speakerIndex: number): SegmentAccumulator {
    let acc = segmentAccumulators.get(speakerIndex);
    if (!acc) {
      acc = { audioChunks: [], totalAudioMs: 0, embedding: null };
      segmentAccumulators.set(speakerIndex, acc);
    }
    return acc;
  }

  /**
   * Feed a chunk of one speaker's audio. Once a segment has enough speech, we
   * embed it and feed the embedding to the resolver, which re-derives the full
   * index→name assignment and applies hysteresis. We then notify the client of
   * any index whose *shown* name changed (identified OR un-identified).
   */
  function feedSpeakerAudio(
    speakerIndex: number,
    audio: Uint8Array,
    durationMs: number,
  ): void {
    if (sessionVoiceprintStore.size === 0) return; // nothing to match against
    if (!embeddingProvider) return; // provider still initializing

    const acc = getAccumulator(speakerIndex);
    acc.audioChunks.push(audio);
    acc.totalAudioMs += durationMs;

    if (acc.totalAudioMs < SEGMENT_MIN_MS || acc.embedding) return;

    // Snapshot + reset the accumulator for the next segment.
    const segMs = acc.totalAudioMs;
    const totalLen = acc.audioChunks.reduce((s, c) => s + c.length, 0);
    const fullAudio = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of acc.audioChunks) {
      fullAudio.set(chunk, offset);
      offset += chunk.length;
    }
    acc.audioChunks = [];
    acc.totalAudioMs = 0;

    const provider = embeddingProvider;
    acc.embedding = (async () => {
      try {
        // Strip non-speech before embedding — silence is similar across all
        // speakers and flattens the very differences we need.
        const vad = detectVoiced(fullAudio);
        const audioForEmbedding = vad.voicedMs >= 300 ? vad.voiced : fullAudio;
        const weightSec = (vad.voicedMs > 0 ? vad.voicedMs : segMs) / 1000;

        const embedding = await provider.extractEmbedding(audioForEmbedding, 16000);
        // Weight evidence by the voiced duration of the segment (seconds).
        const view = resolver.observe(speakerIndex, embedding, weightSec);
        emitIdentityChanges(view);
      } catch (err) {
        console.error(`[SpeakerId] Error embedding speaker ${speakerIndex}:`, err);
      } finally {
        acc.embedding = null;
      }
    })();
  }

  /** Send speaker_identified / speaker_unidentified only when a name changes. */
  function emitIdentityChanges(view: ReturnType<SpeakerIdentityResolver['current']>): void {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    for (const id of view) {
      const prev = lastShownByIndex.get(id.speakerIndex) ?? null;
      if (id.shownName === prev) continue;
      lastShownByIndex.set(id.speakerIndex, id.shownName);

      if (id.shownName) {
        console.log(`🎤 Speaker ${id.speakerIndex} → "${id.shownName}" (conf=${id.confidence.toFixed(2)})`);
        clientWs.send(JSON.stringify({
          type: 'speaker_identified',
          speakerIndex: id.speakerIndex,
          name: id.shownName,
          voiceprintId: id.assignedVoiceprintId,
          confidence: id.confidence,
        }));
      } else {
        // Name was withdrawn (e.g. reassigned to another index after a flip).
        console.log(`🎤 Speaker ${id.speakerIndex} → unidentified`);
        clientWs.send(JSON.stringify({
          type: 'speaker_unidentified',
          speakerIndex: id.speakerIndex,
        }));
      }
    }
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
      utterance_end_ms: 1000,  // min useful value; interims arrive ~every 1s
      vad_events: true,
      profanity_filter: cfg.profanityFilter,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      multichannel: false,
      no_delay: true,
      // 300ms is Deepgram's recommended conversational range. The previous
      // 150ms over-fragmented finals and gave the diarizer less contiguous
      // per-segment context, destabilizing speaker indices. Captions still
      // update fast via interims; only finalized segments wait ~150ms longer.
      endpointing: 300,
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
      // Always keep filling the per-speaker ring (used for enroll_from_buffer),
      // and feed the identity pipeline. The resolver decides identity — there's
      // no "already identified, stop" short-circuit, so a flipped index recovers.
      const speakerRing = getSpeakerRing(speakerIndex);
      let nullCount = 0;

      for (const range of ranges) {
        const audio = extractTimeRange(globalRing, range.start, range.end);
        if (!audio || audio.length < 2) { nullCount++; continue; }

        const durationMs = (range.end - range.start) * 1000;
        writeRingBuffer(speakerRing, audio);
        // Feed the identity pipeline (accumulates, embeds, resolves).
        feedSpeakerAudio(speakerIndex, audio, durationMs);
      }

      if (nullCount > 0) {
        console.log(`⚠️  Speaker ${speakerIndex}: ${nullCount}/${ranges.length} word ranges returned null (ring=${globalRing.totalBytesWritten}B, offset=${ringBytesAtDgOpen}B)`);
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

              // Quality gate: reject too-short / too-noisy / mostly-silent
              // enrollments so a bad sample can't poison the voiceprint.
              const quality = assessEnrollmentQuality(fullAudio);
              if (!quality.ok) {
                console.log(`⚠️  Enrollment rejected for "${name}": ${quality.reason}`);
                clientWs.send(JSON.stringify({
                  type: 'enrollment_error',
                  message: quality.reason,
                }));
                return;
              }

              if (!embeddingProvider) {
                clientWs.send(JSON.stringify({
                  type: 'enrollment_error',
                  message: 'Voice engine still starting — try again in a moment.',
                }));
                return;
              }

              // Embed the voiced-only audio (silence stripped).
              const embedding = await embeddingProvider.extractEmbedding(quality.voiced, 16000);

              console.log(`✅ Enrollment embedding ready for "${name}" (dim=${embedding.length}, voiced=${(quality.voicedMs / 1000).toFixed(1)}s, snr=${quality.snrDb.toFixed(0)}dB)`);

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

          // Hand the voiceprints to the resolver. It keeps the per-index voice
          // centroids it has already built, so voices heard before enrollment
          // get re-scored on the next segment and can be identified immediately.
          resolver.setVoiceprints(
            voiceprints.map((v) => ({ id: v.id, name: v.name, embedding: v.embedding })),
          );
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
              // The per-speaker ring already holds extracted word-range audio,
              // so it's cleaner than a raw mic blob — apply a lenient gate
              // (mainly a net-speech floor) before embedding.
              const quality = assessEnrollmentQuality(audio, {
                minVoicedMs: 4000,
                minSnrDb: 8,
                minVoicedRatio: 0.1,
              });
              if (!quality.ok) {
                console.log(`⚠️  Buffer enrollment rejected for "${bufferName}": ${quality.reason}`);
                clientWs.send(JSON.stringify({
                  type: 'enrollment_error',
                  message: quality.reason,
                }));
                return;
              }

              if (!embeddingProvider) {
                clientWs.send(JSON.stringify({
                  type: 'enrollment_error',
                  message: 'Voice engine still starting — try again in a moment.',
                }));
                return;
              }

              const embedding = await embeddingProvider.extractEmbedding(quality.voiced, 16000);

              console.log(`✅ Buffer enrollment embedding ready for "${bufferName}" (dim=${embedding.length}, voiced=${(quality.voicedMs / 1000).toFixed(1)}s)`);

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
