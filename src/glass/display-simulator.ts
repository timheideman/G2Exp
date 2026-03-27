/**
 * DisplaySimulator — Renders G2 glasses display in the browser
 *
 * Creates a 576×288 canvas that mimics the G2 micro-LED display
 * (green text on black, monospace font, 4-bit greyscale aesthetic).
 * Used for testing without physical glasses.
 */

export class DisplaySimulator {
  private canvas: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private scale: number;
  private currentText = '';
  private animFrame: number | null = null;

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
    this.ctx.font = '16px monospace';
    this.ctx.fillText('LiveCaption', 14, 30);
    this.ctx.fillStyle = '#006622';
    this.ctx.font = '14px monospace';
    this.ctx.fillText('Waiting for connection...', 14, 60);

    console.log('[DisplaySim] Canvas initialized');
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

    ctx.font = '14px "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace';
    ctx.textBaseline = 'top';

    const lineHeight = 22;
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
