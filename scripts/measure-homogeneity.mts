/**
 * measure-homogeneity — calibrate the segment-homogeneity half-split threshold
 * (SEGMENT_MIN_HALF_SIM) for the ACTIVE embedder, on real audio.
 *
 * The guard splits a ~1.5s window in half, embeds each half, and rejects the
 * window if the two halves' cosine is below the threshold (→ "two voices"). Its
 * default 0.5 is a guess (HANDOFF). This script measures the real distribution:
 *
 *   SAME-speaker windows  : consecutive ~1.5s windows cut from speakerA / speakerB
 *                           alone — every half is the same person. (These MUST
 *                           pass; their half-sim is the floor.)
 *   MIXED windows         : first half from A, second half from B — a genuine
 *                           A↔B straddle. (These SHOULD be rejected; their
 *                           half-sim is the ceiling.)
 *
 * A usable threshold sits between the SAME floor and the MIXED ceiling. If they
 * overlap, the half-split test cannot separate them at this window/embedder and
 * the guard should be loosened or dropped (it would block real speech).
 *
 * Usage: npx tsx scripts/measure-homogeneity.mts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createEmbeddingProvider } from '../src/server/embedding-provider-factory';
import { detectVoiced } from '../src/server/vad';
import { assessSegmentHomogeneity } from '../src/server/segment-homogeneity';

const SR = 16000, BPS = SR * 2;
const WINDOW_MS = Number(process.env.WINDOW_MS || 1500);

function toRaw(path: string): Uint8Array {
  const tmp = `/tmp/_mh_${Math.abs(path.length)}.raw`;
  execSync(`ffmpeg -loglevel error -y -i "${path}" -ar 16000 -ac 1 -f s16le "${tmp}"`);
  return new Uint8Array(readFileSync(tmp));
}

const provider = await createEmbeddingProvider();
const extract = (pcm: Uint8Array, sr: number) => provider.extractEmbedding(pcm, sr);

const A = toRaw('tmp/speakerA.mp3');
const B = toRaw('tmp/speakerB.mp3');
const winBytes = (WINDOW_MS * 16 * 2) & ~1;
const fmt = (v: number[]) =>
  v.length ? `min=${v[0].toFixed(2)} p10=${v[Math.floor(0.1 * v.length)].toFixed(2)} med=${v[Math.floor(0.5 * v.length)].toFixed(2)} max=${v[v.length - 1].toFixed(2)} (n=${v.length})` : '(none)';

// Build VAD-trimmed ~WINDOW_MS windows from one speaker (all halves are SAME).
async function sameHalfSims(pcm: Uint8Array): Promise<number[]> {
  const sims: number[] = [];
  for (let i = 0; i + winBytes <= pcm.length; i += winBytes) {
    const v = detectVoiced(pcm.subarray(i, i + winBytes));
    if (v.voicedMs < 600) continue;
    const r = await assessSegmentHomogeneity(v.voiced, extract, { minHalfSimilarity: 0 });
    if (r.halfSimilarity !== null) sims.push(r.halfSimilarity);
  }
  return sims.sort((x, y) => x - y);
}

// MIXED windows: first half from A, second half from B (a real straddle).
async function mixedHalfSims(): Promise<number[]> {
  const sims: number[] = [];
  const half = (winBytes >> 1) & ~1;
  const aV = detectVoiced(A).voiced;
  const bV = detectVoiced(B).voiced;
  const n = Math.min(Math.floor(aV.length / half), Math.floor(bV.length / half));
  for (let i = 0; i < n; i++) {
    const w = new Uint8Array(half * 2);
    w.set(aV.subarray(i * half, i * half + half), 0);
    w.set(bV.subarray(i * half, i * half + half), half);
    const r = await assessSegmentHomogeneity(w, extract, { minHalfSimilarity: 0 });
    if (r.halfSimilarity !== null) sims.push(r.halfSimilarity);
  }
  return sims.sort((x, y) => x - y);
}

const same = [...(await sameHalfSims(A)), ...(await sameHalfSims(B))].sort((x, y) => x - y);
const mixed = await mixedHalfSims();

console.log(`\nHalf-split cosine at ${WINDOW_MS}ms windows (ONNX embedder):`);
console.log(`  SAME-speaker halves : ${fmt(same)}   ← must PASS`);
console.log(`  MIXED A|B halves    : ${fmt(mixed)}   ← should be REJECTED`);
const sameFloor = same.length ? same[Math.floor(0.1 * same.length)] : NaN; // p10
const mixedCeil = mixed.length ? mixed[Math.floor(0.9 * mixed.length)] : NaN; // p90
const gap = sameFloor - mixedCeil;
console.log(`\n  same.p10=${sameFloor.toFixed(2)} vs mixed.p90=${mixedCeil.toFixed(2)} → gap=${gap.toFixed(2)} ${gap > 0.05 ? '✅ separable' : '❌ overlapping — guard not viable at this window'}`);
if (gap > 0) console.log(`  → suggested SEGMENT_MIN_HALF_SIM ≈ ${((sameFloor + mixedCeil) / 2).toFixed(2)}`);
process.exit(0);
