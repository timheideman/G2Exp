/**
 * LiveCaption — G2 Glasses App
 *
 * Main entry point for the glasses-side logic.
 * Captures audio from the G2 mic, streams to the backend,
 * and renders live transcription on the glasses display.
 */

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { TranscriptDisplay } from './transcript-display';

// Configuration — server URL is injected at build time or passed via settings
const WS_URL = (window as any).__LIVECAPTION_WS_URL__
  || `ws://${window.location.hostname}:8080`;

export class LiveCaptionApp {
  private bridge!: EvenAppBridge;
  private display = new TranscriptDisplay();
  private ws: WebSocket | null = null;
  private isListening = false;
  private containerId = 1;
  private containerName = 'caption';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderedText = '';

  async init(): Promise<void> {
    // Wait for the G2 bridge to be ready
    this.bridge = await waitForEvenAppBridge();
    console.log('[LiveCaption] Bridge ready');

    // Create the initial display
    await this.createDisplay();

    // Set up input event handling
    this.bridge.onEvenHubEvent((event) => {
      this.handleEvent(event);
    });

    // Connect to transcription server
    this.connectWebSocket();

    // Start capturing audio
    await this.startAudio();
  }

  /** Create the initial glasses display — single text container fills the screen */
  private async createDisplay(): Promise<void> {
    const container = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: 6,
      containerID: this.containerId,
      containerName: this.containerName,
      content: '  LiveCaption\n\n  Connecting...',
      isEventCapture: 1,
    });

    const startup = new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [container],
    });
    await this.bridge.createStartUpPageContainer(startup);
    console.log('[LiveCaption] Display created');
  }

  /** Update the glasses display with current transcript */
  private async updateDisplay(): Promise<void> {
    const text = this.display.render();

    // Skip update if nothing changed
    if (text === this.lastRenderedText) return;
    this.lastRenderedText = text;

    try {
      await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: this.containerId,
        containerName: this.containerName,
        contentOffset: 0,
        contentLength: text.length,
        content: text,
      }));
    } catch (err) {
      console.error('[LiveCaption] Display update failed:', err);
    }
  }

  /** Connect to the backend WebSocket proxy */
  private connectWebSocket(): void {
    console.log(`[LiveCaption] Connecting to ${WS_URL}`);
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('[LiveCaption] Server connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleTranscript(msg);
      } catch (err) {
        console.error('[LiveCaption] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[LiveCaption] Server disconnected, reconnecting in 3s...');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[LiveCaption] WebSocket error:', err);
    };
  }

  /** Handle incoming transcript messages from the server */
  private handleTranscript(msg: any): void {
    switch (msg.type) {
      case 'final':
        this.display.addFinal(msg.speaker, msg.text);
        break;
      case 'interim':
        this.display.updateInterim(msg.speaker, msg.text);
        break;
      case 'utterance_end':
        this.display.onUtteranceEnd();
        break;
    }
    this.updateDisplay();
  }

  /** Start capturing audio from G2 mic and streaming to server */
  private async startAudio(): Promise<void> {
    // Register audio event handler BEFORE enabling mic
    this.bridge.onEvenHubEvent((event) => {
      if (event.audioEvent?.audioPcm && this.ws?.readyState === WebSocket.OPEN) {
        // Forward raw PCM directly to the server
        this.ws.send(event.audioEvent.audioPcm);
      }
    });

    // Open the G2 microphone
    await this.bridge.audioControl(true);
    this.isListening = true;
    console.log('[LiveCaption] Audio capture started');
  }

  /** Stop audio capture */
  private async stopAudio(): Promise<void> {
    await this.bridge.audioControl(false);
    this.isListening = false;
    console.log('[LiveCaption] Audio capture stopped');
  }

  /** Handle G2 input events (tap, double-tap, scroll) */
  private handleEvent(event: any): void {
    // Double-tap to toggle listening
    const eventType = event.textEvent?.eventType ?? event.sysEvent?.eventType;
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      this.toggleListening();
    }
    // Click to clear transcript
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      // Single tap — no-op for now, could cycle display modes
    }
  }

  /** Toggle audio capture on/off */
  private async toggleListening(): Promise<void> {
    if (this.isListening) {
      await this.stopAudio();
      this.display.addFinal(-1, '── Paused ──');
      this.updateDisplay();
    } else {
      this.display.addFinal(-1, '── Resumed ──');
      await this.startAudio();
      this.updateDisplay();
    }
  }

  /** Reconnect with backoff */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3000);
  }

  /** Clean shutdown */
  async destroy(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.stopAudio();
    this.ws?.close();
  }
}
