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
import { appendFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';
import { VoiceprintStore } from './voiceprint-store';
import { SpeakerIdentityResolver } from './speaker-identity-resolver';
import { detectVoiced } from './vad';
import { assessSegmentHomogeneity, DEFAULT_HOMOGENEITY } from './segment-homogeneity';
import { TurnSegmenter, type TurnSegmenterConfig } from './turn-segmenter';
import { assessEnrollmentQuality } from './enrollment-quality';
import { createEmbeddingProvider } from './embedding-provider-factory';
import type { EmbeddingProvider } from '../types/speaker';
// Pure DSP (no DOM) — AGC runs HERE, on the Deepgram branch only, so the voice-
// embedding pipeline below keeps seeing the RAW mic audio (see sendAudio).
import { MicAgc } from '../glass/mic-agc';

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

// Mixed-segment rejection threshold (cosine between a segment's two halves,
// below which we treat it as two voices and drop it). Embedder-dependent —
// override without a redeploy via SEGMENT_MIN_HALF_SIM while calibrating against
// the ?diag half-similarity logs. Falls back to the module default.
const SEGMENT_MIN_HALF_SIM = process.env.SEGMENT_MIN_HALF_SIM
  ? parseFloat(process.env.SEGMENT_MIN_HALF_SIM)
  : DEFAULT_HOMOGENEITY.minHalfSimilarity;
const homogeneityOpts = { minHalfSimilarity: SEGMENT_MIN_HALF_SIM };

// ─── Acoustic turn detection (override Deepgram's lagging/merged index) ───────
// Deepgram streaming diarization is unreliable for back-and-forth speech
// (measured: it lumps two voices on one index and lags ~1-2 sentences). When ON,
// we decide the speaker label ACOUSTICALLY: embed each final's voiced audio and
// ask TurnSegmenter whether the voice changed, then send THAT turn id to the
// client instead of Deepgram's index. Validated offline (replay-resegment.mts)
// to catch an A→B boundary ~2 windows before Deepgram. ON by default; disable
// with RESEGMENT=off for an A/B. Thresholds tune via SEGMENTER_SWITCH/_STAY.
const RESEGMENT_ENABLED = process.env.RESEGMENT !== 'off';
const segmenterCfg: Partial<TurnSegmenterConfig> = {};
if (process.env.SEGMENTER_SWITCH) segmenterCfg.switchThreshold = parseFloat(process.env.SEGMENTER_SWITCH);
if (process.env.SEGMENTER_STAY) segmenterCfg.stayThreshold = parseFloat(process.env.SEGMENTER_STAY);
// Minimum voiced audio before a final is acoustically judged. Below this the
// embedding is too noisy to trust (measured: separation needs ~1.5s), so we
// keep the current turn rather than risk a false split.
const RESEGMENT_MIN_MS = process.env.RESEGMENT_MIN_MS ? parseInt(process.env.RESEGMENT_MIN_MS, 10) : 1200;

// Coalesce mic frames to ~50ms before forwarding to Deepgram (16kHz·16-bit·mono
// → 1600 bytes/50ms). Stays in DG's recommended 20–100ms buffer band.
const DG_SEND_BATCH_BYTES = 1600;

// Time-based flush for the coalescer: if bytes are buffered but haven't reached
// the batch size, forward them after this long anyway. Without it, the last
// partial buffer of a quiet phrase (the very words the reader is waiting on)
// waits for the NEXT chunk to cross the threshold — adding ragged latency to
// the final interim. 30ms keeps us inside DG's 20–100ms band.
const DG_SEND_MAX_WAIT_MS = 30;

// ─── Ring buffer sizes ───────────────────────────────────────────────────────
const BYTES_PER_SEC = 16000 * 2;              // 16 kHz, 16-bit
const GLOBAL_RING_BYTES = BYTES_PER_SEC * 35; // 35s global buffer (for time-range extraction)
const SPEAKER_RING_BYTES = BYTES_PER_SEC * 30; // 30s per-speaker buffer

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionConfig {
  language: string;
  smartFormat: boolean;
  profanityFilter: boolean;
  /**
   * Apply server-side AGC to the Deepgram branch. The glasses client sends raw
   * PCM and sets this true (lift distant speech for transcription); the browser
   * client leaves it false because getUserMedia's autoGainControl already does
   * it (so we don't gain-stack). The voice-embedding pipeline is unaffected
   * either way — it always reads the raw ring buffer.
   */
  micAgc: boolean;
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

// ─── Diarization diagnostic log ──────────────────────────────────────────────
// Appends one line per transcript showing Deepgram's per-word speaker RUNS, e.g.
//   FINAL  [0]"so what i think is" | [1]"no wait that's wrong"
// Two runs on one line = the diarizer DID split the interrupter out (good — our
// job is just to render it). One run spanning both voices = the diarizer merged
// them (a provider-level miss). Defaults ON to a temp file during local debug;
// set DIARIZE_LOG=/path to relocate, or DIARIZE_LOG=off to disable.
const DIARIZE_LOG_PATH =
  process.env.DIARIZE_LOG === 'off'
    ? null
    : process.env.DIARIZE_LOG || '/tmp/g2-diarize.log';

/** Collapse a word list into contiguous same-speaker runs (for logging). */
function speakerRuns(words: any[]): Array<{ speaker: number; text: string }> {
  const runs: Array<{ speaker: number; text: string }> = [];
  for (const w of words) {
    const s: number = w.speaker ?? 0;
    const tok: string = w.punctuated_word || w.word || '';
    const last = runs[runs.length - 1];
    if (last && last.speaker === s) last.text += ` ${tok}`;
    else runs.push({ speaker: s, text: tok });
  }
  return runs;
}

function logDiarization(isFinal: boolean, words: any[]): void {
  if (!DIARIZE_LOG_PATH || words.length === 0) return;
  const runs = speakerRuns(words);
  // Only the multi-run (interruption/overlap) and final lines are interesting;
  // skip single-run interims to keep the log readable.
  if (!isFinal && runs.length < 2) return;
  const tag = isFinal ? 'FINAL ' : 'interim';
  const body = runs.map((r) => `[${r.speaker}]"${r.text}"`).join(' | ');
  const flag = runs.length > 1 ? ' «SPLIT»' : '';
  try {
    appendFileSync(DIARIZE_LOG_PATH, `${tag} ${body}${flag}\n`);
  } catch {
    /* diagnostics must never break the stream */
  }
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

// Bind all interfaces explicitly so the glasses app (loaded on the phone over
// LAN via QR sideload) can reach this server at the laptop's LAN IP, not just
// localhost. ws@8 defaults to all-interfaces, but being explicit removes any
// ambiguity — this is the difference between "captions connect" and a silent
// ECONNREFUSED you'd waste device time chasing.
const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`🎙️  LiveCaption server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (clientWs: WebSocket) => {
  console.log('📱 Client connected');

  // ── Core session state ──────────────────────────────────────
  let config: SessionConfig | null = null;
  let dgConnection: ListenLiveClient | null = null;
  let isDeepgramOpen = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunkCount = 0;
  // Deepgram send-coalescing buffer (batches ~10ms frames into ~50ms packets).
  let dgSendBuffer: Buffer[] = [];
  let dgSendBufferBytes = 0;
  // Time-based flush timer for a partial buffer that hasn't reached the batch
  // size (so a quiet phrase's tail isn't stranded waiting for the next chunk).
  let dgSendTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;

  // AGC for the DEEPGRAM branch only. Stateful (envelope + gain ramp persist
  // across chunks), so it's per-connection and processes each client chunk in
  // arrival order — exactly as the old client-side AGC did. The ring buffer
  // (and thus every voice embedding) is written from the RAW chunk, never this.
  const dgAgc = new MicAgc();

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

  // Acoustic turn segmenter: decides the speaker label from the VOICE, replacing
  // Deepgram's unreliable streaming index. Per-connection (stateful voice
  // centroid). Names still come from the resolver, keyed by the effective turn.
  const turnSegmenter = new TurnSegmenter(segmenterCfg);
  // Buffers the current final's dominant-speaker audio until it reaches
  // RESEGMENT_MIN_MS, so each acoustic decision sees enough voiced speech.
  let resegBuf: Uint8Array[] = [];
  let resegBufMs = 0;
  // The effective speaker id we last sent (the segmenter's turn counter). Used
  // as the provisional label before/at a final, and what the client splits on.
  let lastEffectiveSpeaker = 0;
  // Naming bridge: the resolver names DEEPGRAM indices, but the client now labels
  // turns by acoustic turn id. `turnForDgIndex` records which turn a DG index is
  // currently riding on, so a `speaker_identified {dgIndex}` can be translated to
  // the turn the user actually sees. `dgIndexForTurn` is the reverse (for logs).
  const turnForDgIndex = new Map<number, number>();
  const dgIndexForTurn = new Map<number, number>();

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

        // GUARD: Deepgram's streaming diarizer can lump two voices under one
        // index, making this segment a BLEND. Embedding a blend pollutes the
        // voiceprint and is the root of "speaker B is two people → matched to
        // me". Split the voiced audio, embed each half, and compare: a true
        // single speaker's halves agree; a segment straddling a speaker change
        // does not. If mixed, drop it (no evidence) rather than mismatch.
        const hom = await assessSegmentHomogeneity(
          audioForEmbedding,
          (pcm, sr) => provider.extractEmbedding(pcm, sr),
          homogeneityOpts,
        );
        if (!hom.homogeneous) {
          console.log(`🚫 [SpeakerId] Dropped MIXED segment for index ${speakerIndex} (half-sim=${hom.halfSimilarity?.toFixed(2)}) — not matching, likely 2 voices on one Deepgram index`);
          return;
        }

        // Reuse the mean-of-halves embedding when we split-tested; otherwise the
        // segment was too short to split — embed it whole as before.
        const embedding = hom.embedding ?? await provider.extractEmbedding(audioForEmbedding, 16000);
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

      // The resolver names DEEPGRAM indices, but the client labels turns by the
      // acoustic turn id when re-segmentation is on — so translate to the turn
      // this DG index is riding on. If we haven't mapped it yet (no acoustic
      // decision for that index), skip: emitting under a raw DG index would
      // name a "speaker" the client never shows. Off → pass the index through.
      let clientId = id.speakerIndex;
      if (RESEGMENT_ENABLED) {
        const turn = turnForDgIndex.get(id.speakerIndex);
        if (turn === undefined) continue;
        clientId = turn;
      }

      if (id.shownName) {
        console.log(`🎤 Speaker ${id.speakerIndex}→turn ${clientId} → "${id.shownName}" (conf=${id.confidence.toFixed(2)})`);
        clientWs.send(JSON.stringify({
          type: 'speaker_identified',
          speakerIndex: clientId,
          name: id.shownName,
          voiceprintId: id.assignedVoiceprintId,
          confidence: id.confidence,
        }));
      } else {
        // Name was withdrawn (e.g. reassigned to another index after a flip).
        console.log(`🎤 Speaker ${id.speakerIndex}→turn ${clientId} → unidentified`);
        clientWs.send(JSON.stringify({
          type: 'speaker_unidentified',
          speakerIndex: clientId,
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
      // smart_format on streaming HOLDS text back — it waits for entity
      // completion or ~3s of silence before releasing, which is why captions
      // only appeared at sentence end. We never use it. The client's "smart
      // formatting" toggle instead maps to punctuate + numerals, which give
      // readable text (punctuation, digits) WITHOUT that finalization delay.
      // This is the single biggest live-caption latency win.
      smart_format: false,
      punctuate: cfg.smartFormat,
      numerals: cfg.smartFormat,
      diarize: true,          // needed for speaker names — kept on
      interim_results: true,  // word-by-word previews; the client renders these directly
      utterance_end_ms: 1000, // UtteranceEnd event only; does not gate text
      vad_events: true,
      profanity_filter: cfg.profanityFilter,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      multichannel: false,
      no_delay: true,
      // endpointing gates only FINALS (not interim text). 200ms locks segments
      // in reasonably fast while still giving the diarizer contiguous context
      // for stable speaker indices (10ms would over-fragment and worsen the
      // name-swapping). Caption text speed comes from smart_format:false above.
      endpointing: 200,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`✅ Deepgram ready (lang=${cfg.language})`);
      isDeepgramOpen = true;
      ringBytesAtDgOpen = globalRing.totalBytesWritten;
      // Fresh stream → re-ramp AGC gain from unity rather than a stale envelope
      // carried over from a previous (reconnected) Deepgram session.
      dgAgc.reset();
      turnSegmenter.reset();
      resegBuf = [];
      resegBufMs = 0;
      lastEffectiveSpeaker = 0;
      turnForDgIndex.clear();
      dgIndexForTurn.clear();
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

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;

      const isFinal = data.is_final;
      const words = alt.words || [];

      // Log speaker data from Deepgram for debugging
      const speakerValues = words.map((w: any) => w.speaker);
      const uniqueSpeakers = [...new Set(speakerValues.filter((s: any) => s !== undefined))];
      if (isFinal) {
        // ?diag: when a single final carries MORE than one speaker index, the
        // diarizer changed speakers mid-utterance — useful to see how often that
        // happens vs. the opposite failure (two people stuck on one index, which
        // shows as a single index here but is caught acoustically downstream).
        const multi = uniqueSpeakers.length > 1 ? ` ⚠️MULTI(${uniqueSpeakers.length})` : '';
        console.log(`📝 [FINAL] speakers=${JSON.stringify(uniqueSpeakers)}${multi} text="${alt.transcript.substring(0, 60)}"`);
      }

      // DIAGNOSTIC (DIARIZE_LOG=path): append the per-word speaker RUNS for every
      // transcript so we can see exactly what Deepgram's diarizer does during an
      // interruption — does it assign the interrupter a new index mid-utterance,
      // or keep everything on one? This is the ground truth our turn logic needs.
      logDiarization(isFinal, words);

      // Determine primary speaker (most-labeled Deepgram index in this message).
      const speakerCounts = new Map<number, number>();
      for (const w of words) {
        if (w.speaker !== undefined) {
          speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
        }
      }
      let dgSpeaker = 0;
      let maxCount = 0;
      for (const [s, c] of speakerCounts) {
        if (c > maxCount) { dgSpeaker = s; maxCount = c; }
      }

      // ── Speaker label: acoustic turn id (preferred) or Deepgram index ──
      // Deepgram's streaming index is unreliable for back-and-forth speech, so
      // when re-segmentation is on we override it: embed this final's dominant-
      // speaker audio and let TurnSegmenter decide the turn from the VOICE. The
      // effective turn id is what the client splits turns on. Interims keep the
      // last effective id (text already flows; the final corrects the tag).
      let speaker = RESEGMENT_ENABLED ? lastEffectiveSpeaker : dgSpeaker;
      let runs: Array<{ speaker: number; text: string }>;

      if (RESEGMENT_ENABLED) {
        if (isFinal) {
          speaker = await resolveAcousticSpeaker(words, dgSpeaker);
          lastEffectiveSpeaker = speaker;
        }
        // Under acoustic re-segmentation the whole transcript is one turn (the
        // acoustic centroid is more trustworthy than Deepgram's intra-message
        // split); the client renders it under the effective id.
        runs = [{ speaker, text: alt.transcript }];
      } else {
        // Per-speaker RUNS from Deepgram's word labels: when it DID split an
        // interruption mid-transcript, carry the boundary so the client renders
        // each contiguous same-speaker run as its own turn. Single-speaker → one.
        runs = speakerRuns(words).map((r) => ({ speaker: r.speaker, text: r.text }));
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: isFinal ? 'final' : 'interim',
          speaker,
          text: alt.transcript,
          runs,
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

  /**
   * Decide the effective speaker (acoustic turn id) for a final, overriding
   * Deepgram's index. Extracts this final's dominant-speaker audio from the ring,
   * accumulates across finals until ≥ RESEGMENT_MIN_MS of voiced speech, then
   * embeds it and asks TurnSegmenter whether the voice changed. Until enough
   * audio accrues — or if the embedder isn't ready — we keep the current turn
   * (never split on a thin, noisy embedding). Returns the turn id to label with.
   */
  async function resolveAcousticSpeaker(words: any[], dgSpeaker: number): Promise<number> {
    if (!embeddingProvider) return lastEffectiveSpeaker; // no voice signal yet
    const ringOffsetSec = ringBytesAtDgOpen / BYTES_PER_SEC;

    // Gather the dominant speaker's contiguous audio for THIS final.
    for (const w of words) {
      if ((w.speaker ?? 0) !== dgSpeaker) continue;
      const start = (w.start ?? 0) + ringOffsetSec;
      const end = (w.end ?? 0) + ringOffsetSec;
      if (end <= start) continue;
      const audio = extractTimeRange(globalRing, start, end);
      if (!audio || audio.length < 2) continue;
      resegBuf.push(audio);
      resegBufMs += (end - start) * 1000;
    }

    if (resegBufMs < RESEGMENT_MIN_MS) return lastEffectiveSpeaker; // not enough yet

    // Concatenate + VAD-trim the accumulated audio, then embed once (~16ms).
    const totalLen = resegBuf.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of resegBuf) { merged.set(c, off); off += c.length; }
    resegBuf = [];
    resegBufMs = 0;

    try {
      const vad = detectVoiced(merged);
      if (vad.voicedMs < 300) return lastEffectiveSpeaker; // mostly silence
      const emb = await embeddingProvider.extractEmbedding(vad.voiced, 16000);
      const dec = turnSegmenter.observe(emb);
      if (dec.boundary && dec.effectiveSpeaker !== lastEffectiveSpeaker) {
        console.log(`🔀 [TurnSegmenter] voice change → turn ${dec.effectiveSpeaker} (was ${lastEffectiveSpeaker}, DG idx ${dgSpeaker}, sim ${dec.similarity?.toFixed(2) ?? '—'})`);
      }
      // Record which turn this DG index is currently riding on, so resolver
      // names (keyed by DG index) can be surfaced under the acoustic turn.
      turnForDgIndex.set(dgSpeaker, dec.effectiveSpeaker);
      dgIndexForTurn.set(dec.effectiveSpeaker, dgSpeaker);
      return dec.effectiveSpeaker;
    } catch (err) {
      console.error('[TurnSegmenter] embed failed:', err);
      return lastEffectiveSpeaker;
    }
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
    // Write the RAW chunk to the global ring immediately. The ring is the source
    // for per-speaker voice embeddings, which MUST see unmodified audio: AGC
    // normalizes every voice toward one loudness and injects a varying gain
    // envelope, collapsing the very inter-speaker differences the embedder keys
    // on (the cause of the "can't tell voices apart" regression). Speaker-match
    // timing also depends on every chunk being recorded as it arrives.
    writeRingBuffer(globalRing, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

    audioChunkCount++;
    if (audioChunkCount === 1) {
      console.log(`🎤 First audio chunk received (${data.byteLength} bytes)`);
    }
    if (audioChunkCount % 500 === 0) {
      console.log(`🎤 Audio chunks: ${audioChunkCount}`);
    }

    // Open Deepgram on first audio if we have config but no connection
    if (!dgConnection && config) {
      console.log('🎤 Audio arrived — opening Deepgram...');
      openDeepgram(config);
    }

    // AGC the audio bound for DEEPGRAM ONLY (lift quiet/distant speech toward
    // its VAD floor). Applied here, after the raw ring write above, so it never
    // reaches the embedding pipeline. process() returns a fresh buffer (it never
    // mutates its input — the ring's raw copy is safe). Skipped when the client
    // already gain-controls its mic (browser autoGainControl) to avoid stacking;
    // there we copy `data` since the caller may reuse its backing buffer.
    const forDg: Buffer = config?.micAgc
      ? Buffer.from(dgAgc.process(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
      : Buffer.from(data);

    // Coalesce the glasses' tiny ~10ms frames into ~50ms packets before
    // forwarding to Deepgram. Sending 100 messages/sec adds WS overhead/jitter
    // without making interims faster (Deepgram buffers internally anyway); its
    // recommended buffer band is 20–100ms.
    dgSendBuffer.push(forDg);
    dgSendBufferBytes += forDg.byteLength;
    if (dgSendBufferBytes >= DG_SEND_BATCH_BYTES) {
      flushDgSendBuffer();
    } else if (dgSendTimer === null) {
      // Partial buffer — guarantee it reaches Deepgram within DG_SEND_MAX_WAIT_MS
      // even if no further chunk arrives to cross the batch threshold. This is
      // what keeps the last word of a quiet phrase from stalling.
      dgSendTimer = setTimeout(flushDgSendBuffer, DG_SEND_MAX_WAIT_MS);
    }
  }

  function flushDgSendBuffer(): void {
    if (dgSendTimer !== null) {
      clearTimeout(dgSendTimer);
      dgSendTimer = null;
    }
    if (dgSendBuffer.length === 0) return;
    if (!isDeepgramOpen || !dgConnection) {
      // Not ready yet — keep buffering (bounded by the caller cadence).
      return;
    }
    const merged = Buffer.concat(dgSendBuffer);
    dgSendBuffer = [];
    dgSendBufferBytes = 0;
    const ab = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
    dgConnection.send(ab);
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
            // Default ON when unspecified: an older glasses client (the device
            // that needs the distant-speech lift) won't send the flag. Only the
            // browser, which already auto-gains, explicitly turns it off.
            micAgc: msg.micAgc ?? true,
          };

          // micAgc only changes the Deepgram send-branch transform — no Deepgram
          // reopen needed — so it's intentionally not part of configChanged.
          const configChanged = !config
            || newConfig.language !== config.language
            || newConfig.smartFormat !== config.smartFormat
            || newConfig.profanityFilter !== config.profanityFilter;

          config = newConfig;
          console.log(`⚙️  Config: lang=${config.language}, smart=${config.smartFormat}, profanity=${config.profanityFilter}, micAgc=${config.micAgc}`);

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
    if (dgSendTimer !== null) {
      clearTimeout(dgSendTimer);
      dgSendTimer = null;
    }
    if (dgConnection && isDeepgramOpen) {
      try { dgConnection.requestClose(); } catch {}
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client error:', err);
  });
});
