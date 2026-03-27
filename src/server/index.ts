/**
 * LiveCaption WebSocket Proxy Server
 *
 * Sits between the G2 glasses (via phone WebView) and Deepgram's streaming API.
 * - Receives raw PCM audio from the client
 * - Forwards to Deepgram with diarization enabled
 * - Sends back structured transcript messages
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const PORT = parseInt(process.env.WS_PORT || '8080', 10);
const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const DG_MODEL = process.env.DG_MODEL || 'nova-3';
const DG_LANGUAGE = process.env.DG_LANGUAGE || 'multi';
const DG_REGION = process.env.DG_REGION || 'eu';

if (!DG_API_KEY) {
  console.error('❌ DEEPGRAM_API_KEY not set in .env');
  process.exit(1);
}

// Use EU endpoint if configured
const deepgramUrl = DG_REGION === 'eu'
  ? 'https://api.eu.deepgram.com'
  : undefined;

const deepgram = createClient(DG_API_KEY, {
  global: { url: deepgramUrl },
});

const wss = new WebSocketServer({ port: PORT });
console.log(`🎙️  LiveCaption server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (clientWs: WebSocket) => {
  console.log('📱 Client connected');

  // Open a live transcription session to Deepgram
  const dgConnection = deepgram.listen.live({
    model: DG_MODEL,
    language: DG_LANGUAGE,
    smart_format: true,
    diarize: true,
    interim_results: true,
    utterance_end_ms: 1500,
    vad_events: true,
    // G2 mic format: 16kHz, 16-bit signed LE, mono
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
  });

  let isDeepgramOpen = false;

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('🔗 Deepgram connection open');
    isDeepgramOpen = true;
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alternatives = data.channel?.alternatives;
    if (!alternatives || alternatives.length === 0) return;

    const alt = alternatives[0];
    const transcript = alt.transcript;
    if (!transcript || transcript.trim() === '') return;

    const isFinal = data.is_final;
    const words = alt.words || [];

    // Determine primary speaker from words (most frequent speaker in this segment)
    const speakerCounts = new Map<number, number>();
    for (const w of words) {
      if (w.speaker !== undefined) {
        speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
      }
    }
    let speaker = 0;
    let maxCount = 0;
    for (const [s, c] of speakerCounts) {
      if (c > maxCount) {
        speaker = s;
        maxCount = c;
      }
    }

    const message = {
      type: isFinal ? 'final' : 'interim',
      speaker,
      text: transcript,
      timestamp: Date.now(),
      isFinal,
      // Include per-word speaker info for multi-speaker segments
      words: words.map((w: any) => ({
        word: w.punctuated_word || w.word,
        speaker: w.speaker ?? 0,
        start: w.start,
        end: w.end,
      })),
    };

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(message));
    }
  });

  dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Signal that an utterance boundary was detected
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'utterance_end',
        timestamp: Date.now(),
      }));
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('❌ Deepgram error:', err);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log('🔌 Deepgram connection closed');
    isDeepgramOpen = false;
  });

  // Receive audio from client and forward to Deepgram
  clientWs.on('message', (data: Buffer) => {
    if (isDeepgramOpen) {
      // Convert Buffer to ArrayBuffer for Deepgram SDK compatibility
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      dgConnection.send(arrayBuffer);
    }
  });

  clientWs.on('close', () => {
    console.log('📱 Client disconnected');
    if (isDeepgramOpen) {
      dgConnection.requestClose();
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client WebSocket error:', err);
  });
});
