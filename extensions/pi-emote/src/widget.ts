import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Config } from "./types.js";
import type { Animator } from "./animator.js";
import type { RenderedFrame } from "./renderer.js";
import { log } from "./log.js";

// --- Token formatting ---

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

// --- Info panel ---

/** Resolve imageSize from config — defaults to `size` when not set. */
function resolveImageSize(config: Config): number {
  const v = config.imageSize;
  if (typeof v === "number" && v > 0) return v;
  return config.size;
}

function buildInfoLines(width: number, gridSize: number, ctxRef: any, pi: any, theme: any): string[] {
  const lines: string[] = [];
  if (!ctxRef) return lines;

  const model = ctxRef.model;
  let modelStr = model?.name ?? "no model";
  const thinkingLevel = pi.getThinkingLevel?.() ?? "high";
  if (model?.reasoning) {
    modelStr += ` • ${thinkingLevel}`;
  }
  lines.push(theme.bold(modelStr));

  const usage = ctxRef.getContextUsage?.();
  if (usage) {
    const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
    const tokens = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
    const window = formatTokens(usage.contextWindow);
    lines.push(`Context: ${tokens}/${window} (${pct})`);
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  try {
    for (const entry of ctxRef.sessionManager.getEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        totalInput += entry.message.usage?.input ?? 0;
        totalOutput += entry.message.usage?.output ?? 0;
        totalCost += entry.message.usage?.cost?.total ?? 0;
      }
    }
  } catch (_) { /* ignore if not available */ }

  lines.push(`↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`);

  lines.push(`$${totalCost.toFixed(3)}`);

  const infoWidth = width - gridSize - 5;
  return lines.map(l => {
    if (visibleWidth(l) > infoWidth) return truncateToWidth(l, infoWidth, "…");
    return l;
  });
}

// --- Render helpers ---

/**
 * Kitty image layout: image sequence on row 0 (zero-width, cursor doesn't move),
 * avatarPad fills the space. Info text beside the image on all rows.
 */
function renderKittyFrame(frame: RenderedFrame & { kind: "image" }, width: number, gridSize: number, infoLines: string[], borderColor: (s: string) => string): string[] {
  const sep = borderColor("│");
  const leftMargin = " ";
  const avatarPad = " ".repeat(gridSize);
  const avatarSkip = `\x1b[${gridSize}C`;
  const useSkip = frame.padMode === "skip";
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    if (i === 0) {
      const pad = useSkip ? avatarSkip : avatarPad;
      lines.push(leftMargin + frame.sequence + `${pad} ${sep} ${infoLines[i] ?? ""}`);
    } else {
      lines.push(`${leftMargin}${avatarPad} ${sep} ${infoLines[i] ?? ""}`);
    }
  }

  return lines;
}

/**
 * iTerm2 image layout — text first, image last.
 *
 * The TUI processes lines top-to-bottom, erasing each with \x1b[2K before
 * writing. By placing the image on the LAST widget row with cursor-up
 * positioning, the image is rendered AFTER all line clears. It extends
 * downward over rows that already have text, filling the image area
 * (cols 1–gridSize) without being erased. Text in cols (gridSize+1)+ is preserved.
 *
 * Layout: frame.rows total (frame.rows-1 text rows + 1 image row).
 */
function renderITermFrame(frame: RenderedFrame & { kind: "image" }, width: number, gridSize: number, infoLines: string[], borderColor: (s: string) => string): string[] {
  const sep = borderColor("│");
  const skipPad = `\x1b[${1 + gridSize}C`;
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    if (i < frame.rows - 1) {
      // Text rows: cursor-right past image area, then info
      lines.push(`${skipPad} ${sep} ${infoLines[i] ?? ""}`);
    } else {
      // Last row: cursor-up to first text row, place image, then text
      // After the image, cursor returns to this row (last image row, col 0).
      const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : "";
      lines.push(`${up}\x1b[1C${frame.sequence} ${sep} ${infoLines[i] ?? ""}`);
    }
  }

  return lines;
}

/**
 * WezTerm (incl. Windows/conpty) iTerm2 layout — absolute-column placement.
 *
 * Conpty miscounts the cursor column after an image OSC, so the standard
 * relative-cursor iTerm2 layout drifts the avatar to the far-right and stacks
 * duplicates. Here every position is set with absolute column addressing
 * (`\x1b[<n>G`), which conpty tracks reliably, and the image is wrapped in
 * DECSC/DECRC (`\x1b7`/`\x1b8`) so the cursor returns to a known cell regardless
 * of how WezTerm advances it past the image.
 *
 * Layout per row (1-based columns): col 1 = left margin, cols 2..gridSize+1 =
 * avatar, col gridSize+3 = separator, info after. The image is emitted on the
 * LAST row via cursor-up so it is drawn after pi-tui's per-line `\x1b[2K`
 * clears — that clear + same-position redraw is what prevents accumulation.
 */
function renderWezTermFrame(frame: RenderedFrame & { kind: "image" }, width: number, gridSize: number, infoLines: string[], borderColor: (s: string) => string): string[] {
  const sep = borderColor("│");
  const sepCol = gridSize + 3; // 1-based column of the separator
  const imgCol = 2;            // 1-based column of the avatar (after 1-col left margin)
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    const info = infoLines[i] ?? "";
    if (i < frame.rows - 1) {
      lines.push(`\x1b[${sepCol}G${sep} ${info}`);
    } else {
      // Last row: place this row's separator/info, then cursor-up to the first
      // image row, absolute column to the avatar, save cursor, draw the image,
      // restore cursor, and drop back to the last row so pi-tui's row tracking
      // stays aligned. Nothing is written after the image.
      const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : "";
      const down = frame.rows > 1 ? `\x1b[${frame.rows - 1}B` : "";
      lines.push(`\x1b[${sepCol}G${sep} ${info}${up}\x1b[${imgCol}G\x1b7${frame.sequence}\x1b8${down}`);
    }
  }

  return lines;
}

function renderTextFrame(frame: RenderedFrame & { kind: "text" }, width: number, config: Config, infoLines: string[], borderColor: (s: string) => string): string[] {
  const sep = borderColor("│");
  const leftMargin = " ";
  const avatarPad = " ".repeat(config.size);

  // Place emote text on the 3rd row (index 2), vertically centered in a
  // block tall enough to hold the info panel (min 4 rows to match image size).
  const emoteLines = frame.lines;
  const emoteRow = 2;
  const rowCount = Math.max(emoteRow + emoteLines.length, infoLines.length, 4);
  const lines: string[] = [];

  for (let i = 0; i < rowCount; i++) {
    const emoteIdx = i - emoteRow;
    const emote = (emoteIdx >= 0 && emoteIdx < emoteLines.length) ? emoteLines[emoteIdx] : "";
    const emoteWidth = visibleWidth(emote);
    // Center the emote within config.size columns
    const totalPad = config.size - emoteWidth;
    const padLeft = totalPad > 0 ? " ".repeat(Math.floor(totalPad / 2)) : "";
    const padRight = totalPad > 0 ? " ".repeat(Math.ceil(totalPad / 2)) : "";
    const cell = emote ? `${padLeft}${emote}${padRight}` : avatarPad;
    lines.push(`${leftMargin}${cell} ${sep} ${infoLines[i] ?? ""}`);
  }

  return lines;
}

/**
 * Unicode placeholder layout: placeholder text lines fill rows 0–N.
 * Each line is already config.size wide (placeholder chars). Info beside it.
 */
function renderPlaceholderFrame(frame: RenderedFrame & { kind: "placeholder" }, width: number, config: Config, infoLines: string[], borderColor: (s: string) => string): string[] {
  const sep = borderColor("│");
  const leftMargin = " ";
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    lines.push(`${leftMargin}${frame.lines[i] ?? ""} ${sep} ${infoLines[i] ?? ""}`);
  }

  return lines;
}

// --- Widget factory ---

export interface WidgetDeps {
  animator: Animator;
  config: Config;
  pi: any;
  getCtxRef: () => any;
  getCurrentEmoteSet: () => string;
}

export function createWidgetFactory(deps: WidgetDeps) {
  return (_tui: any, theme: any) => {
    deps.animator.setTui(_tui);
    return {
      render(width: number): string[] {
        const { animator, config } = deps;

        if (!config.alwaysShow && width < config.hideBelow) return [];

        const frame = animator.getRenderedFrame();
        if (!frame) {
          log(`render: no frame`);
          return [];
        }

        log(`render: kind=${frame.kind}, set="${deps.getCurrentEmoteSet()}"`);

        const thinkingLevel = deps.pi.getThinkingLevel?.() ?? "high";
        const borderColor = (theme as any).getThinkingBorderColor?.(thinkingLevel)
          ?? ((s: string) => theme.fg("border", s));
        const border = borderColor("─".repeat(width));

        // Image protocols use imageSize; ASCII/text fallbacks use size
        const gridSize = frame.kind === "image" ? resolveImageSize(config) : config.size;
        const infoLines = buildInfoLines(width, gridSize, deps.getCtxRef(), deps.pi, theme);

        const lines: string[] = [];
        lines.push(border);

        if (frame.kind === "image") {
          if (frame.layout === "wezterm") {
            lines.push(...renderWezTermFrame(frame, width, gridSize, infoLines, borderColor));
          } else if (frame.cursorAdvances) {
            lines.push(...renderITermFrame(frame, width, gridSize, infoLines, borderColor));
          } else {
            lines.push(...renderKittyFrame(frame, width, gridSize, infoLines, borderColor));
          }
        } else if (frame.kind === "placeholder") {
          lines.push(...renderPlaceholderFrame(frame, width, config, infoLines, borderColor));
        } else {
          lines.push(...renderTextFrame(frame, width, config, infoLines, borderColor));
        }

        return lines;
      },
      invalidate() {},
      dispose() {
        deps.animator.setTui(null);
      },
    };
  };
}
