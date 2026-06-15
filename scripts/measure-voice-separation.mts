/**
 * measure-voice-separation — calibrate acoustic turn detection on REAL voices.
 *
 * Reads recordings from a folder and measures how well the ECAPA embedder
 * separates same-speaker from different-speaker audio, across several window
 * sizes. The output tells us (a) whether acoustic turn detection is viable on
 * the real mic, and (b) the thresholds + minimum window for TurnSegmenter.
 *
 * Expected files in the folder (any audio format — ffmpeg normalizes to 16k mono):
 *   speakerA.*   — ~30s of speaker A alone
 *   speakerB.*   — ~30s of speaker B alone
 *   (optional) interruption.* — A talking, B interrupts (for an end-to-end check)
 *
 * Usage: npx tsx scripts/measure-voice-separation.mts /tmp/voicetest
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createEmbeddingProvider } from '../src/server/embedding-provider-factory';
import { detectVoiced } from '../src/server/vad';
import { cosine } from '../src/server/turn-segmenter';

const dir = process.argv[2] || '/tmp/voicetest';
const WINDOW_MS = [500, 750, 1000, 1500, 2000];

function findFile(prefix: string): string | null {
  const f = readdirSync(dir).find((n) => n.toLowerCase().startsWith(prefix));
  return f ? join(dir, f) : null;
}

function toRaw(path: string): Uint8Array {
  const tmp = `/tmp/_vsep_${prefixHash(path)}.raw`;
  execSync(`ffmpeg -loglevel error -y -i "${path}" -ar 16000 -ac 1 -f s16le "${tmp}"`);
  return new Uint8Array(readFileSync(tmp));
}
function prefixHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

const p = await createEmbeddingProvider();

async function windowsOf(pcm: Uint8Array, ms: number): Promise<number[][]> {
  const bytes = ms * 16 * 2; // ms × 16 samples/ms × 2 bytes
  const out: number[][] = [];
  for (let i = 0; i + bytes <= pcm.length; i += bytes) {
    const seg = pcm.subarray(i, i + bytes);
    const v = detectVoiced(seg);
    if (v.voicedMs < 200) continue; // skip near-silent windows
    out.push(await p.extractEmbedding(v.voicedMs >= 300 ? v.voiced : seg, 16000));
  }
  return out;
}

function pairCosines(xs: number[][], ys: number[][], sameSet: boolean): number[] {
  const v: number[] = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = 0; j < ys.length; j++) {
      if (sameSet && i >= j) continue;
      v.push(cosine(xs[i], ys[j]));
    }
  return v.sort((a, b) => a - b);
}
const pct = (v: number[], q: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : NaN);
const fmt = (v: number[]) =>
  v.length ? `min=${v[0].toFixed(3)} p10=${pct(v, 0.1).toFixed(3)} med=${pct(v, 0.5).toFixed(3)} p90=${pct(v, 0.9).toFixed(3)} max=${v[v.length - 1].toFixed(3)} (n=${v.length})` : '(no windows)';

const aPath = findFile('speakera') || findFile('a');
const bPath = findFile('speakerb') || findFile('b');
if (!aPath || !bPath) {
  console.error(`Need speakerA.* and speakerB.* in ${dir}. Found: ${readdirSync(dir).join(', ') || '(empty)'}`);
  process.exit(1);
}
console.log(`A = ${aPath}\nB = ${bPath}\n`);
const aPcm = toRaw(aPath);
const bPcm = toRaw(bPath);

console.log('Same-speaker (AA, BB) vs different-speaker (AB) cosine by window size:');
console.log('— want: AB max well BELOW AA/BB min, so a threshold cleanly separates them.\n');
for (const ms of WINDOW_MS) {
  const A = await windowsOf(aPcm, ms);
  const B = await windowsOf(bPcm, ms);
  const aa = pairCosines(A, A, true);
  const bb = pairCosines(B, B, true);
  const ab = pairCosines(A, B, false);
  const same = [...aa, ...bb].sort((x, y) => x - y);
  // A good split point sits between the same-speaker p10 and the diff-speaker p90.
  const sameP10 = pct(same, 0.1);
  const diffP90 = pct(ab, 0.9);
  const gap = sameP10 - diffP90;
  const verdict = gap > 0.1 ? '✅ separable' : gap > 0 ? '⚠️ marginal' : '❌ overlapping';
  console.log(`▸ ${ms}ms window`);
  console.log(`   same AA: ${fmt(aa)}`);
  console.log(`   same BB: ${fmt(bb)}`);
  console.log(`   diff AB: ${fmt(ab)}`);
  console.log(`   split-quality: same.p10=${sameP10.toFixed(3)} vs diff.p90=${diffP90.toFixed(3)} → gap=${gap.toFixed(3)} ${verdict}`);
  if (gap > 0) {
    const suggested = (sameP10 + diffP90) / 2;
    console.log(`   → suggested switchThreshold ≈ ${suggested.toFixed(2)} (stay a touch above)`);
  }
  console.log();
}
console.log('Pick the SMALLEST window that is ✅ separable — that is the latency/accuracy sweet spot.');
