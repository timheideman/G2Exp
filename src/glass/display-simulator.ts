/**
 * DisplaySimulator — Renders G2 glasses display in the browser
 *
 * Creates a 576×288 canvas that mimics the G2 micro-LED display
 * (green text on black, monospace font, 4-bit greyscale aesthetic).
 * Used for testing without physical glasses.
 */

/** Map font size names to pixel values */
const FONT_SIZE_MAP: Record<'small' | 'medium' | 'large', number> = {
  small: 14,
  medium: 18,
  large: 24,
};

export class DisplaySimulator {
  private canvas: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private scale: number;
  private currentText = '';
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
    // Re-render immediately so the change is visible right away
    this.renderText(this.currentText);
  }

  /**
   * Show or hide the "⏸ Paused" overlay in the top-right corner.
   * Call with true when transcription is paused, false when resumed.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.renderText(this.currentText);
  }

  /** Update the display with new text content */
  update(text: string): void {
    if (text === this.currentText) return;
    this.currentText = text;
    this.renderText(text);
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
      if (this.currentText.includes('━')) {
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
