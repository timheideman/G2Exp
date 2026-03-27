/**
 * LiveCaption WebSocket Proxy Server
 *
 * Sits between the G2 glasses (via phone WebView) and Deepgram's streaming API.
 * - Waits for client config before opening Deepgram connection
 * - Receives raw PCM audio and forwards to Deepgram
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

interface SessionConfig {
  language: string;
  smartFormat: boolean;
  profanityFilter: boolean;
}

wss.on('connection', (clientWs: WebSocket) => {
  console.log('📱 Client connected');

  let config: SessionConfig | null = null;
  let dgConnection: ListenLiveClient | null = null;
  let isDeepgramOpen = false;
  let audioQueue: ArrayBuffer[] = []; // Buffer audio until Deepgram is ready

  function openDeepgram(cfg: SessionConfig): void {
    // Close existing connection if any
    if (dgConnection && isDeepgramOpen) {
      console.log('🔄 Closing old Deepgram connection...');
      isDeepgramOpen = false;
      dgConnection.requestClose();
      dgConnection = null;
    }

    console.log(`🔗 Opening Deepgram (lang=${cfg.language}, model=${DG_MODEL})...`);

    dgConnection = deepgram.listen.live({
      model: DG_MODEL,
      language: cfg.language,
      smart_format: cfg.smartFormat,
      diarize: true,
      interim_results: true,
      utterance_end_ms: 1500,
      vad_events: true,
      profanity_filter: cfg.profanityFilter,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`✅ Deepgram ready (lang=${cfg.language})`);
      isDeepgramOpen = true;

      // Flush any queued audio
      if (audioQueue.length > 0) {
        console.log(`📤 Flushing ${audioQueue.length} queued audio chunks`);
        for (const chunk of audioQueue) {
          dgConnection!.send(chunk);
        }
        audioQueue = [];
      }

      // Notify client
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

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alternatives = data.channel?.alternatives;
      if (!alternatives || alternatives.length === 0) return;

      const alt = alternatives[0];
      const transcript = alt.transcript;
      if (!transcript || transcript.trim() === '') return;

      const isFinal = data.is_final;
      const words = alt.words || [];

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
  }

  // Handle messages from client
  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Binary = PCM audio
      const arrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;

      if (isDeepgramOpen && dgConnection) {
        dgConnection.send(arrayBuffer);
      } else if (config) {
        // Deepgram not ready yet — queue the audio
        audioQueue.push(arrayBuffer);
        // Cap the queue (don't buffer more than ~5s of audio)
        if (audioQueue.length > 250) {
          audioQueue.shift();
        }
      }
    } else {
      // Text = JSON config
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'config') {
          const newConfig: SessionConfig = {
            language: msg.language || 'nl',
            smartFormat: msg.smartFormat ?? true,
            profanityFilter: msg.profanityFilter ?? false,
          };

          // Only open/reopen if config changed or first config
          const configChanged = !config
            || newConfig.language !== config.language
            || newConfig.smartFormat !== config.smartFormat
            || newConfig.profanityFilter !== config.profanityFilter;

          config = newConfig;

          if (configChanged) {
            console.log(`⚙️  Config: lang=${config.language}, smart=${config.smartFormat}, profanity=${config.profanityFilter}`);
            openDeepgram(config);
          }
        }
      } catch (err) {
        console.error('❌ Failed to parse config:', err);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('📱 Client disconnected');
    audioQueue = [];
    if (isDeepgramOpen && dgConnection) {
      dgConnection.requestClose();
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client error:', err);
  });
});
