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
import { detectVoiced } from './vad';
import { EnrolledSpeakerMatcher, type MatcherVoiceprint } from './enrolled-speaker-matcher';
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

// ─── Speaker attribution (the SINGLE mechanism: enrolled-voiceprint matching) ─
// THE STRATEGY (proven on real audio, see scripts/replay-matcher.mts): we do NOT
// trust Deepgram's streaming diarization index (it lumps two voices onto one and
// lags ~1-2 sentences) and we do NOT do blind online clustering. Instead, every
// final's dominant-speaker audio is embedded and matched to the nearest ENROLLED
// voiceprint by EnrolledSpeakerMatcher — which gives the TURN and the NAME in one
// step (a change of matched identity between finals IS the turn boundary). On
// tmp/AB_concat.wav this labels A then B correctly at the 1.5s window even where
// Deepgram's own index is wrong. Unenrolled voices fall back to stable "Speaker
// A/B" clusters. This replaces both TurnSegmenter and SpeakerIdentityResolver.

// (The half-split mixed-segment guard was removed from the match path: measured
// on real audio it cannot separate same-speaker from two-speaker windows for the
// ONNX embedder at this window size — see attributeSpeaker and
// scripts/measure-homogeneity.mts. segment-homogeneity.ts is kept for its tests
// and any future longer-window use.)

// Minimum voiced audio accrued before a final is matched. Below this the
// embedding is too noisy to attribute reliably (measured: clean separation needs
// ~1.5s), so we keep the current speaker label rather than risk a false split.
const MATCH_MIN_MS = process.env.MATCH_MIN_MS ? parseInt(process.env.MATCH_MIN_MS, 10) : 1500;

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
  // THE speaker mechanism: match each final's dominant-speaker audio to the
  // nearest enrolled voiceprint (or a stable clustered unknown). Gives the turn
  // AND the name together. Per-connection (holds the unknown clusters).
  const matcher = new EnrolledSpeakerMatcher();

  // The matcher returns a STRING speakerKey per identity (a voiceprint id, or
  // "unk:N"). The client's `speaker` field is a small integer used as a turn id
  // and as the key for speaker_identified. Map each key → a stable int the first
  // time we see it, so the same person keeps the same client id all session.
  const keyToClientId = new Map<string, number>();
  let nextClientId = 0;
  // Last name we emitted to the client for each client id — emit on change only.
  const nameByClientId = new Map<number, string>();
  // Buffers the current final's dominant-speaker audio until it reaches
  // MATCH_MIN_MS, so each match sees enough voiced speech to attribute reliably.
  let resegBuf: Uint8Array[] = [];
  let resegBufMs = 0;
  // The Deepgram dominant index the current resegBuf is accruing for. When a new
  // final's dominant index differs, we DROP the partial buffer rather than glue
  // two likely-different turns into one match window — Deepgram's index is noisy
  // for naming, but a change between finals is still a useful "something shifted"
  // hint, and gluing across it produces a blended window that matches no one.
  let resegDgIndex = -1;
  // The client id we last attributed a final to. Used as the provisional label
  // for interims (text flows under it; the next final corrects the tag) and as
  // the fallback when a final hasn't accrued enough audio to match yet.
  let lastEffectiveSpeaker = 0;

  // ─── Speaker identity helpers ──────────────────────────────

  function getSpeakerRing(speakerIndex: number): RingBuffer {
    if (!speakerRings.has(speakerIndex)) {
      speakerRings.set(speakerIndex, createRingBuffer(SPEAKER_RING_BYTES));
    }
    return speakerRings.get(speakerIndex)!;
  }

  /**
   * Map a matcher speakerKey (string: a voiceprint id or "unk:N") to the stable
   * small integer the client uses as its `speaker`/turn id. First sighting of a
   * key assigns the next integer; the same person keeps it for the session.
   */
  function clientIdForKey(speakerKey: string): number {
    let id = keyToClientId.get(speakerKey);
    if (id === undefined) {
      id = nextClientId++;
      keyToClientId.set(speakerKey, id);
    }
    return id;
  }

  /**
   * Tell the client the display name for a client id, but only when it changes
   * (the matcher always supplies one — an enrolled name or "Speaker A/B"). This
   * is what flips a turn's tag from a letter to the matched person's name; the
   * caption engine merges consecutive same-name turns into one block.
   */
  function emitNameIfChanged(
    clientId: number,
    name: string,
    enrolled: boolean,
    voiceprintId: string | null,
    confidence: number,
  ): void {
    if (nameByClientId.get(clientId) === name) return;
    nameByClientId.set(clientId, name);
    if (clientWs.readyState !== WebSocket.OPEN) return;
    console.log(`🎤 client ${clientId} → "${name}" (${enrolled ? 'enrolled' : 'unknown'}, conf=${confidence.toFixed(2)})`);
    clientWs.send(JSON.stringify({
      type: 'speaker_identified',
      speakerIndex: clientId,
      name,
      voiceprintId,
      confidence,
    }));
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
      // Drop only the partial per-final audio buffer — a reconnect mid-stream
      // resets Deepgram's word clock, so audio gathered against the old offset
      // is stale. The matcher's clusters, the key→id map and the emitted names
      // are deliberately KEPT: it's the same conversation with the same people,
      // and re-deriving them would relabel everyone on every reconnect.
      resegBuf = [];
      resegBufMs = 0;
      resegDgIndex = -1;
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

      // ── Speaker label: from voiceprint MATCHING, not Deepgram's index ──
      // Deepgram's streaming index is unreliable for back-and-forth speech, so we
      // ignore it for attribution: on each final we embed the dominant speaker's
      // audio and match it to the nearest enrolled voiceprint (or a clustered
      // unknown). That match gives both the speaker id and the name. Interims
      // keep the last attributed id — text flows immediately under it and the
      // next final corrects the tag if the speaker actually changed.
      let speaker = lastEffectiveSpeaker;
      if (isFinal) {
        speaker = await attributeSpeaker(words, dgSpeaker);
        lastEffectiveSpeaker = speaker;
      }
      // One turn per transcript under the attributed id: the matched identity is
      // more trustworthy than Deepgram's intra-message split, and a real speaker
      // change surfaces as a different attributed id on the NEXT final.
      const runs = [{ speaker, text: alt.transcript }];

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

      // Keep the per-speaker ring buffers fed (used by enroll_from_buffer); the
      // attribution above already consumed this final's audio for matching.
      if (isFinal && words.length > 0) {
        fillSpeakerRings(words);
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
   * Attribute a final to a speaker by VOICE MATCHING, overriding Deepgram's
   * unreliable index. Extracts this final's dominant-speaker audio from the ring,
   * accumulates across finals until ≥ MATCH_MIN_MS of voiced speech, then embeds
   * it and matches to the nearest enrolled voiceprint (or a stable clustered
   * unknown). The match gives the identity AND the name; we map its string key to
   * a stable client integer and emit the name. Until enough audio accrues — or if
   * the embedder isn't ready, or the segment is a two-voice blend — we keep the
   * current speaker (never attribute on thin or mixed evidence). Returns the
   * client speaker id to label this (and following interims) with.
   */
  async function attributeSpeaker(words: any[], dgSpeaker: number): Promise<number> {
    if (!embeddingProvider) return lastEffectiveSpeaker; // no voice signal yet
    const provider = embeddingProvider;
    const ringOffsetSec = ringBytesAtDgOpen / BYTES_PER_SEC;

    // If Deepgram's dominant index changed since the audio currently buffered,
    // drop the partial buffer: gluing this final's audio onto a different turn's
    // would build a blended window. (-1 = empty buffer; first contribution sets
    // the index.) This bounds — though can't eliminate — boundary-straddle blends
    // at a fast speaker switch (when DG is late to flip, one window still spans
    // two voices and may briefly mislabel, self-correcting on the next final).
    if (resegBuf.length > 0 && resegDgIndex !== dgSpeaker) {
      resegBuf = [];
      resegBufMs = 0;
    }
    resegDgIndex = dgSpeaker;

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

    if (resegBufMs < MATCH_MIN_MS) return lastEffectiveSpeaker; // not enough yet

    // Snapshot + clear the accumulator before the await so an overlapping final
    // starts a fresh window rather than re-matching this one's audio.
    const totalLen = resegBuf.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of resegBuf) { merged.set(c, off); off += c.length; }
    resegBuf = [];
    resegBufMs = 0;
    resegDgIndex = -1;

    try {
      const vad = detectVoiced(merged);
      if (vad.voicedMs < 300) return lastEffectiveSpeaker; // mostly silence
      const voiced = vad.voiced;

      // NB: the half-split homogeneity guard is intentionally NOT applied here.
      // Measured on real audio (scripts/measure-homogeneity.mts) the ONNX ECAPA
      // embedder's same-speaker half-window cosines (0.03–0.49) fully OVERLAP its
      // mixed A|B half-window cosines (−0.16–0.29): at ~750ms halves the
      // embedding is phoneme- not speaker-dominated, so no threshold separates
      // them. The guard would reject essentially every real window (it did — all
      // finals dropped as "MIXED"). Attribution is robust without it: the matcher
      // scores the correct enrolled voice ~0.8+ vs a wrong one ~0.2 at this 1.5s
      // window. If two voices truly share one window the worst case is one
      // mislabeled ~1.5s turn, self-correcting on the next final — far better than
      // showing nothing. A real blend-defense needs a proper diarizer, not this.
      const emb = await provider.extractEmbedding(voiced, 16000);
      const r = matcher.match(emb);
      const clientId = clientIdForKey(r.speakerKey);
      emitNameIfChanged(clientId, r.name, r.enrolled, r.enrolled ? r.speakerKey : null, r.confidence);
      if (clientId !== lastEffectiveSpeaker) {
        console.log(`🔀 [SpeakerMatch] speaker change → client ${clientId} "${r.name}" (was ${lastEffectiveSpeaker}, DG idx ${dgSpeaker}, conf ${r.confidence.toFixed(2)})`);
      }
      return clientId;
    } catch (err) {
      console.error('[SpeakerMatch] embed/match failed:', err);
      return lastEffectiveSpeaker;
    }
  }

  /**
   * Keep the per-speaker ring buffers fed from the global ring (so a wearer can
   * enroll someone retroactively via enroll_from_buffer). Keyed by Deepgram's
   * index — fine here: this is just an audio store for later enrollment, not the
   * attribution path (matching, above, decides who's speaking).
   */
  function fillSpeakerRings(words: any[]): void {
    const ringOffsetSec = ringBytesAtDgOpen / BYTES_PER_SEC;
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
      const speakerRing = getSpeakerRing(speakerIndex);
      for (const range of ranges) {
        const audio = extractTimeRange(globalRing, range.start, range.end);
        if (!audio || audio.length < 2) continue;
        writeRingBuffer(speakerRing, audio);
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

          // Hand the voiceprints to the matcher — this is the enrolled set every
          // subsequent final is matched against. Voices heard before this load
          // were attributed to unknown clusters; from the next match on, anyone
          // who matches an enrolled print gets that print's stable key (a new
          // client id) and their real name, so they self-correct without a
          // bridge. Keeps existing unknown clusters for still-unenrolled voices.
          matcher.setEnrolled(
            voiceprints.map((v): MatcherVoiceprint => ({ id: v.id, name: v.name, embedding: v.embedding })),
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
