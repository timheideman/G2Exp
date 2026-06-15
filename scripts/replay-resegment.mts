/**
 * replay-resegment — validate ACOUSTIC turn detection on a real recording,
 * offline, before wiring it into the live server.
 *
 * Mirrors the server pipeline end to end:
 *   audio file → Deepgram (words + per-word timestamps + diarize)
 *             → extract each word's audio slice from the original PCM
 *             → accumulate slices to a min window, embed (ECAPA)
 *             → TurnSegmenter decides turn boundaries from the VOICE
 *             → print Deepgram's index vs our acoustic turn, side by side
 *
 * The output answers the only question that matters before building more:
 * does the (fbank-fixed) embedder + segmenter separate THESE two real speakers
 * better than Deepgram's index does? Tune SEGMENTER_SWITCH / _STAY / _WINDOW_MS
 * via env and re-run until the acoustic turns track the real speakers.
 *
 * Usage: npx tsx scripts/replay-resegment.mts tmp/interruption.mp3
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { createEmbeddingProvider } from '../src/server/embedding-provider-factory';
import { detectVoiced } from '../src/server/vad';
import { TurnSegmenter } from '../src/server/turn-segmenter';

const file = process.argv[2] || 'tmp/interruption.mp3';
const SR = 16000, BPS = SR * 2;
const WINDOW_MS = Number(process.env.SEGMENTER_WINDOW_MS || 1500);
const segCfg: any = {};
if (process.env.SEGMENTER_SWITCH) segCfg.switchThreshold = Number(process.env.SEGMENTER_SWITCH);
if (process.env.SEGMENTER_STAY) segCfg.stayThreshold = Number(process.env.SEGMENTER_STAY);

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) { console.error('DEEPGRAM_API_KEY not set'); process.exit(1); }
const region = (process.env.DG_REGION || 'eu') === 'eu' ? 'https://api.eu.deepgram.com' : undefined;
const dg = createClient(KEY, { global: { url: region } });

// Decode to 16k mono 16-bit PCM.
function toRawPcm(path: string): Uint8Array {
  const tmp = `/tmp/_rr_${Math.abs(path.length)}.raw`;
  execSync(`ffmpeg -loglevel error -y -i "${path}" -ar 16000 -ac 1 -f s16le "${tmp}"`);
  return new Uint8Array(readFileSync(tmp));
}
const pcm = toRawPcm(file);
console.log(`▶ ${file}: ${(pcm.length / BPS).toFixed(1)}s\n`);

function sliceByTime(startSec: number, endSec: number): Uint8Array {
  const a = Math.max(0, Math.floor(startSec * BPS) & ~1);
  const b = Math.min(pcm.length, Math.ceil(endSec * BPS) & ~1);
  return b > a ? pcm.subarray(a, b) : new Uint8Array(0);
}

const provider = await createEmbeddingProvider();
const segmenter = new TurnSegmenter(segCfg);
console.log(`TurnSegmenter: switch=${segCfg.switchThreshold ?? '(default)'} stay=${segCfg.stayThreshold ?? '(default)'} window=${WINDOW_MS}ms\n`);

// Collect ALL words across finals (with their absolute timestamps), then process
// them in order, accumulating audio per pending chunk to the min window.
type W = { word: string; speaker: number; start: number; end: number };
const allWords: W[] = [];

const conn = dg.listen.live({
  model: process.env.DG_MODEL || 'nova-3',
  language: process.env.DG_LANGUAGE || 'multi',
  smart_format: false, punctuate: true, numerals: true,
  diarize: true, interim_results: false,
  encoding: 'linear16', sample_rate: 16000, channels: 1, no_delay: true, endpointing: 200,
});

conn.on(LiveTranscriptionEvents.Open, async () => {
  const CHUNK = 1600;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    conn.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
    await new Promise((r) => setTimeout(r, 8)); // faster than realtime; DG handles it
  }
  setTimeout(() => { try { conn.requestClose(); } catch {} }, 3000);
});

conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
  if (!data.is_final) return;
  for (const w of data.channel?.alternatives?.[0]?.words || []) {
    allWords.push({ word: w.punctuated_word || w.word, speaker: w.speaker ?? 0, start: w.start, end: w.end });
  }
});

conn.on(LiveTranscriptionEvents.Close, async () => {
  console.log(`Collected ${allWords.length} words. Re-segmenting acoustically…\n`);
  allWords.sort((a, b) => a.start - b.start);

  // Accumulate words into ~WINDOW_MS chunks; embed each chunk; ask the segmenter.
  let buf: W[] = [];
  let bufMs = 0;
  const flush = async () => {
    if (buf.length === 0) return;
    const start = buf[0].start, end = buf[buf.length - 1].end;
    const audio = sliceByTime(start, end);
    const v = detectVoiced(audio);
    const emb = await provider.extractEmbedding(v.voicedMs >= 300 ? v.voiced : audio, 16000);
    const dec = segmenter.observe(emb);
    const dgIdx = mode(buf.map((w) => w.speaker));
    const text = buf.map((w) => w.word).join(' ');
    const mark = dec.boundary ? '🆕' : '  ';
    const sim = dec.similarity === null ? ' — ' : dec.similarity.toFixed(2);
    console.log(`${mark} turn ${dec.effectiveSpeaker}  (DG idx ${dgIdx}, sim ${sim})  "${text}"`);
    buf = []; bufMs = 0;
  };
  for (const w of allWords) {
    buf.push(w);
    bufMs += (w.end - w.start) * 1000;
    if (bufMs >= WINDOW_MS) await flush();
  }
  await flush();
  console.log(`\nLegend: 🆕 = acoustic turn boundary. Compare "turn N" sequence to who's actually speaking.`);
  console.log(`If turns flip-flop within one speaker → raise SEGMENTER_SWITCH/STAY. If it misses real`);
  console.log(`changes → lower them. If hopeless even at the best settings → the embedder can't separate`);
  console.log(`these voices from ~${WINDOW_MS}ms and we need a provider change or longer windows.`);
  process.exit(0);
});

conn.on(LiveTranscriptionEvents.Error, (e: any) => { console.error('DG error:', e?.message || e); process.exit(1); });

function mode(xs: number[]): number {
  const m = new Map<number, number>();
  let best = xs[0], n = 0;
  for (const x of xs) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } }
  return best;
}
