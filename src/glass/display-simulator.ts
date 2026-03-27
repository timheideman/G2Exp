/**
 * DisplaySimulator — Renders G2 glasses display in the browser
 *
 * Creates a 576×288 canvas that mimics the G2 micro-LED display
 * (green text on black, monospace font, 4-bit greyscale aesthetic).
 * Used for testing without physical glasses.
 */

export class DisplaySimulator {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
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

    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(scale, scale);

    // Initial state
    this.renderText('  LiveCaption\n\n  Connecting...');
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

    // Clear to black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    // Set up green monospace text
    ctx.font = '14px "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace';
    ctx.textBaseline = 'top';

    const lines = text.split('\n');
    const lineHeight = 22;
    const paddingX = 14;
    const paddingY = 12;
    const maxLines = Math.floor((H - paddingY * 2) / lineHeight);

    // Render from bottom up (most recent at bottom)
    const visibleLines = lines.slice(-maxLines);
    const totalLines = visibleLines.length;

    for (let i = 0; i < totalLines; i++) {
      const line = visibleLines[i];
      const y = paddingY + i * lineHeight;

      // Fade: older lines are dimmer
      const age = (totalLines - 1 - i) / Math.max(totalLines - 1, 1);
      const brightness = this.getBrightness(age);

      // Check for interim cursor
      if (line.includes('━')) {
        const parts = line.split('━');
        // Render text part
        ctx.fillStyle = brightness;
        ctx.shadowColor = brightness;
        ctx.shadowBlur = 4;
        ctx.fillText(parts[0], paddingX, y);

        // Render blinking cursor
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
