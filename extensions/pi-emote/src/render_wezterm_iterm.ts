import { BaseImageRenderer } from "./render_image.js";
import type { ImageDims } from "./render_image.js";

/**
 * WezTerm iTerm2 inline-image renderer (incl. Windows under conpty).
 *
 * WezTerm renders the plain iTerm2 inline-image protocol (OSC 1337) — Kitty's
 * APC graphics sequences are stripped by Windows conpty and never reach WezTerm.
 *
 * The catch is the *live* TUI: under conpty the column counter drifts after an
 * image OSC, so relative cursor moves (`\x1b[1C`, the standard iTerm2 layout's
 * approach) land the avatar at the wrong, wandering column — it drifts to the
 * far-right and, because each frame lands somewhere new, the old sprites are
 * never overwritten and pile up. Absolute column addressing (`\x1b[<n>G`) is
 * immune to that drift (verified empirically). So this renderer emits a plain
 * iTerm2 image and the widget lays it out with the WezTerm-specific,
 * absolute-column path (`layout: "wezterm"`).
 *
 * `cursorAdvances = false` so the base class skips re-encoding identical frames
 * (the widget routes by `layout`, not by `cursorAdvances`).
 */
export class WezTermITermRenderer extends BaseImageRenderer {
  protected cursorAdvances = false;
  protected layout: "wezterm" | undefined = "wezterm";
  private frameCounter = 0;

  constructor(size: number) {
    super(size);
  }

  protected encode(base64: string, _dims: ImageDims, _rows: number, _yOffset: number): string | null {
    this.frameCounter++;
    const nameBase64 = Buffer.from(`emote-${this.frameCounter}`).toString("base64");
    const params = [
      "inline=1",
      `width=${this.size}`,
      "height=auto",
      "preserveAspectRatio=1",
      `name=${nameBase64}`,
    ];
    return `\x1b]1337;File=${params.join(";")}:${base64}\x07`;
  }

  dispose() {
    this.currentFrame = null;
  }
}
