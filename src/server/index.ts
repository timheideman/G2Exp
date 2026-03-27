/**
 * LiveCaption WebSocket Proxy Server
 *
 * - Waits for BOTH config AND first audio before opening Deepgram
 * - Sends keepalive to prevent Deepgram timeout during silence
 * - Reconnects Deepgram if connection drops while client is active
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';

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
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunkCount = 0;
  let closing = false;

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
      smart_format: cfg.smartFormat,
      diarize: true,
      interim_results: true,
      utterance_end_ms: 2000,
      vad_events: true,
      profanity_filter: cfg.profanityFilter,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      // Disable browser-side audio processing hints so Deepgram gets raw audio
      multichannel: false,
      no_delay: true,
      endpointing: 300,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`✅ Deepgram ready (lang=${cfg.language})`);
      isDeepgramOpen = true;
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

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;

      const isFinal = data.is_final;
      const words = alt.words || [];

      // Log speaker data from Deepgram for debugging
      const speakerValues = words.map((w: any) => w.speaker);
      const uniqueSpeakers = [...new Set(speakerValues.filter((s: any) => s !== undefined))];
      if (isFinal) {
        console.log(`📝 [${isFinal ? 'FINAL' : 'interim'}] speakers=${JSON.stringify(uniqueSpeakers)} text="${alt.transcript.substring(0, 60)}"`);
      }

      // Determine primary speaker
      const speakerCounts = new Map<number, number>();
      for (const w of words) {
        if (w.speaker !== undefined) {
          speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
        }
      }
      let speaker = 0;
      let maxCount = 0;
      for (const [s, c] of speakerCounts) {
        if (c > maxCount) { speaker = s; maxCount = c; }
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: isFinal ? 'final' : 'interim',
          speaker,
          text: alt.transcript,
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
    });

    dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'utterance_end', timestamp: Date.now() }));
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('❌ Deepgram error:', err);
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

  function startKeepalive(): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (dgConnection && isDeepgramOpen) {
        try {
          dgConnection.keepAlive();
        } catch {}
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
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;

    audioChunkCount++;

    // Log first audio arrival
    if (audioChunkCount === 1) {
      console.log('🎤 First audio chunk received');
    }

    // Log periodically
    if (audioChunkCount % 500 === 0) {
      console.log(`🎤 Audio chunks: ${audioChunkCount}`);
    }

    // Open Deepgram on first audio if we have config but no connection
    if (!dgConnection && config) {
      console.log('🎤 Audio arrived — opening Deepgram...');
      openDeepgram(config);
    }

    if (isDeepgramOpen && dgConnection) {
      dgConnection.send(arrayBuffer);
    }
    // If Deepgram isn't open yet, audio is lost — but openDeepgram was triggered
    // and will start receiving subsequent chunks once ready
  }

  // Handle messages from client
  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      sendAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'config') {
          const newConfig: SessionConfig = {
            language: msg.language || 'nl',
            smartFormat: msg.smartFormat ?? true,
            profanityFilter: msg.profanityFilter ?? false,
          };

          const configChanged = !config
            || newConfig.language !== config.language
            || newConfig.smartFormat !== config.smartFormat
            || newConfig.profanityFilter !== config.profanityFilter;

          config = newConfig;
          console.log(`⚙️  Config: lang=${config.language}, smart=${config.smartFormat}, profanity=${config.profanityFilter}`);

          // Only reopen if Deepgram is already running and config changed
          if (configChanged && dgConnection) {
            openDeepgram(config);
          }
          // If no dgConnection yet, it'll open when first audio arrives
        }
      } catch (err) {
        console.error('❌ Parse error:', err);
      }
    }
  });

  clientWs.on('close', () => {
    console.log(`📱 Client disconnected (${audioChunkCount} audio chunks sent)`);
    closing = true;
    stopKeepalive();
    if (dgConnection && isDeepgramOpen) {
      try { dgConnection.requestClose(); } catch {}
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ Client error:', err);
  });
});
