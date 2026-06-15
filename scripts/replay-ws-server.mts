/**
 * replay-ws-server — drive the LIVE wired server end-to-end with a real clip.
 *
 * This is the on-the-wire verification the HANDOFF asks for after wiring
 * EnrolledSpeakerMatcher into index.ts: it does NOT import the server's internals
 * (unlike replay-matcher.mts, which tests the matcher logic offline). It connects
 * to the running ws://localhost:8080 exactly like the glasses client, optionally
 * enrolls two voiceprints, streams tmp/AB_concat.wav as binary PCM at realtime,
 * and prints every final / interim / speaker_identified the server emits — so we
 * can confirm the server attributes the A half and the B half to DIFFERENT client
 * `speaker` ids (and the right NAMES when enrolled).
 *
 * Prereq: server running (npm run dev:server). To enroll, this script first
 * embeds speakerA/B itself via the same factory, so the names should match.
 *
 * Usage:
 *   npx tsx scripts/replay-ws-server.mts                       # unknown-cluster
 *   npx tsx scripts/replay-ws-server.mts --enroll              # enroll A=Alice B=Bob
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createEmbeddingProvider } from '../src/server/embedding-provider-factory';
import { detectVoiced } from '../src/server/vad';

const URL = process.env.WS_URL || 'ws://localhost:8080';
const enroll = process.argv.includes('--enroll');
const SR = 16000, BPS = SR * 2;

function toRawPcm(path: string): Uint8Array {
  const tmp = `/tmp/_rws_${Math.abs(path.length)}.raw`;
  execSync(`ffmpeg -loglevel error -y -i "${path}" -ar 16000 -ac 1 -f s16le "${tmp}"`);
  return new Uint8Array(readFileSync(tmp));
}

// Build voiceprints up front (same embedder the server uses) if --enroll.
let voiceprints: Array<{ id: string; name: string; embedding: number[] }> = [];
if (enroll) {
  const provider = await createEmbeddingProvider();
  const mk = async (id: string, name: string, path: string) => {
    const pcm = toRawPcm(path);
    const v = detectVoiced(pcm);
    const embedding = await provider.extractEmbedding(v.voicedMs >= 300 ? v.voiced : pcm, SR);
    return { id, name, embedding };
  };
  voiceprints = [
    await mk('a', 'Alice', 'tmp/speakerA.mp3'),
    await mk('b', 'Bob', 'tmp/speakerB.mp3'),
  ];
  console.log(`Prepared voiceprints: ${voiceprints.map((v) => v.name).join(', ')}`);
}

const pcm = toRawPcm('tmp/AB_concat.wav');
console.log(`▶ tmp/AB_concat.wav: ${(pcm.length / BPS).toFixed(1)}s | mode=${enroll ? 'ENROLLED' : 'UNKNOWN-CLUSTER'} → ${URL}\n`);

const ws = new WebSocket(URL);

ws.on('open', () => {
  // Browser-style config (micAgc off — we send already-clean PCM).
  ws.send(JSON.stringify({ type: 'config', language: 'multi', smartFormat: true, profanityFilter: false, micAgc: false }));
  if (voiceprints.length) {
    ws.send(JSON.stringify({ type: 'load_voiceprints', voiceprints }));
  }
  // Stream at ~realtime so Deepgram's diarizer behaves like it would live.
  const CHUNK = 1600; // 50ms @ 16k/16-bit
  let i = 0;
  const pump = setInterval(() => {
    if (i >= pcm.length) {
      clearInterval(pump);
      // Let the tail finalize, then close.
      setTimeout(() => { try { ws.close(); } catch {} }, 4000);
      return;
    }
    ws.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
    i += CHUNK;
  }, 50);
});

let lastSpeaker: number | null = null;
ws.on('message', (raw) => {
  let msg: any;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  switch (msg.type) {
    case 'server_ready':
      console.log(`✅ server_ready (${msg.config?.language})\n`);
      break;
    case 'speaker_identified':
      console.log(`   👤 speaker_identified: client ${msg.speakerIndex} → "${msg.name}" (conf ${Number(msg.confidence).toFixed(2)})`);
      break;
    case 'speaker_unidentified':
      console.log(`   ↩︎ speaker_unidentified: client ${msg.speakerIndex}`);
      break;
    case 'final': {
      const mark = msg.speaker !== lastSpeaker ? '🆕' : '  ';
      lastSpeaker = msg.speaker;
      console.log(`${mark} FINAL speaker=${msg.speaker}  "${String(msg.text).slice(0, 55)}"`);
      break;
    }
    case 'error':
      console.error(`❌ server error: ${msg.message || msg.code}`);
      break;
  }
});

ws.on('close', () => {
  console.log(`\nGATE: the A-half finals should carry one speaker id and the B-half a DIFFERENT one`);
  console.log(`(with speaker_identified naming them Alice/Bob when --enroll). Done.`);
  process.exit(0);
});

ws.on('error', (e) => { console.error('WS error:', (e as any)?.message || e); process.exit(1); });
