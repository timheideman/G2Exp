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

/** One styled run of text within a drawn row. */
interface DrawSegment {
  text: string;
  color: string;
  glow: number;
  bold: boolean;
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

  /** Re-draw using whichever render path is currently active. */
  private rerender(): void {
    if (this.currentFrame) this.renderFrame(this.currentFrame);
    else this.renderText(this.currentText);
  }

  /** Update the display with new text content (legacy flat-string path). */
  update(text: string): void {
    if (text === this.currentText) return;
    this.currentText = text;
    this.currentFrame = null;
    this.renderText(text);
  }

  /**
   * Rich render path: draw a structured caption frame with monochrome-safe
   * emphasis. Current-speaker tags are brighter/bold; interim tokens are
   * dimmer than finalized ones; a blinking cursor follows the live tail.
   */
  renderCaptionFrame(frame: CaptionFrame): void {
    this.currentFrame = frame;
    this.renderFrame(frame);
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

        const textWidth = ctx.measureText(parts[0]).width;
        const cursorOpacity = 0.5 + 0.5 * Math.sin(Date.now() / 300);
        ctx.globalAlpha = cursorOpacity;
        ctx.fillText('━', paddingX + textWidth, y);
        ctx.globalAlpha = 1;
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
   */
  private renderFrame(frame: CaptionFrame): void {
    const ctx = this.ctx;
    const W = DisplaySimulator.WIDTH;
    const H = DisplaySimulator.HEIGHT;

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

    // Keep only the most recent rows that fit, anchored to the bottom.
    const visible = rows.slice(-maxLines);
    const startY = H - paddingY - visible.length * lineHeight;

    for (let i = 0; i < visible.length; i++) {
      const row = visible[i];
      const y = Math.max(paddingY, startY) + i * lineHeight;
      let x = paddingX + row.indent;

      for (const seg of row.segments) {
        ctx.font = seg.bold
          ? `bold ${this.fontSize}px ${fontStack}`
          : `${this.fontSize}px ${fontStack}`;
        ctx.fillStyle = seg.color;
        ctx.shadowColor = seg.color;
        ctx.shadowBlur = seg.glow;
        ctx.fillText(seg.text, x, y);
        x += ctx.measureText(seg.text).width;
      }

      // Blinking cursor at the live (interim) tail.
      if (row.cursor) {
        const cursorOpacity = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 350));
        ctx.globalAlpha = cursorOpacity;
        ctx.fillStyle = SIM_COLORS.interim;
        ctx.shadowBlur = 0;
        ctx.fillText(' ▌', x, y);
        ctx.globalAlpha = 1;
      }
    }

    ctx.shadowBlur = 0;

    // Always-visible capture-state badge (top-right) so captioning never
    // fails silently. The pause overlay is a special, more prominent case.
    if (this.paused || frame.status === 'paused') {
      this.drawPauseOverlay(ctx, W);
    } else if (frame.status) {
      this.drawStatusBadge(ctx, W, frame.status);
    }
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

  /** Start cursor blink animation loop */
  startAnimation(): void {
    const tick = () => {
      // Re-render only when there's a live (interim) tail to blink.
      if (this.currentFrame) {
        const hasInterim = this.currentFrame.lines.some((l) =>
          l.tokens.some((t) => t.state === 'interim'),
        );
        if (hasInterim) this.renderFrame(this.currentFrame);
      } else if (this.currentText.includes('━')) {
        this.renderText(this.currentText);
      }
      this.animFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Stop animation */
  stopAnimation(): void {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  /** Clean up */
  destroy(): void {
    this.stopAnimation();
    this.canvas.remove();
  }
}
