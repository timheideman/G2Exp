/**
 * DisplaySimulator — Renders G2 glasses display in the browser
 *
 * Creates a 576×288 canvas that mimics the G2 micro-LED display
 * (green text on black, ~4-bit greyscale aesthetic). Used for testing
 * without physical glasses, and as the live preview in the companion UI.
 *
 * Two render paths:
 *  - update(text): legacy flat-string path (still used by the glasses bridge).
 *  - renderCaptionFrame(frame): the rich path that applies monochrome-safe
 *    emphasis — current speaker tag brighter/bold, interim (still-changing)
 *    text dimmer than finalized text — the only attribution channels available
 *    on a green-on-black display (SpeechCompass CHI 2025; Olwal UIST 2020).
 */

import type { CaptionFrame } from './caption-engine';
import { DisplayThrottle } from './display-throttle';

/** Map font size names to pixel values */
const FONT_SIZE_MAP: Record<'small' | 'medium' | 'large', number> = {
  small: 14,
  medium: 18,
  large: 24,
};

/** Greyscale-green palette — the only attribution channel on this display. */
const SIM_COLORS = {
  final: 'rgb(0, 220, 90)', // bright — finalized, settled text
  interim: 'rgb(0, 120, 55)', // dim — still-changing tail
  tagCurrent: 'rgb(120, 255, 150)', // brightest — active speaker tag
  tagPast: 'rgb(0, 150, 70)', // muted — prior speaker tag
} as const;

// ─── Animation tunables ──────────────────────────────────────────
//
// The user's overriding constraint is LEAST COMPUTE ON THE PHONE (the sim runs
// in the phone WebView). So motion is short, purposeful, and SELF-QUIESCING:
// the rAF loop runs ONLY while something is actually moving, then stops dead.
//
// Two — and only two — kinds of motion are allowed (DHH-safety invariant):
//   (a) a newly-arrived token fading in (alpha 0→1), and
//   (b) the whole-block scroll baseline gliding when a row is added.
// Settled/finalized text NEVER re-fades, never reflows relative to neighbours,
// and never flickers. Everything below is in service of that invariant.

/** Per-token fade-in duration (ms). New words ease their alpha 0→1 over this. */
const SIM_REVEAL_MS = 150;

/** Scroll-baseline glide duration (ms). The whole block eases to its new Y. */
const SIM_SCROLL_MS = 200;

/**
 * Cursor blink half-period (ms). When nothing is animating but a live interim
 * cursor is on screen, we drive the blink from a single slow timer at this
 * cadence — NOT a 60fps rAF loop — so an idle-but-listening display costs one
 * cheap repaint every ~400ms instead of 60 repaints/sec.
 */
const SIM_CURSOR_BLINK_MS = 400;

/**
 * Device-cadence preview interval (ms). When the cadence-preview toggle is on,
 * incoming frames are coalesced through a DisplayThrottle at this interval so
 * the sim steps at the real ~3fps BLE device cadence instead of silky-smooth.
 */
const SIM_CADENCE_MS = 300;

/** One styled run of text within a drawn row. */
interface DrawSegment {
  text: string;
  color: string;
  glow: number;
  bold: boolean;
  /**
   * Stable token identity (from CaptionToken.key), so renderFrame can fade in
   * only newly-arrived words. Absent on the speaker-tag lead and on keyless
   * tokens — both of which render at full alpha (never fade).
   */
  key?: string;
}

/** One physical row on the panel (after pixel wrapping). */
interface DrawRow {
  segments: DrawSegment[];
  /** Left indent in px (continuation rows align under the speech). */
  indent: number;
  /** Whether a blinking interim cursor trails this row. */
  cursor: boolean;
}

export class DisplaySimulator {
  private canvas: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private scale: number;
  private currentText = '';
  private currentFrame: CaptionFrame | null = null;
  private animFrame: number | null = null;
  private fontSize: number = FONT_SIZE_MAP.medium;
  private paused: boolean = false;

  // ─── Animation state ───────────────────────────────────────────
  //
  // All of this is what makes the rAF loop self-quiescing. The loop reads it
  // through isAnimating(); when nothing here says "still moving", the loop
  // stops and we fall back to the slow cursor-blink timer (or nothing at all).

  /**
   * key → enteredAt(ms). The instant each token first appeared, used to drive
   * its fade-in. A token already in this map renders at full alpha forever —
   * settled text must never re-fade. Pruned to the live frame each render so
   * memory stays bounded. Tokens with no key are treated as already-settled.
   */
  private tokenEnteredAt = new Map<string, number>();

  /**
   * The scroll baseline (top Y of the visible block) actually being drawn, and
   * the target it's gliding toward. While these differ we're mid-glide and
   * isAnimating() is true; on arrival glideStartY === glideTargetY and motion
   * stops. null = not yet initialised (first frame snaps, no glide).
   */
  private scrollY: number | null = null;
  private glideFromY = 0;
  private glideTargetY = 0;
  private glideStartedAt = 0;

  /** Slow cursor-blink timer (NOT rAF). Drives the ▌ when nothing else moves. */
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  /** Current on/off phase of the slow blink, toggled by blinkTimer. */
  private cursorOn = true;

  /**
   * Lazily-created throttle for the optional device-cadence preview. When the
   * toggle is on, incoming frames route through this so the sim steps at the
   * real BLE cadence. One instance, created on first use. (We don't push the
   * frame string through it — it only gives us a coalesced ~3fps "tick"; the
   * latest frame is held in pendingCadenceFrame and rendered on each tick.)
   */
  private cadenceThrottle: DisplayThrottle | null = null;
  private matchCadence = false;
  private pendingCadenceFrame: CaptionFrame | null = null;

  // G2 display dimensions
  static readonly WIDTH = 576;
  static readonly HEIGHT = 288;

  constructor(container: HTMLElement, scale: number = 1) {
    this.scale = scale;

    this.canvas = document.createElement('canvas');
    this.canvas.width = DisplaySimulator.WIDTH * scale;
    this.canvas.height = DisplaySimulator.HEIGHT * scale;
    this.canvas.style.width = `${DisplaySimulator.WIDTH * scale}px`;
    this.canvas.style.height = `${DisplaySimulator.HEIGHT * scale}px`;
    this.canvas.style.backgroundColor = '#000';
    this.canvas.style.borderRadius = '12px';
    this.canvas.style.border = '1px solid #1a1a1a';
    this.canvas.style.boxShadow = '0 0 30px rgba(0, 255, 0, 0.03)';

    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      console.error('[DisplaySim] Failed to get 2d context');
      return;
    }
    this.ctx = ctx;
    this.ctx.scale(scale, scale);

    // Draw a visible initial state to confirm canvas works
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, DisplaySimulator.WIDTH, DisplaySimulator.HEIGHT);
    this.ctx.fillStyle = '#00cc44';
    this.ctx.font = `${this.fontSize}px monospace`;
    this.ctx.fillText('LiveCaption', 14, 30);
    this.ctx.fillStyle = '#006622';
    this.ctx.font = `${Math.max(12, this.fontSize - 2)}px monospace`;
    this.ctx.fillText('Waiting for connection...', 14, 60);

    console.log('[DisplaySim] Canvas initialized');
  }

  /**
   * Dynamically update the font size used for transcript rendering.
   * Changes take effect on the next render call.
   */
  setFontSize(size: 'small' | 'medium' | 'large'): void {
    this.fontSize = FONT_SIZE_MAP[size];
    this.rerender();
  }

  /**
   * Show or hide the "⏸ Paused" overlay in the top-right corner.
   * Call with true when transcription is paused, false when resumed.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.rerender();
  }

  /**
   * Re-draw using whichever render path is currently active, then re-evaluate
   * the idle drivers. A repaint from setFontSize/setPaused can change whether a
   * cursor should blink (e.g. pause hides it), so we resync rather than assume.
   * If an animation is already running, leave it — its own loop will resync.
   */
  private rerender(): void {
    if (this.currentFrame) this.renderFrame(this.currentFrame);
    else this.renderText(this.currentText);
    if (this.animFrame === null) this.syncIdleDrivers();
  }

  /** Update the display with new text content (legacy flat-string path). */
  update(text: string): void {
    if (text === this.currentText) return;
    this.currentText = text;
    this.currentFrame = null;
    // Frame-scoped animation state doesn't apply to the flat-string path; reset
    // the scroll baseline so a later frame snaps cleanly instead of gliding from
    // a stale position, and clear fade stamps (no keyed tokens here).
    this.scrollY = null;
    this.tokenEnteredAt.clear();
    this.renderText(text);
    // The legacy path can carry a blinking ━ cursor; engage the slow blink only
    // if one is present (and no rAF is running), else go fully idle.
    if (this.animFrame === null) this.syncIdleDrivers();
  }

  /**
   * Rich render path: draw a structured caption frame with monochrome-safe
   * emphasis. Current-speaker tags are brighter/bold; interim tokens are
   * dimmer than finalized ones; a blinking cursor follows the live tail.
   *
   * When the cadence-preview toggle is on, the frame is held and only committed
   * on the next ~3fps throttle tick, so the sim steps at the real device rate.
   * When off (the default), it commits immediately.
   */
  renderCaptionFrame(frame: CaptionFrame): void {
    if (this.matchCadence) {
      // Hold the newest frame; the throttle's coalesced tick will commit it at
      // the BLE cadence. push()'s value only needs to change to fire — a frame
      // counter string is enough; the actual frame lives in pendingCadenceFrame.
      this.pendingCadenceFrame = frame;
      this.ensureCadenceThrottle().push(String(this.cadenceTick++));
      return;
    }
    this.commitFrame(frame);
  }

  /**
   * A/B toggle: when ON, route incoming frames through a 300ms throttle so the
   * sim updates at the real ~3fps device cadence (stepped, not silky) — letting
   * the user compare "ideal smooth" against "what the lens actually shows".
   * When OFF (default), frames render immediately. Off→on is lazy; on→off
   * flushes any held frame so the display doesn't stall on a stale frame.
   */
  setMatchGlassesCadence(on: boolean): void {
    if (on === this.matchCadence) return;
    this.matchCadence = on;
    if (!on) {
      // Leaving cadence mode — commit whatever was last held, immediately.
      this.cadenceThrottle?.cancel();
      if (this.pendingCadenceFrame) {
        const f = this.pendingCadenceFrame;
        this.pendingCadenceFrame = null;
        this.commitFrame(f);
      }
    }
  }

  /** Monotonic counter so each held frame is a distinct throttle value. */
  private cadenceTick = 0;

  /** Lazily build the cadence-preview throttle (one instance, reused). */
  private ensureCadenceThrottle(): DisplayThrottle {
    if (!this.cadenceThrottle) {
      // The flushFn ignores its string argument — it's only a change-detector.
      // On each coalesced tick we commit the most-recent held frame.
      this.cadenceThrottle = new DisplayThrottle(() => {
        if (this.pendingCadenceFrame) {
          const f = this.pendingCadenceFrame;
          this.pendingCadenceFrame = null;
          this.commitFrame(f);
        }
      }, SIM_CADENCE_MS, () => this.now());
    }
    return this.cadenceThrottle;
  }

  /**
   * Commit a frame to the screen: store it as current, seed fade/scroll state
   * for any motion it introduces, paint once, then (re)start the rAF loop iff
   * something is actually moving. This is the single funnel both the immediate
   * and the cadence-throttled paths flow through.
   */
  private commitFrame(frame: CaptionFrame): void {
    this.currentFrame = frame;
    // Seed enteredAt for genuinely-new tokens and recompute the scroll target.
    // Done here (not in renderFrame) so a no-op repaint — a blink tick — never
    // mistakes an existing token for new or re-triggers a glide.
    this.noteNewTokens(frame);
    this.renderFrame(frame);
    // Any new fade or scroll shift means motion is in progress: spin up rAF.
    this.kickAnimation();
  }

  // ─── Animation control (self-quiescing rAF + slow blink) ───────

  /**
   * Reconcile the fade map with the frame: stamp enteredAt=now for every token
   * key we haven't seen, and prune keys no longer present (bounded memory).
   * Tokens already in the map keep their original stamp → they NEVER re-fade.
   * Called exactly once per fresh frame (from commitFrame), never on a repaint.
   */
  private noteNewTokens(frame: CaptionFrame): void {
    const now = this.now();
    const present = new Set<string>();
    for (const line of frame.lines) {
      for (const tok of line.tokens) {
        if (!tok.key) continue; // keyless ⇒ treated as settled (no fade)
        present.add(tok.key);
        if (!this.tokenEnteredAt.has(tok.key)) this.tokenEnteredAt.set(tok.key, now);
      }
    }
    // Prune stamps for tokens that scrolled out of the window / were cleared.
    for (const key of this.tokenEnteredAt.keys()) {
      if (!present.has(key)) this.tokenEnteredAt.delete(key);
    }
  }

  /**
   * True iff motion is genuinely in progress right now — a token mid fade-in,
   * OR the scroll baseline mid-glide. This is the SOLE gate on the rAF loop:
   * the instant it goes false, the loop stops and idle compute drops to zero
   * (the blinking cursor is handled separately by a slow timer, not rAF).
   */
  private isAnimating(): boolean {
    const now = this.now();
    // Scroll glide still settling?
    if (this.scrollY !== null && this.scrollY !== this.glideTargetY) return true;
    // Any token still inside its reveal window?
    for (const at of this.tokenEnteredAt.values()) {
      if (now - at < SIM_REVEAL_MS) return true;
    }
    return false;
  }

  /**
   * Decide the right drive after a fresh frame: if something is moving, run the
   * rAF loop (and make sure the slow blink timer is off — rAF already repaints
   * fast enough to animate the cursor). If nothing is moving but a live interim
   * cursor exists, run ONLY the slow blink timer. If fully settled with no
   * interim, neither runs — zero idle compute.
   */
  private kickAnimation(): void {
    if (this.isAnimating()) {
      this.stopCursorBlink(); // rAF subsumes the blink while moving
      if (this.animFrame === null) this.runRafLoop();
    } else {
      this.syncIdleDrivers();
    }
  }

  /**
   * The self-quiescing rAF loop. Repaints the current frame each frame WHILE
   * motion is in progress, then stops itself the moment isAnimating() is false,
   * handing off to the idle drivers (slow blink or nothing). Critically it does
   * NOT re-arm unconditionally — that was the old always-on behaviour.
   */
  private runRafLoop(): void {
    const tick = () => {
      this.animFrame = null;
      if (this.currentFrame) this.renderFrame(this.currentFrame);
      else if (this.currentText.includes('━')) this.renderText(this.currentText);

      if (this.isAnimating()) {
        this.animFrame = requestAnimationFrame(tick);
      } else {
        // Settled — drop to the cheap idle path (blink-only or nothing).
        this.syncIdleDrivers();
      }
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  /**
   * When nothing is animating, choose the cheapest correct idle driver: a slow
   * ~400ms blink timer if (and only if) a live interim cursor is on screen,
   * otherwise no timer at all. Never runs alongside rAF.
   */
  private syncIdleDrivers(): void {
    if (this.hasLiveCursor()) {
      this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }
  }

  /** Does the current frame have a live (interim) tail that should blink? */
  private hasLiveCursor(): boolean {
    if (this.paused) return false; // pause overlay owns the screen
    if (this.currentFrame) {
      return this.currentFrame.lines.some((l) => l.tokens.some((t) => t.state === 'interim'));
    }
    return this.currentText.includes('━');
  }

  /**
   * Start (or keep) the slow blink. One setInterval at SIM_CURSOR_BLINK_MS that
   * flips cursorOn and repaints — a single cheap repaint per ~400ms, vs 60/sec
   * under rAF. Idempotent: re-calling while already running is a no-op.
   */
  private startCursorBlink(): void {
    if (this.blinkTimer !== null) return;
    this.blinkTimer = setInterval(() => {
      this.cursorOn = !this.cursorOn;
      // Repaint just to toggle the cursor; nothing else is moving.
      if (this.currentFrame) this.renderFrame(this.currentFrame);
      else if (this.currentText.includes('━')) this.renderText(this.currentText);
    }, SIM_CURSOR_BLINK_MS);
  }

  /** Stop the slow blink and leave the cursor in its visible phase. */
  private stopCursorBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.cursorOn = true; // settle visible so a static tail keeps its cursor
  }

  /** performance.now() when available (monotonic), else Date.now(). */
  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  private renderText(text: string): void {
    const ctx = this.ctx;
    const W = DisplaySimulator.WIDTH;
    const H = DisplaySimulator.HEIGHT;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    const fontStack = `"SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace`;
    ctx.font = `${this.fontSize}px ${fontStack}`;
    ctx.textBaseline = 'top';

    const lineHeight = Math.round(this.fontSize * 1.5);
    const paddingX = 14;
    const paddingY = 10;
    const maxWidth = W - paddingX * 2;
    const maxLines = Math.floor((H - paddingY * 2) / lineHeight);

    // Word-wrap all lines
    const rawLines = text.split('\n');
    const wrappedLines: string[] = [];
    for (const line of rawLines) {
      const wrapped = this.wordWrap(ctx, line, maxWidth);
      wrappedLines.push(...wrapped);
    }

    // Keep only the most recent lines that fit
    const visibleLines = wrappedLines.slice(-maxLines);
    const totalLines = visibleLines.length;

    for (let i = 0; i < totalLines; i++) {
      const line = visibleLines[i];
      const y = paddingY + i * lineHeight;

      const age = (totalLines - 1 - i) / Math.max(totalLines - 1, 1);
      const brightness = this.getBrightness(age);

      if (line.includes('━')) {
        const parts = line.split('━');
        ctx.fillStyle = brightness;
        ctx.shadowColor = brightness;
        ctx.shadowBlur = 4;
        ctx.fillText(parts[0], paddingX, y);

        // Drive the legacy ━ cursor from the slow blink phase (cursorOn) too,
        // so an idle flat-string view blinks from the one cheap timer rather
        // than ever spinning up rAF just to fade a cursor.
        const textWidth = ctx.measureText(parts[0]).width;
        if (this.cursorOn) ctx.fillText('━', paddingX + textWidth, y);
      } else {
        ctx.fillStyle = brightness;
        ctx.shadowColor = brightness;
        ctx.shadowBlur = 4;
        ctx.fillText(line, paddingX, y);
      }
    }

    ctx.shadowBlur = 0;

    // Draw pause overlay on top of all content
    if (this.paused) {
      this.drawPauseOverlay(ctx, W);
    }
  }

  /**
   * Rich token-level renderer. Brightness encodes two things at once — the
   * only attribution channels available on monochrome green-on-black:
   *   • final vs interim: interim (still-changing tail) is dimmer.
   *   • current speaker vs prior: the active speaker's tag is brightest/bold.
   *
   * The renderer is authoritative on width: it pixel-wraps each turn so text
   * never overruns the panel edge (the engine's char-wrap is only a hint).
   * Bottom-anchored: the most recent row sits at the bottom of the panel.
   *
   * Two motions are layered on, and ONLY these two (DHH-safety invariant):
   *   • newly-arrived tokens fade their alpha 0→1 over SIM_REVEAL_MS;
   *   • when the bottom-anchored baseline shifts (a row was added), the WHOLE
   *     block glides to the new Y over SIM_SCROLL_MS instead of snapping.
   * Token positions relative to each other never reflow — only the shared
   * baseline translates — so settled text never moves under the reader's gaze.
   *
   * This method is a near-pure repaint: new-token STAMPING happens upstream in
   * noteNewTokens (once per fresh frame), so a blink/rAF tick never mistakes an
   * existing token for new. Glide retargeting lives in resolveScrollY but is
   * self-guarding — it only fires when the target baseline actually moves, and
   * a repaint of the same frame yields the same target, so idle ticks can't
   * spuriously restart a glide. The only state a repaint mutates is the scroll
   * interpolation it advances toward an already-fixed target.
   */
  private renderFrame(frame: CaptionFrame): void {
    const ctx = this.ctx;
    const W = DisplaySimulator.WIDTH;
    const H = DisplaySimulator.HEIGHT;
    const now = this.now();

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    const fontStack = `"SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace`;
    ctx.textBaseline = 'top';

    const lineHeight = Math.round(this.fontSize * 1.55);
    const paddingX = 14;
    const paddingY = 10;
    const maxLines = Math.max(1, Math.floor((H - paddingY * 2) / lineHeight));
    const maxWidth = W - paddingX * 2;

    // Build flat draw-rows from the frame with pixel-aware wrapping.
    const rows = this.layoutRows(frame, fontStack, maxWidth, paddingX);

    // Keep only the most recent rows that fit, anchored to the bottom. The
    // target baseline is the hard bottom-anchored Y; the DRAWN baseline glides
    // toward it (see resolveScrollY) so rows roll up smoothly, never snap.
    const visible = rows.slice(-maxLines);
    const targetStartY = Math.max(paddingY, H - paddingY - visible.length * lineHeight);
    const startY = this.resolveScrollY(targetStartY, now);

    for (let i = 0; i < visible.length; i++) {
      const row = visible[i];
      const y = startY + i * lineHeight;
      let x = paddingX + row.indent;

      for (const seg of row.segments) {
        // Per-token fade-in: a token whose key entered within the last
        // SIM_REVEAL_MS eases its alpha 0→1. No key (tag lead / keyless) or an
        // already-settled key ⇒ full alpha. Settled text NEVER re-fades.
        const alpha = this.tokenAlpha(seg.key, now);

        ctx.font = seg.bold
          ? `bold ${this.fontSize}px ${fontStack}`
          : `${this.fontSize}px ${fontStack}`;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = seg.color;
        ctx.shadowColor = seg.color;
        ctx.shadowBlur = seg.glow;
        ctx.fillText(seg.text, x, y);
        x += ctx.measureText(seg.text).width;
      }
      ctx.globalAlpha = 1;

      // Cursor at the live (interim) tail. While motion runs (rAF), or settled,
      // it's driven by the slow blink phase (cursorOn) — not a per-frame sine —
      // so an idle listening display blinks from one cheap timer, not 60fps.
      if (row.cursor && this.cursorOn) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = SIM_COLORS.interim;
        ctx.shadowBlur = 0;
        ctx.fillText(' ▌', x, y);
      }
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // Always-visible capture-state badge (top-right) so captioning never
    // fails silently. The pause overlay is a special, more prominent case.
    if (this.paused || frame.status === 'paused') {
      this.drawPauseOverlay(ctx, W);
    } else if (frame.status) {
      this.drawStatusBadge(ctx, W, frame.status);
    }
  }

  /**
   * Advance the eased scroll baseline toward `target` and return the Y to draw
   * at. The first ever call snaps (no glide); afterwards, when the target moves
   * we start a new SIM_SCROLL_MS ease-out from the current drawn position, and
   * each call steps `scrollY` along that curve until it lands exactly on target
   * (at which point isAnimating() reports the glide as finished).
   */
  private resolveScrollY(target: number, now: number): number {
    // First frame: snap into place, no glide (nothing to roll up from yet).
    if (this.scrollY === null) {
      this.scrollY = target;
      this.glideFromY = target;
      this.glideTargetY = target;
      return target;
    }

    // Target moved (a row was added/removed): begin a fresh glide from where
    // we're currently drawn — so an in-flight glide redirects smoothly.
    if (target !== this.glideTargetY) {
      this.glideFromY = this.scrollY;
      this.glideTargetY = target;
      this.glideStartedAt = now;
    }

    if (this.scrollY !== this.glideTargetY) {
      const t = Math.min(1, (now - this.glideStartedAt) / SIM_SCROLL_MS);
      const eased = easeOut(t);
      this.scrollY = this.glideFromY + (this.glideTargetY - this.glideFromY) * eased;
      // Land exactly on target at the end so the glide truly terminates (no
      // sub-pixel residue keeping isAnimating() true forever).
      if (t >= 1) this.scrollY = this.glideTargetY;
    }
    return this.scrollY;
  }

  /**
   * Fade-in alpha for a token segment. Full alpha for keyless segments (the tag
   * lead) and for any key not currently in the reveal window — the latter being
   * settled text, which must render solid and NEVER re-fade. New keys ease 0→1.
   */
  private tokenAlpha(key: string | undefined, now: number): number {
    if (!key) return 1;
    const enteredAt = this.tokenEnteredAt.get(key);
    if (enteredAt === undefined) return 1; // not tracked ⇒ treat as settled
    const t = (now - enteredAt) / SIM_REVEAL_MS;
    if (t >= 1) return 1;
    if (t <= 0) return 0;
    return easeOut(t);
  }

  /** Small top-right capture-state dot + label. */
  private drawStatusBadge(
    ctx: CanvasRenderingContext2D,
    W: number,
    status: NonNullable<CaptionFrame['status']>,
  ): void {
    const map: Record<string, { dot: string; label: string; text: string }> = {
      listening: { dot: 'rgb(0, 220, 90)', label: 'live', text: 'rgb(0, 150, 70)' },
      connecting: { dot: 'rgb(180, 160, 0)', label: 'reconnecting', text: 'rgb(150, 130, 0)' },
      'no-audio': { dot: 'rgb(180, 120, 0)', label: 'no audio', text: 'rgb(150, 110, 0)' },
      error: { dot: 'rgb(220, 60, 50)', label: 'no captions', text: 'rgb(200, 70, 60)' },
    };
    const s = map[status];
    if (!s) return;

    const fontStack = `"SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace`;
    const fs = Math.max(10, Math.round(this.fontSize * 0.62));
    ctx.font = `${fs}px ${fontStack}`;
    ctx.textBaseline = 'top';

    const labelW = ctx.measureText(s.label).width;
    const dotR = Math.max(3, Math.round(fs * 0.32));
    const padH = 6;
    const gap = 6;
    const boxW = dotR * 2 + gap + labelW + padH * 2;
    const boxH = fs + 8;
    const boxX = W - boxW - 8;
    const boxY = 6;

    // Subtle dark chip so it reads over any caption text.
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#000000';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.globalAlpha = 1;

    // Status dot (steady-pulse for connecting via the anim loop alpha).
    const cy = boxY + boxH / 2;
    ctx.beginPath();
    ctx.fillStyle = s.dot;
    ctx.shadowColor = s.dot;
    ctx.shadowBlur = 4;
    ctx.arc(boxX + padH + dotR, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = s.text;
    ctx.fillText(s.label, boxX + padH + dotR * 2 + gap, boxY + 4);
  }

  /**
   * Flatten a CaptionFrame into pixel-wrapped draw rows. Each turn's tag is
   * drawn once on its first row; wrapped continuation rows are indented to
   * align under the speech.
   */
  private layoutRows(
    frame: CaptionFrame,
    fontStack: string,
    maxWidth: number,
    _paddingX: number,
  ): DrawRow[] {
    const ctx = this.ctx;
    const measure = (text: string, bold = false): number => {
      ctx.font = bold ? `bold ${this.fontSize}px ${fontStack}` : `${this.fontSize}px ${fontStack}`;
      return ctx.measureText(text).width;
    };
    const spaceW = measure(' ');
    const rows: DrawRow[] = [];

    for (const line of frame.lines) {
      const isSystem = line.speaker < 0;

      // Leading segments + indent for this turn's first row. Tight label style
      // (no dash marker, small hang indent) to match the glasses and save width.
      const lead: DrawSegment[] = [];
      const HANG = '  ';
      let indent = 0;
      if (line.tag !== null && !isSystem) {
        const tagText = `[${line.tag}] `;
        lead.push({
          text: tagText,
          color: line.isCurrentSpeaker ? SIM_COLORS.tagCurrent : SIM_COLORS.tagPast,
          glow: line.isCurrentSpeaker ? 5 : 2,
          bold: line.isCurrentSpeaker,
        });
        // Continuation rows of THIS turn use a small hang indent.
        indent = measure(HANG);
      } else if (!isSystem) {
        // Continuation of a prior turn (engine already split it): hang indent.
        indent = measure(HANG);
      }

      // Wrap tokens to pixel width, carrying the lead onto the first row.
      // First row indent: 0 when a tag lead is present (the lead provides the
      // offset), else the computed indent (engine-split continuation line).
      const firstIndent = lead.length > 0 ? 0 : indent;
      let row: DrawRow = { segments: [...lead], indent: firstIndent, cursor: false };
      let used = (lead.length > 0 ? 0 : indent) +
        lead.reduce((w, s) => w + measure(s.text, s.bold), 0);
      let placedAny = lead.length > 0;

      const pushRow = () => {
        rows.push(row);
        row = { segments: [], indent, cursor: false };
        used = indent;
        placedAny = false;
      };

      for (const tok of line.tokens) {
        const isInterim = tok.state === 'interim';
        const w = measure(tok.text);
        const sep = placedAny ? spaceW : 0;

        if (placedAny && used + sep + w > maxWidth) {
          pushRow();
        }

        // Prepend a separating space only when this row already has content.
        const text = placedAny ? ` ${tok.text}` : tok.text;
        row.segments.push({
          text,
          color: isInterim ? SIM_COLORS.interim : SIM_COLORS.final,
          glow: isInterim ? 2 : 4,
          bold: false,
          key: tok.key, // carried so renderFrame can fade in only new words
        });
        used += (placedAny ? sep : 0) + w;
        placedAny = true;
        row.cursor = isInterim; // last interim token wins; reset by finals
      }

      rows.push(row);
    }

    return rows;
  }

  /**
   * Draw a subtle "⏸ Paused" indicator in the top-right corner of the display.
   * Called internally when paused state is active.
   */
  private drawPauseOverlay(ctx: CanvasRenderingContext2D, W: number): void {
    const label = '⏸ Paused';
    // Use a slightly smaller font for the overlay so it's subtle
    const overlayFontSize = Math.max(11, Math.round(this.fontSize * 0.72));
    const fontStack = `"SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace`;
    ctx.font = `${overlayFontSize}px ${fontStack}`;
    ctx.textBaseline = 'top';

    const metrics = ctx.measureText(label);
    const textWidth = metrics.width;
    const paddingH = 6;
    const paddingV = 4;
    const boxWidth = textWidth + paddingH * 2;
    const boxHeight = overlayFontSize + paddingV * 2;
    const boxX = W - boxWidth - 8;
    const boxY = 6;

    // Semi-transparent dark background so it doesn't obscure transcript
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = '#001200';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.globalAlpha = 1;

    // Dim green text — subdued so it doesn't distract from the transcript
    ctx.fillStyle = '#336633';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillText(label, boxX + paddingH, boxY + paddingV);
  }

  /** Word-wrap a line to fit within maxWidth pixels */
  private wordWrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    if (!text) return [''];
    if (ctx.measureText(text).width <= maxWidth) return [text];

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        // If a single word is wider than maxWidth, force it on its own line
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines;
  }

  /** Get green color based on age (0 = newest/brightest, 1 = oldest/dimmest) */
  private getBrightness(age: number): string {
    // Map age to green intensity: bright green → dim green
    const intensity = Math.round(204 - age * 140); // 204 (bright) to 64 (dim)
    return `rgb(0, ${intensity}, ${Math.round(intensity * 0.3)})`;
  }

  /**
   * Enable animation. Unlike the old forever-running rAF, this just engages the
   * right driver for the CURRENT state and then self-manages: if something is
   * mid-motion the rAF loop runs until it settles; if only a live interim cursor
   * exists, the slow blink timer runs; if fully settled with no interim, nothing
   * runs at all. Subsequent frames re-engage motion via commitFrame → kick.
   * Idempotent and cheap to call.
   */
  startAnimation(): void {
    this.kickAnimation();
  }

  /**
   * Stop ALL animation drivers — both the rAF loop and the slow blink timer —
   * so the display goes fully idle (zero ongoing compute). The last painted
   * frame stays on screen. A later startAnimation()/frame re-engages drivers.
   */
  stopAnimation(): void {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
    this.stopCursorBlink();
  }

  /** Clean up */
  destroy(): void {
    this.stopAnimation();
    this.cadenceThrottle?.cancel();
    this.cadenceThrottle = null;
    this.pendingCadenceFrame = null;
    this.tokenEnteredAt.clear();
    this.canvas.remove();
  }
}

/**
 * Ease-out cubic — fast start, gentle settle. Used for both the token fade-in
 * and the scroll-baseline glide so motion decelerates into place (matches how
 * the eye expects text to "arrive" and stop) rather than easing linearly.
 */
function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}
