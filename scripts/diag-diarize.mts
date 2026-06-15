/**
 * diag-diarize — stream a raw PCM file to Deepgram with the SAME params the
 * server uses, and print per-word speaker runs for every interim + final.
 *
 * Purpose: ground-truth what the streaming diarizer does during an interruption.
 *   • runs split across speakers on a FINAL  → Deepgram detects it; our job is
 *     just to render the runs (client was discarding them).
 *   • runs split on INTERIMS too             → worth splitting live (interim runs).
 *   • everything stays on ONE index          → provider miss; needs voiceprint
 *                                               re-segmentation, not just rendering.
 *
 * Usage: npx tsx scripts/diag-diarize.mts /tmp/dgtest/mixed.raw
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const file = process.argv[2] || '/tmp/dgtest/mixed.raw';
const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) { console.error('DEEPGRAM_API_KEY not set'); process.exit(1); }

const region = (process.env.DG_REGION || 'eu') === 'eu' ? 'https://api.eu.deepgram.com' : undefined;
const dg = createClient(KEY, { global: { url: region } });

const pcm = readFileSync(file);
console.log(`▶ streaming ${pcm.length} bytes (${(pcm.length / (16000 * 2)).toFixed(1)}s) from ${file}`);

const conn = dg.listen.live({
  model: process.env.DG_MODEL || 'nova-3',
  language: process.env.DG_LANGUAGE || 'multi',
  smart_format: false,
  punctuate: true,
  numerals: true,
  diarize: true,
  interim_results: true,
  utterance_end_ms: 1000,
  vad_events: true,
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
  no_delay: true,
  endpointing: 200,
});

function runs(words: any[]): string {
  const out: Array<{ s: number; t: string }> = [];
  for (const w of words) {
    const s = w.speaker ?? 0;
    const tok = w.punctuated_word || w.word || '';
    const last = out[out.length - 1];
    if (last && last.s === s) last.t += ` ${tok}`;
    else out.push({ s, t: tok });
  }
  return out.map((r) => `[${r.s}]"${r.t}"`).join('  |  ');
}

conn.on(LiveTranscriptionEvents.Open, async () => {
  // Feed in ~50ms chunks (1600 bytes), real-time paced, like the live mic.
  const CHUNK = 1600;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    conn.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
    await new Promise((r) => setTimeout(r, 50));
  }
  // Flush + close after a moment so trailing finals arrive.
  setTimeout(() => { try { conn.requestClose(); } catch {} }, 2500);
});

conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
  const alt = data.channel?.alternatives?.[0];
  if (!alt?.transcript?.trim()) return;
  const words = alt.words || [];
  const uniq = [...new Set(words.map((w: any) => w.speaker).filter((s: any) => s !== undefined))];
  const split = uniq.length > 1 ? ' «SPLIT»' : '';
  const kind = data.is_final ? 'FINAL  ' : 'interim';
  console.log(`${kind} spk=${JSON.stringify(uniq)}${split}  ${runs(words)}`);
});

conn.on(LiveTranscriptionEvents.UtteranceEnd, () => console.log('— UtteranceEnd —'));
conn.on(LiveTranscriptionEvents.Error, (e: any) => console.error('DG error:', e?.message || e));
conn.on(LiveTranscriptionEvents.Close, () => { console.log('✔ done'); process.exit(0); });
