/**
 * LiveCaption — G2 Glasses App
 *
 * Main entry point for the glasses-side logic.
 * Captures audio from the G2 mic (or browser mic as fallback),
 * streams to the backend, and renders live transcription.
 *
 * Auto-detects environment:
 * - G2 glasses: uses bridge for audio + display
 * - Browser: uses getUserMedia + canvas simulator
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
import { BrowserAudioCapture } from './browser-audio';
import { DisplaySimulator } from './display-simulator';
import { SettingsManager } from './settings-manager';
import type { LiveCaptionSettings, ConfigMessage } from '../types/settings';

// Server URL — configurable via window global or defaults to same host
const WS_URL = (window as any).__LIVECAPTION_WS_URL__
  || `ws://${window.location.hostname}:8080`;

type AppMode = 'glasses' | 'browser';

export class LiveCaptionApp {
  private bridge: EvenAppBridge | null = null;
  private browserAudio: BrowserAudioCapture | null = null;
  private displaySim: DisplaySimulator | null = null;
  private display = new TranscriptDisplay();
  private ws: WebSocket | null = null;
  private isListening = false;
  private mode: AppMode = 'browser';
  private containerId = 1;
  private containerName = 'caption';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderedText = '';

  readonly settings = new SettingsManager();

  // Callbacks for UI integration
  onStatusChange?: (status: string, connected: boolean) => void;
  onTranscriptUpdate?: (text: string) => void;

  async init(): Promise<void> {
    // Listen for settings changes
    this.settings.onChange((s) => this.onSettingsChanged(s));

    // Detect environment
    this.mode = await this.detectMode();
    console.log(`[LiveCaption] Mode: ${this.mode}`);

    if (this.mode === 'glasses') {
      await this.initGlasses();
    } else {
      this.initBrowser();
    }

    // Connect to transcription server
    this.connectWebSocket();
  }

  private async detectMode(): Promise<AppMode> {
    try {
      const bridge = await Promise.race([
        waitForEvenAppBridge(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
      if (bridge) {
        this.bridge = bridge;
        return 'glasses';
      }
    } catch {
      // Bridge not available
    }
    return 'browser';
  }

  // ─── Settings ───────────────────────────────────────────────

  private onSettingsChanged(settings: LiveCaptionSettings): void {
    // Send config update to server
    this.sendConfig(settings);
  }

  private sendConfig(settings: LiveCaptionSettings): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const msg: ConfigMessage = {
      type: 'config',
      language: settings.language.code,
      smartFormat: settings.smartFormat,
      profanityFilter: settings.profanityFilter,
    };
    this.ws.send(JSON.stringify(msg));
    console.log(`[LiveCaption] Config sent: lang=${msg.language}`);
  }

  // ─── Glasses Mode ───────────────────────────────────────────

  private async initGlasses(): Promise<void> {
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
    await this.bridge!.createStartUpPageContainer(startup);

    this.bridge!.onEvenHubEvent((event) => {
      if (event.audioEvent?.audioPcm && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.audioEvent.audioPcm);
      }
      const eventType = event.textEvent?.eventType ?? event.sysEvent?.eventType;
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        this.toggleListening();
      }
    });

    await this.bridge!.audioControl(true);
    this.isListening = true;
    this.setStatus('Listening...', true);
  }

  private async updateGlassesDisplay(text: string): Promise<void> {
    try {
      await this.bridge!.textContainerUpgrade(new TextContainerUpgrade({
        containerID: this.containerId,
        containerName: this.containerName,
        contentOffset: 0,
        contentLength: text.length,
        content: text,
      }));
    } catch (err) {
      console.error('[LiveCaption] Glasses display update failed:', err);
    }
  }

  // ─── Browser Mode ───────────────────────────────────────────

  private initBrowser(): void {
    const simContainer = document.getElementById('glasses-sim');
    if (simContainer) {
      this.displaySim = new DisplaySimulator(simContainer, 1);
      this.displaySim.startAnimation();
    }

    this.browserAudio = new BrowserAudioCapture();
    this.browserAudio.onData((pcm) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(pcm);
      }
    });

    this.setStatus('Ready — click Start to begin', false);
  }

  async toggleBrowserCapture(): Promise<void> {
    if (!this.browserAudio) return;

    if (this.browserAudio.isCapturing) {
      await this.browserAudio.stop();
      this.isListening = false;
      this.display.addFinal(-1, '── Paused ──');
      this.setStatus('Paused', false);
    } else {
      await this.browserAudio.start();
      this.isListening = true;
      this.display.addFinal(-1, '── Resumed ──');
      this.setStatus('Listening...', true);
    }
    this.updateDisplay();
  }

  // ─── Shared Logic ───────────────────────────────────────────

  private connectWebSocket(): void {
    console.log(`[LiveCaption] Connecting to ${WS_URL}`);
    this.setStatus('Connecting to server...', false);
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('[LiveCaption] Server connected');
      // Send current settings on connect
      this.sendConfig(this.settings.current);
      this.setStatus(this.isListening ? 'Listening...' : 'Connected — ready', true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'server_ready') {
          const lang = msg.config?.language || 'multi';
          this.setStatus(
            this.isListening ? `Listening (${lang})...` : `Connected (${lang})`,
            true,
          );
          return;
        }
        this.handleTranscript(msg);
      } catch (err) {
        console.error('[LiveCaption] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[LiveCaption] Server disconnected');
      this.setStatus('Disconnected — reconnecting...', false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setStatus('Connection error', false);
    };
  }

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

  private updateDisplay(): void {
    const text = this.display.render();
    if (text === this.lastRenderedText) return;
    this.lastRenderedText = text;

    if (this.mode === 'glasses') {
      this.updateGlassesDisplay(text);
    } else if (this.displaySim) {
      this.displaySim.update(text);
    }

    if (this.onTranscriptUpdate) {
      this.onTranscriptUpdate(text);
    }
  }

  private async toggleListening(): Promise<void> {
    if (this.mode === 'glasses') {
      if (this.isListening) {
        await this.bridge!.audioControl(false);
        this.isListening = false;
        this.display.addFinal(-1, '── Paused ──');
        this.setStatus('Paused', false);
      } else {
        this.display.addFinal(-1, '── Resumed ──');
        await this.bridge!.audioControl(true);
        this.isListening = true;
        this.setStatus('Listening...', true);
      }
      this.updateDisplay();
    } else {
      this.toggleBrowserCapture();
    }
  }

  private setStatus(text: string, connected: boolean): void {
    if (this.onStatusChange) this.onStatusChange(text, connected);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3000);
  }

  clearTranscript(): void {
    this.display.clear();
    this.lastRenderedText = '';
    this.updateDisplay();
  }

  getSpeakers() {
    return this.display.getSpeakers();
  }

  async destroy(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.displaySim?.destroy();
    await this.browserAudio?.stop();
    if (this.mode === 'glasses') {
      await this.bridge?.audioControl(false);
    }
    this.ws?.close();
  }
}
