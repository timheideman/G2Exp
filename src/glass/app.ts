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
import { DisplayThrottle } from './display-throttle';
import type { LiveCaptionSettings, ConfigMessage } from '../types/settings';
import type { CaptureState } from './caption-engine';

/** BLE-safe display update interval — production drivers cap at ~3/sec. */
const GLASSES_UPDATE_INTERVAL_MS = 300;

/**
 * Caption layout for the real G2 text container. The firmware font is fixed
 * (no size control), so "use the screen" means filling the 576×288 panel with
 * the fixed font — a full-screen container holds ~400–500 chars ≈ ~12 lines ×
 * ~35–40 chars. We target a generous, panel-filling block. These are tunable
 * live via the on-glasses calibration screen (?cal grid) if the real unit
 * differs from these estimates.
 */
const GLASSES_CAPTION_CONFIG = { maxLines: 7, maxLineChars: 38 };

/** A looser layout for the browser simulator (its font is smaller/scalable). */
const BROWSER_CAPTION_CONFIG = { maxLines: 6, maxLineChars: 44 };

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

  /** Live-tunable caption layout override (set by the calibration screen). */
  private captionConfigOverride: { maxLines: number; maxLineChars: number } | null = null;

  /** Coalesces glasses display pushes to the BLE-safe rate (newest-wins). */
  private glassesThrottle = new DisplayThrottle(
    (text) => this.updateGlassesDisplay(text),
    GLASSES_UPDATE_INTERVAL_MS,
  );

  readonly settings = new SettingsManager();

  private nameAlert = new NameAlertDetector();

  // Callbacks for UI integration
  onStatusChange?: (status: string, connected: boolean) => void;
  onTranscriptUpdate?: (text: string) => void;
  onNameAlerted?: (label: string) => void;

  async init(): Promise<void> {
    // Restore a previously-calibrated caption layout, if any.
    try {
      const saved = localStorage.getItem('captionConfig');
      if (saved) this.captionConfigOverride = JSON.parse(saved);
    } catch {}

    // Listen for settings changes
    this.settings.onChange((s) => this.onSettingsChanged(s));

    // Detect environment
    this.mode = await this.detectMode();
    console.log(`[LiveCaption] Mode: ${this.mode}`);

    if (this.mode === 'glasses') {
      // Don't let a glasses-init failure prevent the WS from connecting — we
      // still want the server connected (and the error already surfaced via
      // setStatus) so the session is diagnosable rather than dead-silent.
      try {
        await this.initGlasses();
      } catch (err) {
        console.error('[LiveCaption] Glasses init failed — continuing to connect:', err);
      }
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
    // Size the caption layout to fill the real G2 panel (fixed firmware font).
    this.display.setConfig(this.captionConfigOverride ?? GLASSES_CAPTION_CONFIG);

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

    // Wrap the initial container creation: if it throws on the real device, we
    // surface the error on-screen instead of silently wedging on "Connecting…"
    // (a permanent "Connecting…" with no error is otherwise impossible to debug).
    try {
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
    } catch (err: any) {
      console.error('[LiveCaption] createStartUpPageContainer failed:', err);
      this.setStatus(`Display init failed: ${err?.message || err}`, false);
      throw err;
    }

    let audioChunkLogged = false;
    this.bridge.onEvenHubEvent((event: any) => {
      const rawPcm = event.audioEvent?.audioPcm;
      if (rawPcm) {
        // Normalize to Uint8Array — most SDK builds deliver one, but after JSON
        // transit it can surface as number[]/ArrayBuffer; downstream code
        // (ws.send, NameAlertDetector.process) needs a real typed array.
        const pcm = rawPcm instanceof Uint8Array ? rawPcm : new Uint8Array(rawPcm);
        if (!audioChunkLogged) {
          audioChunkLogged = true;
          console.log(`[LiveCaption] First glasses audio chunk: ${pcm.byteLength} bytes`);
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(pcm);
        }
        // Feed the wake-word detector regardless of WS state (it's on-device).
        this.nameAlert.process(pcm);
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

  /**
   * Calibration: paint a numbered ruler on the glasses so we can read off the
   * REAL chars-per-line and lines-per-screen of the firmware font (the ~38/~12
   * figures are research estimates). Each row is a digit ruler; the leading
   * number is the line index. Whatever the last fully-visible line number is =
   * lines-per-screen; whichever ruler column falls off the right edge = chars.
   */
  showCalibrationGrid(): void {
    const ruler = '....5....10...15...20...25...30...35...40...45...50';
    const lines: string[] = [];
    for (let i = 1; i <= 14; i++) {
      const n = String(i).padStart(2, '0');
      lines.push(`${n}${ruler}`);
    }
    const grid = lines.join('\n');
    if (this.mode === 'glasses') {
      this.glassesThrottle.cancel();
      this.updateGlassesDisplay(grid);
    } else if (this.displaySim) {
      this.displaySim.update(grid);
    }
    console.log('[LiveCaption] Calibration grid shown — count visible lines and the last readable ruler number.');
  }

  /**
   * Apply a tuned caption layout live (from the calibration screen) without a
   * reload. Persists to localStorage so it survives the next launch.
   */
  applyCaptionConfig(maxLines: number, maxLineChars: number): void {
    this.captionConfigOverride = { maxLines, maxLineChars };
    this.display.setConfig(this.captionConfigOverride);
    try {
      localStorage.setItem('captionConfig', JSON.stringify(this.captionConfigOverride));
    } catch {}
    this.lastRenderedText = '';
    this.updateDisplay();
    console.log(`[LiveCaption] Caption layout set to ${maxLines} lines × ${maxLineChars} chars`);
  }

  /**
   * Push caption text to the glasses, coalesced to the BLE-safe update rate.
   * Frequent caption frames are merged (newest-wins) so we never saturate the
   * link or cause flicker — the display can't update faster than ~3/sec anyway.
   */
  private pushGlassesText(text: string): void {
    this.glassesThrottle.push(text);
  }

  private async updateGlassesDisplay(text: string): Promise<void> {
    try {
      const { TextContainerUpgrade } = this.sdk;
      // Partial-update path (textContainerUpgrade) — the flicker-free way to
      // refresh a text container without rebuilding the whole page.
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
    this.display.setConfig(BROWSER_CAPTION_CONFIG);

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
      this.display.setPaused(true);
      this.displaySim?.setPaused(true);
      this.setStatus('Paused', false);
      this.setCaptureState('paused');
    } else {
      this.setStatus('Requesting mic access...', false);
      try {
        await this.browserAudio.start();
        this.isListening = true;
        this.display.setPaused(false);
        this.displaySim?.setPaused(false);
        this.setStatus('Listening (mic active)...', true);
        this.setCaptureState('listening');
      } catch (err: any) {
        console.error('[LiveCaption] Mic error:', err);
        this.setStatus(`Mic error: ${err.message || 'denied'}`, false);
        this.setCaptureState('error');
        return;
      }
    }
    this.updateDisplay();
  }

  // ─── Shared Logic ───────────────────────────────────────────

  private connectWebSocket(): void {
    console.log(`[LiveCaption] Connecting to ${WS_URL}`);
    this.setStatus('Connecting to server...', false);
    this.setCaptureState('connecting');
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('[LiveCaption] Server connected');
      this.reconnectScheduler.reset();
      // Send current settings on connect
      this.sendConfig(this.settings.current);
      // Apply current font size to display
      this.displaySim?.setFontSize(this.settings.current.fontSize);
      this.setStatus(this.isListening ? 'Listening...' : 'Connected — ready', true);
      this.setCaptureState(this.isListening ? 'listening' : 'connecting');
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
          if (this.isListening) this.setCaptureState('listening');
          return;
        }
        if (msg.type === 'error') {
          console.error('[LiveCaption] Server error:', msg.message || msg.code);
          this.setStatus(msg.message || 'Captioning error', false);
          this.setCaptureState('error');
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
      this.setCaptureState('connecting');
      this.reconnectScheduler.schedule(() => this.connectWebSocket());
    };

    this.ws.onerror = () => {
      this.setStatus('Connection error', false);
      this.setCaptureState('error');
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
    // Transcript is flowing — we're definitively live.
    if (this.isListening) this.display.setStatus('listening');
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const text = this.display.render();
    if (text === this.lastRenderedText) return;
    this.lastRenderedText = text;

    if (this.mode === 'glasses') {
      // Glasses bridge accepts a flat string; throttle pushes to the
      // BLE-safe rate so frequent caption updates don't saturate the link.
      this.pushGlassesText(text);
    } else if (this.displaySim) {
      // Browser preview gets the rich structured frame (monochrome emphasis).
      this.displaySim.renderCaptionFrame(this.display.renderFrame());
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
        this.display.setPaused(true);
        this.setStatus('Paused', false);
        this.setCaptureState('paused');
      } else {
        await this.bridge!.audioControl(true);
        this.isListening = true;
        this.display.setPaused(false);
        this.setStatus('Listening...', true);
        this.setCaptureState('listening');
      }
      this.updateDisplay();
    } else {
      this.toggleBrowserCapture();
    }
  }

  private setStatus(text: string, connected: boolean): void {
    if (this.onStatusChange) this.onStatusChange(text, connected);
  }

  /**
   * Update the live capture/pipeline state shown in the always-visible
   * status indicator (anti silent-failure), and re-render so it appears
   * immediately even if no new caption text has arrived.
   */
  private setCaptureState(state: CaptureState): void {
    if (this.display.captureStatus === state) return;
    this.display.setStatus(state);
    // Force a re-render: the status changed even if the caption text didn't.
    this.lastRenderedText = '';
    this.updateDisplay();
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
      // Override the glasses display immediately (bypass the caption throttle —
      // this is a high-priority interruption the wearer must see now).
      this.glassesThrottle.cancel();
      this.updateGlassesDisplay(alertText);
      this.lastRenderedText = ''; // force a re-render when we restore
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
    this.glassesThrottle.cancel();
    this.displaySim?.destroy();
    await this.browserAudio?.stop();
    if (this.mode === 'glasses') {
      await this.bridge?.audioControl(false);
    }
    this.ws?.close();
    await this.nameAlert.destroy();
  }
}
