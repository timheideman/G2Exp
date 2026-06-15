/**
 * replay-matcher — validate EnrolledSpeakerMatcher on a real recording, offline,
 * BEFORE wiring it into the live server. Mirrors the server's PLANNED flow:
 *
 *   audio file → Deepgram (words + per-word timestamps + diarize)
 *             → per final, gather the DOMINANT Deepgram-speaker's audio slices
 *             → accumulate to ~RESEGMENT_MIN_MS, VAD-trim, embed (ECAPA)
 *             → EnrolledSpeakerMatcher.match(emb) → {speakerKey, name}
 *             → print Deepgram idx vs matcher key/name, side by side
 *
 * Two modes prove both matcher paths on the SAME clip:
 *   (default)            — nobody enrolled → unknown clustering (Speaker A/B)
 *   --enroll A.mp3 B.mp3 — enroll two clean voiceprints, then expect named turns
 *
 * The gate before wiring: on tmp/AB_concat.wav the matcher must label one stable
 * identity for the A half and a DIFFERENT stable identity for the B half (named
 * correctly when enrolled). Tune nothing on synthetic audio.
 *
 * Usage:
 *   npx tsx scripts/replay-matcher.mts tmp/AB_concat.wav
 *   npx tsx scripts/replay-matcher.mts tmp/AB_concat.wav --enroll tmp/speakerA.mp3 tmp/speakerB.mp3
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { createEmbeddingProvider } from '../src/server/embedding-provider-factory';
import { detectVoiced } from '../src/server/vad';
import { EnrolledSpeakerMatcher } from '../src/server/enrolled-speaker-matcher';

const argv = process.argv.slice(2);
const enrollIdx = argv.indexOf('--enroll');
const enrollPaths = enrollIdx >= 0 ? argv.slice(enrollIdx + 1, enrollIdx + 3) : [];
const file = (enrollIdx >= 0 ? argv.slice(0, enrollIdx) : argv)[0] || 'tmp/AB_concat.wav';

const SR = 16000, BPS = SR * 2;
// Mirror the server: embed a chunk once it has ~1.5s of the dominant speaker's
// voiced audio (RESEGMENT_MIN_MS default was 1200; the matcher proved best ≥1.5s).
const MIN_MS = Number(process.env.MATCH_MIN_MS || 1500);

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) { console.error('DEEPGRAM_API_KEY not set'); process.exit(1); }
const region = (process.env.DG_REGION || 'eu') === 'eu' ? 'https://api.eu.deepgram.com' : undefined;
const dg = createClient(KEY, { global: { url: region } });

function toRawPcm(path: string): Uint8Array {
  const tmp = `/tmp/_rm_${Math.abs(path.length)}_${path.replace(/\W/g, '').slice(-8)}.raw`;
  execSync(`ffmpeg -loglevel error -y -i "${path}" -ar 16000 -ac 1 -f s16le "${tmp}"`);
  return new Uint8Array(readFileSync(tmp));
}

const provider = await createEmbeddingProvider();
const matcher = new EnrolledSpeakerMatcher();

// ── Optional: enroll two clean voiceprints from whole-file recordings. ──
if (enrollPaths.length === 2) {
  const [aPath, bPath] = enrollPaths;
  const mkVp = async (id: string, name: string, path: string) => {
    const pcm = toRawPcm(path);
    const v = detectVoiced(pcm);
    const emb = await provider.extractEmbedding(v.voicedMs >= 300 ? v.voiced : pcm, SR);
    console.log(`  enrolled ${name} from ${path} (voiced ${(v.voicedMs / 1000).toFixed(1)}s, dim ${emb.length})`);
    return { id, name, embedding: emb };
  };
  console.log('Enrolling voiceprints:');
  matcher.setEnrolled([
    await mkVp('a', 'Alice', aPath),
    await mkVp('b', 'Bob', bPath),
  ]);
  console.log();
}

const pcm = toRawPcm(file);
console.log(`▶ ${file}: ${(pcm.length / BPS).toFixed(1)}s | mode=${enrollPaths.length === 2 ? 'ENROLLED' : 'UNKNOWN-CLUSTER'} | min window=${MIN_MS}ms\n`);

function sliceByTime(startSec: number, endSec: number): Uint8Array {
  const a = Math.max(0, Math.floor(startSec * BPS) & ~1);
  const b = Math.min(pcm.length, Math.ceil(endSec * BPS) & ~1);
  return b > a ? pcm.subarray(a, b) : new Uint8Array(0);
}

type W = { word: string; speaker: number; start: number; end: number };
type Final = { words: W[]; text: string };
const finals: Final[] = [];

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
    await new Promise((r) => setTimeout(r, 8));
  }
  setTimeout(() => { try { conn.requestClose(); } catch {} }, 3000);
});

conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
  if (!data.is_final) return;
  const alt = data.channel?.alternatives?.[0];
  const words = (alt?.words || []).map((w: any) => ({
    word: w.punctuated_word || w.word, speaker: w.speaker ?? 0, start: w.start, end: w.end,
  }));
  if (words.length) finals.push({ words, text: alt.transcript });
});

conn.on(LiveTranscriptionEvents.Close, async () => {
  console.log(`Collected ${finals.length} finals. Matching per-final (server flow)…\n`);

  // Mirror the server: per final, find the dominant DG speaker, gather its audio
  // slices into a buffer, and only embed+match once the buffer ≥ MIN_MS.
  let buf: Uint8Array[] = [];
  let bufMs = 0;
  let lastKey = '';

  for (const f of finals) {
    // Dominant DG speaker for this final.
    const counts = new Map<number, number>();
    for (const w of f.words) counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
    let dg = 0, mx = 0;
    for (const [s, c] of counts) if (c > mx) { mx = c; dg = s; }

    for (const w of f.words) {
      if (w.speaker !== dg) continue;
      if (w.end <= w.start) continue;
      const audio = sliceByTime(w.start, w.end);
      if (audio.length < 2) continue;
      buf.push(audio);
      bufMs += (w.end - w.start) * 1000;
    }

    if (bufMs < MIN_MS) {
      console.log(`   ·  (DG idx ${dg}) buffering ${bufMs.toFixed(0)}ms  "${f.text.slice(0, 50)}"`);
      continue;
    }

    const totalLen = buf.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of buf) { merged.set(c, off); off += c.length; }
    buf = []; bufMs = 0;

    const v = detectVoiced(merged);
    if (v.voicedMs < 300) { console.log(`   ·  (DG idx ${dg}) mostly silence, skipped`); continue; }
    const emb = await provider.extractEmbedding(v.voiced, SR);
    const r = matcher.match(emb);
    const mark = r.speakerKey !== lastKey ? '🆕' : '  ';
    lastKey = r.speakerKey;
    console.log(`${mark} key=${r.speakerKey.padEnd(7)} name="${r.name}" ${r.enrolled ? 'ENROLLED' : 'unknown '} conf=${r.confidence.toFixed(2)} (DG idx ${dg})  "${f.text.slice(0, 50)}"`);
  }

  console.log(`\nGATE: the A-half finals should all carry ONE key and the B-half finals a DIFFERENT key`);
  console.log(`(named Alice/Bob when --enroll). Flip-flop within one speaker = fail; a single key for both = fail.`);
  process.exit(0);
});

conn.on(LiveTranscriptionEvents.Error, (e: any) => { console.error('DG error:', e?.message || e); process.exit(1); });
