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

// Even Hub SDK is loaded dynamically — it crashes in regular browsers
// import { ... } from '@evenrealities/even_hub_sdk';
import { TranscriptDisplay } from './transcript-display';
import { BrowserAudioCapture } from './browser-audio';
import { DisplaySimulator } from './display-simulator';
import { SettingsManager } from './settings-manager';
import { ReconnectScheduler } from './settings-manager';
import { NameAlertDetector } from './name-alert-detector';
import type { LiveCaptionSettings, ConfigMessage } from '../types/settings';

// Server URL — configurable via window global or auto-detected from current page
// Dev  (HTTP):  ws://localhost:8080
// Prod (HTTPS): wss://livecaption.astralate.com/ws
function resolveWsUrl(): string {
  if ((window as any).__LIVECAPTION_WS_URL__) return (window as any).__LIVECAPTION_WS_URL__;
  const isSecure = window.location.protocol === 'https:';
  if (isSecure) return `wss://${window.location.hostname}/ws`;
  return `ws://${window.location.hostname}:8080`;
}
const WS_URL = resolveWsUrl();

type AppMode = 'glasses' | 'browser';

export class LiveCaptionApp {
  private bridge: any = null; // EvenAppBridge — loaded dynamically
  private sdk: any = null;    // Even Hub SDK module
  private browserAudio: BrowserAudioCapture | null = null;
  private displaySim: DisplaySimulator | null = null;
  readonly display = new TranscriptDisplay();
  private ws: WebSocket | null = null;
  private isListening = false;
  private mode: AppMode = 'browser';
  private containerId = 1;
  private containerName = 'caption';
  private reconnectScheduler = new ReconnectScheduler();
  private lastRenderedText = '';

  readonly settings = new SettingsManager();

  private nameAlert = new NameAlertDetector();

  // Callbacks for UI integration
  onStatusChange?: (status: string, connected: boolean) => void;
  onTranscriptUpdate?: (text: string) => void;
  onNameAlerted?: (label: string) => void;

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
    // Only load the Even Hub SDK if we're inside the Even App WebView
    const win = window as any;
    if (win.EvenAppBridge || win._evenAppBridge || win.flutter_inappwebview) {
      try {
        this.sdk = await import('@evenrealities/even_hub_sdk');
        this.bridge = await this.sdk.waitForEvenAppBridge();
        console.log('[LiveCaption] G2 bridge connected');
        return 'glasses';
      } catch (err) {
        console.log('[LiveCaption] Bridge markers found but init failed:', err);
      }
    }
    console.log('[LiveCaption] No G2 bridge — browser mode');
    return 'browser';
  }

  // ─── Settings ───────────────────────────────────────────────

  private onSettingsChanged(settings: LiveCaptionSettings): void {
    // Send config update to server
    this.sendConfig(settings);
    // Apply display settings immediately
    this.displaySim?.setFontSize(settings.fontSize);
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
    // Hide the desktop simulator — on iPhone the real glasses display is used
    const simContainer = document.querySelector('.sim-container') as HTMLElement | null;
    if (simContainer) simContainer.style.display = 'none';

    // Hide desktop-only hint about mic/port
    const hint = document.querySelector('.hint') as HTMLElement | null;
    if (hint) hint.style.display = 'none';

    // Hide the Start/Pause toggle (audio is controlled by double-tap on glasses)
    const btnToggle = document.getElementById('btn-toggle') as HTMLElement | null;
    if (btnToggle) btnToggle.style.display = 'none';


    const { TextContainerProperty, CreateStartUpPageContainer, OsEventTypeList } = this.sdk;

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

    this.bridge.onEvenHubEvent((event: any) => {
      if (event.audioEvent?.audioPcm && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.audioEvent.audioPcm);
        this.nameAlert.process(event.audioEvent.audioPcm);
      }
      const eventType = event.textEvent?.eventType ?? event.sysEvent?.eventType;
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        this.toggleListening();
      }
    });

    await this.bridge.audioControl(true);
    this.isListening = true;
    this.setStatus('Listening...', true);
  }

  private async updateGlassesDisplay(text: string): Promise<void> {
    try {
      const { TextContainerUpgrade } = this.sdk;
      await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
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
      this.nameAlert.process(pcm);
    });

    this.setStatus('Ready — click Start to begin', false);
  }

  async toggleBrowserCapture(): Promise<void> {
    if (!this.browserAudio) {
      console.error('[LiveCaption] No browserAudio — not in browser mode?');
      this.setStatus('Error: audio not available', false);
      return;
    }

    if (this.browserAudio.isCapturing) {
      await this.browserAudio.stop();
      this.isListening = false;
      this.display.addFinal(-1, '── Paused ──');
      this.display.setPaused(true);
      this.displaySim?.setPaused(true);
      this.setStatus('Paused', false);
    } else {
      this.setStatus('Requesting mic access...', false);
      try {
        await this.browserAudio.start();
        this.isListening = true;
        this.display.setPaused(false);
        this.displaySim?.setPaused(false);
        this.setStatus('Listening (mic active)...', true);
      } catch (err: any) {
        console.error('[LiveCaption] Mic error:', err);
        this.setStatus(`Mic error: ${err.message || 'denied'}`, false);
        return;
      }
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
      this.reconnectScheduler.reset();
      // Send current settings on connect
      this.sendConfig(this.settings.current);
      // Apply current font size to display
      this.displaySim?.setFontSize(this.settings.current.fontSize);
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
      this.reconnectScheduler.schedule(() => this.connectWebSocket());
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



  clearTranscript(): void {
    this.display.clear();
    this.lastRenderedText = '';
    this.updateDisplay();
  }

  getSpeakers() {
    return this.display.getSpeakers();
  }

  // ─── Name Alert ──────────────────────────────────────────────

  /**
   * Initialize the name alert detector with the user's AccessKey and .ppn file.
   * Safe to call multiple times (re-initializes on each call).
   */
  async initNameAlert(
    accessKey: string,
    keywordBuffer: ArrayBuffer,
    label: string,
    sensitivity?: number,
  ): Promise<void> {
    this.nameAlert.onDetected = (lbl) => this.showNameAlert(lbl);
    await this.nameAlert.init(accessKey, keywordBuffer, label, sensitivity);
  }

  /** Expose nameAlert for status inspection from UI code. */
  get nameAlertDetector(): NameAlertDetector {
    return this.nameAlert;
  }

  /**
   * Called when Porcupine detects the wake word.
   * Shows a prominent alert on the glasses display and notifies the companion UI.
   */
  private showNameAlert(label: string): void {
    // Notify companion UI (main.ts wires this up)
    this.onNameAlerted?.(label);

    const alertText = `  👋  ${label.toUpperCase()}`;

    if (this.mode === 'glasses') {
      // Override glasses display temporarily
      this.updateGlassesDisplay(alertText);
      setTimeout(() => this.updateDisplay(), 3000);
    } else {
      // In browser mode: force-render the alert as if it were a transcript update
      if (this.onTranscriptUpdate) {
        this.onTranscriptUpdate(alertText);
        setTimeout(() => {
          // Restore normal transcript view
          this.onTranscriptUpdate?.(this.display.render());
        }, 3000);
      }
    }
  }

  async destroy(): Promise<void> {
    this.reconnectScheduler.cancel();
    this.displaySim?.destroy();
    await this.browserAudio?.stop();
    if (this.mode === 'glasses') {
      await this.bridge?.audioControl(false);
    }
    this.ws?.close();
    await this.nameAlert.destroy();
  }
}
