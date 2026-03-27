/**
 * LiveCaption WebSocket Proxy Server
 *
 * Sits between the G2 glasses (via phone WebView) and Deepgram's streaming API.
 * - Receives raw PCM audio and config messages from the client
 * - Forwards audio to Deepgram with diarization enabled
 * - Sends back structured transcript messages
 * - Supports runtime language/config changes
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';

const PORT = parseInt(process.env.WS_PORT || '8080', 10);
const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const DG_MODEL = process.env.DG_MODEL || 'nova-3';
const DG_LANGUAGE = process.env.DG_LANGUAGE || 'multi';
const DG_REGION = process.env.DG_REGION || 'eu';

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

const wss = new WebSocketServer({ port: PORT });
console.log(`🎙️  LiveCaption server listening on ws://0.0.0.0:${PORT}`);

/** Session config — can be changed at runtime */
interface SessionConfig {
  language: string;
  smartFormat: boolean;
  profanityFilter: boolean;
}

function createDeepgramConnection(
  clientWs: WebSocket,
  config: SessionConfig,
): { connection: ListenLiveClient; isOpen: () => boolean } {
  let isDeepgramOpen = false;

  const dgConnection = deepgram.listen.live({
    model: DG_MODEL,
    language: config.language,
    smart_format: config.smartFormat,
    diarize: true,
    interim_results: true,
    utterance_end_ms: 1500,
    vad_events: true,
    profanity_filter: config.profanityFilter,
    // G2 mic format: 16kHz, 16-bit signed LE, mono
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log(`🔗 Deepgram connected (lang=${config.language})`);
    isDeepgramOpen = true;

    // Notify client that connection is ready
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'server_ready',
        config: {
          language: config.language,
          smartFormat: config.smartFormat,
          profanityFilter: config.profanityFilter,
        },
      }));
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alternatives = data.channel?.alternatives;
    if (!alternatives || alternatives.length === 0) return;

    const alt = alternatives[0];
    const transcript = alt.transcript;
    if (!transcript || transcript.trim() === '') return;

    const isFinal = data.is_final;
    const words = alt.words || [];

    // Determine primary speaker from words
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

  return {
    connection: dgConnection,
    isOpen: () => isDeepgramOpen,
  };
}

wss.on('connection', (clientWs: WebSocket) => {
  console.log('📱 Client connected');

  let config: SessionConfig = {
    language: DG_LANGUAGE,
    smartFormat: true,
    profanityFilter: false,
  };

  let dg = createDeepgramConnection(clientWs, config);

  // Handle messages from client (audio binary or JSON config)
  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Binary = PCM audio data
      if (dg.isOpen()) {
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        dg.connection.send(arrayBuffer);
      }
    } else {
      // Text = JSON config message
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'config') {
          console.log(`⚙️  Config update: lang=${msg.language}, smart=${msg.smartFormat}, profanity=${msg.profanityFilter}`);

          const newConfig: SessionConfig = {
            language: msg.language || config.language,
            smartFormat: msg.smartFormat ?? config.smartFormat,
            profanityFilter: msg.profanityFilter ?? config.profanityFilter,
          };

          // Only reconnect Deepgram if config actually changed
          if (
            newConfig.language !== config.language ||
            newConfig.smartFormat !== config.smartFormat ||
            newConfig.profanityFilter !== config.profanityFilter
          ) {
            config = newConfig;
            console.log('🔄 Reconnecting Deepgram with new config...');

            // Close old connection
            if (dg.isOpen()) {
              dg.connection.requestClose();
            }

            // Open new connection with updated config
            dg = createDeepgramConnection(clientWs, config);
          }
        }
      } catch (err) {
        console.error('❌ Failed to parse config message:', err);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('📱 Client disconnected');
    if (dg.isOpen()) {
      dg.connection.requestClose();
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client WebSocket error:', err);
  });
});
