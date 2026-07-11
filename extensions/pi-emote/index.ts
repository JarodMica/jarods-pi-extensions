import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";

import type { EmoteState, ResolvedRenderer } from "./src/types.js";
import type { Renderer } from "./src/renderer.js";
import { log, setDebug } from "./src/log.js";
import { loadLayeredConfig, saveUserDefaultEmoteSet, saveUserImageSize, saveUserAlwaysShow } from "./src/config.js";
import { resolveEmoteSet, findEmoteSetDir, loadEmotesConfig, listEmoteSets } from "./src/emotes.js";
import { EmoteSetExistsError, importEmoteZip } from "./src/importer.js";
import { openMenu, type MenuItem } from "./src/menu.js";
import { KittyRenderer } from "./src/render_kitty.js";
import { TmuxKittyRenderer } from "./src/render_tmux_kitty.js";
import { TmuxKittyUnicodeRenderer } from "./src/render_tmux_kitty_unicode.js";
import { ITermRenderer } from "./src/render_iterm.js";
import { WezTermITermRenderer } from "./src/render_wezterm_iterm.js";
import { TmuxITermRenderer } from "./src/render_tmux_iterm.js";
import { SixelRenderer } from "./src/render_sixel.js";
import { AsciiRenderer } from "./src/render_ascii.js";
import { Animator } from "./src/animator.js";
import { createWidgetFactory } from "./src/widget.js";
import { detectTerminalName, resolveRenderer } from "./src/terminal.js";

const IMAGE_STATES = ["hi", "idle", "think", "talk", "read", "write", "tool", "success", "failure", "compact"];

/** Check if a set directory contains any image frames (PNG files in state subdirs). */
function hasImageFrames(setDir: string): boolean {
  for (const state of IMAGE_STATES) {
    const stateDir = join(setDir, state);
    if (existsSync(stateDir)) {
      const files = readdirSync(stateDir).filter((f) => f.endsWith(".png"));
      if (files.length > 0) return true;
    }
  }
  return false;
}

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

async function pickZipFile(ctx: any, startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir || process.cwd());

  while (true) {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      ctx.ui.notify(`[pi-emote] Cannot read folder: ${dir}`, "warning");
      dir = getHomeDir() || process.cwd();
      continue;
    }

    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const zips = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const options = [
      "Cancel",
      "../",
      ...(dir !== resolve(getHomeDir() || dir) ? ["~/"] : []),
      ...dirs.map((name) => `${name}/`),
      ...zips,
    ];

    const choice = await ctx.ui.select(`Import emote zip: ${dir}`, options);
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "../") {
      dir = resolve(dir, "..");
      continue;
    }
    if (choice === "~/") {
      dir = resolve(getHomeDir() || dir);
      continue;
    }
    if (choice.endsWith("/")) {
      dir = resolve(dir, choice.slice(0, -1));
      continue;
    }
    return resolve(dir, choice);
  }
}

async function importEmoteZipWithOverwritePrompt(ctx: any, zipPath: string): Promise<ReturnType<typeof importEmoteZip> | null> {
  try {
    return importEmoteZip(zipPath);
  } catch (error) {
    if (!(error instanceof EmoteSetExistsError)) throw error;
    const ok = await ctx.ui.confirm(
      "Overwrite emote set?",
      `The emote set "${error.setName}" already exists.\n\nOverwrite it with ${basename(zipPath)}?`,
    );
    if (!ok) return null;
    return importEmoteZip(zipPath, { overwrite: true });
  }
}

function toolNameToState(toolName: string): EmoteState {
  switch (toolName) {
    case "read": return "read";
    case "write":
    case "edit": return "write";
    default: return "tool";
  }
}

/** Resolve imageSize from config — defaults to `size` when not set. */
import type { Config } from "./src/types.js";
function resolveImageSize(config: Config): number {
  const v = config.imageSize;
  if (typeof v === "number" && v > 0) return v;
  return config.size;
}

function createRendererFromResolved(resolved: ResolvedRenderer, imageSize: number): Renderer {
  const { protocol, multiplexer } = resolved;
  if (protocol === "kitty-unicode") {
    log(`createRenderer: using TmuxKittyUnicodeRenderer (${imageSize} cols)`);
    return new TmuxKittyUnicodeRenderer(imageSize);
  }
  if (protocol === "kitty") {
    if (multiplexer === "tmux") {
      log(`createRenderer: using TmuxKittyRenderer (${imageSize} cols)`);
      return new TmuxKittyRenderer(imageSize);
    }
    log(`createRenderer: using KittyRenderer (${imageSize} cols)`);
    return new KittyRenderer(imageSize);
  }
  if (protocol === "iterm2") {
    if (multiplexer === "tmux") {
      log(`createRenderer: using TmuxITermRenderer (${imageSize} cols)`);
      return new TmuxITermRenderer(imageSize);
    }
    // WezTerm (esp. Windows under conpty) needs absolute-column image placement:
    // conpty miscounts the cursor column after an image OSC, so the standard
    // relative-cursor iTerm2 layout drifts the avatar to the far-right and
    // stacks duplicates. WezTermITermRenderer emits plain iTerm2 and flags the
    // widget to use the conpty-safe absolute-column layout. (Kitty is stripped
    // by conpty; `doNotMoveCursor=1` corrupts the render — both ruled out.)
    if (detectTerminalName() === "wezterm") {
      log(`createRenderer: using WezTermITermRenderer (${imageSize} cols)`);
      return new WezTermITermRenderer(imageSize);
    }
    log(`createRenderer: using ITermRenderer (${imageSize} cols)`);
    return new ITermRenderer(imageSize);
  }
  if (protocol === "sixel") {
    log(`createRenderer: using SixelRenderer (${imageSize} cols)`);
    return new SixelRenderer(imageSize);
  }
  log(`createRenderer: using AsciiRenderer`);
  return new AsciiRenderer();
}

export default function (pi: ExtensionAPI) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extDir = __dirname;

  let cwd = process.cwd();
  let { config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd);
  setDebug(config.debug);

  // TTS mode from notification extension — suppresses streaming talk
  let ttsModeEnabled = false;
  let assistantWorkflowActive = false;
  let ttsPlaybackActive = false;
  let lastVoiceState: string | undefined;
  let lastVoiceListening = false;

  if (!config.enabled) return;

  // Emote set state
  let currentEmoteSet = "default";
  let ctxRef: any = null;
  let widgetActive = false;
  let lastResolved = resolveRenderer(config.terminals, userConfiguredTerminals);
  let renderer = createRendererFromResolved(lastResolved, resolveImageSize(config));

  const animator = new Animator(config, renderer);

  // --- TTS sync: listen for events from notification extension ---
  // Registered at top level (before session_start) so we don't miss the tts:mode event.
  pi.events.on("tts:mode", (data: unknown) => {
    const m = (data as { mode?: string })?.mode;
    ttsModeEnabled = m === "tts" || m === "both";
    log(`tts:mode = ${m}`);
  });
  pi.events.on("tts:start", () => {
    if (!widgetActive) return;
    log("tts:start");
    assistantWorkflowActive = true;
    ttsPlaybackActive = true;
    animator.enterTtsTalk();
  });
  pi.events.on("tts:end", () => {
    if (!widgetActive) return;
    log("tts:end");
    ttsPlaybackActive = false;
    assistantWorkflowActive = false;
    animator.exitTtsTalk();
    restoreVoiceStateIfAppropriate();
  });

  // Voice input extension integration. Until dedicated listening frames exist,
  // use the think animation for user voice activity so the avatar does not look
  // like it is speaking while Jarod is dictating/transcribing.
  pi.events.on("voice:state", (data: unknown) => {
    if (!widgetActive) return;
    const payload = data as { state?: string; listening?: boolean };
    lastVoiceState = payload.state;
    lastVoiceListening = Boolean(payload.listening);
    log(`voice:state = ${lastVoiceState}, listening=${lastVoiceListening}`);
    restoreVoiceStateIfAppropriate();
  });

  function assistantOwnsEmote(): boolean {
    return assistantWorkflowActive || ttsPlaybackActive;
  }

  function voiceStateWantsThinking(): boolean {
    return lastVoiceListening && (lastVoiceState === "listening" || lastVoiceState === "wake" || lastVoiceState === "transcribing");
  }

  function restoreVoiceStateIfAppropriate(): void {
    if (!widgetActive || assistantOwnsEmote()) return;
    if (voiceStateWantsThinking()) {
      animator.transitionTo("think");
      return;
    }
    if (lastVoiceState === "ready" || lastVoiceState === "stopped") {
      animator.transitionTo("idle");
    }
  }

  function loadEmoteSet(setName: string) {
    currentEmoteSet = setName;

    const setDir = findEmoteSetDir(setName, extDir, cwd);
    const isAsciiOnly = existsSync(join(setDir, "ascii.yaml")) && !hasImageFrames(setDir);

    if (isAsciiOnly) {
      // ASCII-only set — use AsciiRenderer regardless of terminal
      if (!(renderer instanceof AsciiRenderer)) {
        renderer = new AsciiRenderer();
        animator.setRenderer(renderer);
      }
    } else {
      // Ensure we're using the capability-based renderer
      const detected = createRendererFromResolved(lastResolved, resolveImageSize(config));
      if (renderer.constructor !== detected.constructor) {
        renderer = detected;
        animator.setRenderer(renderer);
      }
    }

    const emotesConfig = loadEmotesConfig(setDir);
    renderer.loadFrames(setDir, extDir);
    animator.setEmotesConfig(emotesConfig);
  }

  loadEmoteSet("default");

  function switchEmoteSetForModel(modelId: string) {
    const setName = resolveEmoteSet(modelId, config.emotes);
    if (setName !== currentEmoteSet) {
      loadEmoteSet(setName);
      log(`switchEmoteSet: loaded "${setName}", state="${animator.currentState}"`);
      animator.resetRenderCache();
      if (widgetActive && animator.currentState === "idle") {
        animator.enterIdle();
      } else if (widgetActive) {
        renderer.showRandomFrame(animator.currentState, true);
      }
    }
  }

  function refreshCurrentFrame() {
    animator.resetRenderCache();
    if (widgetActive && animator.currentState === "idle") {
      animator.enterIdle();
    } else if (widgetActive) {
      renderer.showRandomFrame(animator.currentState, true);
    }
  }

  function autocompleteEmoteCommand(prefix: string): AutocompleteItem[] | null {
    const sets = listEmoteSets(extDir, cwd);
    const trimmed = prefix.trimStart();

    if (trimmed.startsWith("set ")) {
      const partial = trimmed.slice(4).toLowerCase();
      const matches = sets
        .filter((setName) => setName.toLowerCase().startsWith(partial))
        .map((setName) => ({ value: `set ${setName}`, label: setName }));
      return matches.length > 0 ? matches : null;
    }

    return [
      { value: "list", label: "list" },
      { value: "set ", label: "set <emote-set>" },
      { value: "import", label: "import" },
      { value: "image-size ", label: "image-size <cols>" },
      { value: "always-show on", label: "always-show on" },
      { value: "always-show off", label: "always-show off" },
    ].filter((item) => item.value.startsWith(trimmed)) as AutocompleteItem[];
  }

  // ── Menu tree factory ─────────────────────────────────────

  function buildEmoteMenuTree(): MenuItem[] {
    const sets = listEmoteSets(extDir, cwd);
    const imgSize = resolveImageSize(config);
    const alwaysShow = config.alwaysShow ?? false;

    return [
      {
        type: "submenu",
        id: "emote-set",
        label: "Emote Set",
        children: () =>
          sets.map((setName) => ({
            type: "action" as const,
            id: `set:${setName}`,
            label: setName === currentEmoteSet ? `▸ ${setName} (current)` : setName,
          })),
      },
      { type: "action", id: "import-zip", label: "Import Emote Zip" },
      {
        type: "submenu",
        id: "display",
        label: "Display",
        children: () => [
          {
            type: "input" as const,
            id: "image-size",
            label: `Image Size  (${imgSize} cols)`,
            prompt: `Image size (2–120 columns, current: ${imgSize}):`,
            currentValue: String(imgSize),
          },
          {
            type: "action" as const,
            id: "always-show",
            label: alwaysShow ? "Always Show  (on)" : "Always Show  (off)",
          },
        ],
      },
      { type: "action", id: "status", label: "Status" },
    ];
  }

  // ── Menu action handler ────────────────────────────────────

  async function handleEmoteMenuAction(id: string, value?: string): Promise<void> {
    const ctx = menuCtx;
    if (!ctx) return;

    // Emote set selection
    if (id.startsWith("set:")) {
      const setName = id.slice(4);
      const sets = listEmoteSets(extDir, cwd);
      if (!sets.includes(setName)) {
        ctx.ui.notify(`[pi-emote] Unknown emote set "${setName}".`, "warning");
        return;
      }
      try {
        saveUserDefaultEmoteSet(setName);
        ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
        setDebug(config.debug);
        animator.updateConfig(config);
        loadEmoteSet(setName);
        refreshCurrentFrame();
        ctx.ui.notify(`[pi-emote] Emote set changed to "${setName}". Saved to user config.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[pi-emote] Failed to set emote set: ${message}`, "error");
      }
      return;
    }

    // Import emote zip
    if (id === "import-zip") {
      try {
        const zipPath = await pickZipFile(ctx, ctx.cwd ?? cwd);
        if (!zipPath) return;
        const result = await importEmoteZipWithOverwritePrompt(ctx, zipPath);
        if (!result) {
          ctx.ui.notify(`[pi-emote] Import cancelled.`, "info");
          return;
        }
        const warningText = result.warnings.length > 0 ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : "";
        ctx.ui.notify(
          `[pi-emote] Imported "${result.setName}" (${result.fileCount} files). It is now available in Emote Set.${warningText}`,
          result.warnings.length > 0 ? "warning" : "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[pi-emote] Failed to import emote zip: ${message}`, "error");
      }
      return;
    }

    // Image size
    if (id === "image-size") {
      if (!value || value === String(resolveImageSize(config))) {
        return;
      }
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 2 || n > 120) {
        ctx.ui.notify(`[pi-emote] imageSize must be a number between 2 and 120.`, "warning");
        return;
      }
      try {
        saveUserImageSize(n);
        ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
        setDebug(config.debug);
        animator.updateConfig(config);
        const newRenderer = createRendererFromResolved(lastResolved, resolveImageSize(config));
        renderer.dispose();
        renderer = newRenderer;
        animator.setRenderer(renderer);
        renderer.loadFrames(findEmoteSetDir(currentEmoteSet, extDir, cwd), extDir);
        refreshCurrentFrame();
        ctx.ui.notify(`[pi-emote] imageSize set to ${resolveImageSize(config)}. Saved to user config.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[pi-emote] Failed to set imageSize: ${message}`, "error");
      }
      return;
    }

    // Always show toggle
    if (id === "always-show") {
      try {
        const nextValue = !(config.alwaysShow ?? false);
        saveUserAlwaysShow(nextValue);
        ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
        animator.updateConfig(config);
        ctx.ui.notify(
          nextValue
            ? `[pi-emote] alwaysShow enabled — sprite never hides. Saved to user config.`
            : `[pi-emote] alwaysShow disabled — sprite hides below ${config.hideBelow} columns. Saved to user config.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[pi-emote] Failed to set alwaysShow: ${message}`, "error");
      }
      return;
    }

    // Status
    if (id === "status") {
      const sets = listEmoteSets(extDir, cwd);
      const imgSize = resolveImageSize(config);
      const alwaysShow = config.alwaysShow ?? false;
      ctx.ui.notify(
        `[pi-emote]\nEmote set: ${currentEmoteSet}\nRenderer: ${lastResolved.protocol}${lastResolved.multiplexer ? ` via ${lastResolved.multiplexer}` : ""}\nDetected terminal: ${detectTerminalName()}\nImage size: ${imgSize} cols\nGrid size: ${config.size}\nAlways show: ${alwaysShow ? "on" : "off"}\nAvailable sets: ${sets.join(", ")}`,
        "info",
      );
      return;
    }
  }

  // ── Command registration ───────────────────────────────────

  let menuCtx: any = null;

  pi.registerCommand("emote", {
    description: "Configure pi-emote (interactive menu) or use subcommands: import, set, image-size, always-show, list",
    getArgumentCompletions: autocompleteEmoteCommand,
    handler: async (args, ctx) => {
      // No arguments — open the interactive menu
      if (!args || !args.trim()) {
        menuCtx = ctx;
        await openMenu(ctx, "Emote", buildEmoteMenuTree, handleEmoteMenuAction);
        menuCtx = null;
        return;
      }

      // Subcommand path (backward compatible)
      const sets = listEmoteSets(extDir, cwd);
      const [subcommand, setName, ...extra] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "list") {
        const imgSize = resolveImageSize(config);
        ctx.ui.notify(
          `[pi-emote] Emote set: ${currentEmoteSet}  ·  renderer: ${lastResolved.protocol}${lastResolved.multiplexer ? ` via ${lastResolved.multiplexer}` : ""}  ·  terminal: ${detectTerminalName()}  ·  imageSize: ${imgSize}  ·  size: ${config.size}\nAvailable emote sets: ${sets.join(", ")}`,
          "info",
        );
        return;
      }

      if (subcommand === "import") {
        if (extra.length > 0) {
          ctx.ui.notify(`[pi-emote] Usage: /emote import`, "warning");
          return;
        }
        try {
          const zipPath = setName ? resolve(ctx.cwd ?? cwd, setName) : await pickZipFile(ctx, ctx.cwd ?? cwd);
          if (!zipPath) return;
          const result = await importEmoteZipWithOverwritePrompt(ctx, zipPath);
          if (!result) {
            ctx.ui.notify(`[pi-emote] Import cancelled.`, "info");
            return;
          }
          const warningText = result.warnings.length > 0 ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : "";
          ctx.ui.notify(
            `[pi-emote] Imported "${result.setName}" (${result.fileCount} files). It is now available in /emote set.${warningText}`,
            result.warnings.length > 0 ? "warning" : "info",
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`[pi-emote] Failed to import emote zip: ${message}`, "error");
        }
        return;
      }

      if (subcommand === "image-size") {
        if (!setName || extra.length > 0) {
          ctx.ui.notify(`[pi-emote] Usage: /emote image-size <cols> (e.g. /emote image-size 16)`, "warning");
          return;
        }
        const n = parseInt(setName, 10);
        if (isNaN(n) || n < 2 || n > 120) {
          ctx.ui.notify(`[pi-emote] imageSize must be a number between 2 and 120.`, "warning");
          return;
        }
        try {
          saveUserImageSize(n);
          ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
          setDebug(config.debug);
          animator.updateConfig(config);
          const newRenderer = createRendererFromResolved(lastResolved, resolveImageSize(config));
          renderer.dispose();
          renderer = newRenderer;
          animator.setRenderer(renderer);
          renderer.loadFrames(findEmoteSetDir(currentEmoteSet, extDir, cwd), extDir);
          refreshCurrentFrame();
          ctx.ui.notify(`[pi-emote] imageSize set to ${resolveImageSize(config)}. Saved to user config.`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`[pi-emote] Failed to set imageSize: ${message}`, "error");
        }
        return;
      }

      if (subcommand === "always-show") {
        if (!setName || extra.length > 0) {
          ctx.ui.notify(`[pi-emote] Usage: /emote always-show on|off`, "warning");
          return;
        }
        try {
          if (setName === "on") {
            saveUserAlwaysShow(true);
            ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
            animator.updateConfig(config);
            ctx.ui.notify(`[pi-emote] alwaysShow enabled — sprite never hides. Saved to user config.`, "info");
          } else if (setName === "off") {
            saveUserAlwaysShow(false);
            ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
            animator.updateConfig(config);
            ctx.ui.notify(`[pi-emote] alwaysShow disabled — sprite hides below ${config.hideBelow} columns. Saved to user config.`, "info");
          } else {
            ctx.ui.notify(`[pi-emote] Usage: /emote always-show on|off`, "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`[pi-emote] Failed to set alwaysShow: ${message}`, "error");
        }
        return;
      }

      if (subcommand !== "set" || !setName || extra.length > 0) {
        ctx.ui.notify(`[pi-emote] Usage: /emote (menu), /emote list, /emote import, /emote set <name>, /emote image-size <cols>, or /emote always-show on|off`, "warning");
        return;
      }

      if (!sets.includes(setName)) {
        ctx.ui.notify(`[pi-emote] Unknown emote set "${setName}". Available: ${sets.join(", ")}`, "warning");
        return;
      }

      try {
        saveUserDefaultEmoteSet(setName);
        ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
        setDebug(config.debug);
        animator.updateConfig(config);
        loadEmoteSet(setName);
        refreshCurrentFrame();
        ctx.ui.notify(`[pi-emote] Emote set changed to "${setName}". Saved to user config.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[pi-emote] Failed to set emote set: ${message}`, "error");
      }
    },
  });

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: hasUI=${ctx.hasUI}`);
    if (!ctx.hasUI) return;

    animator.clearAllTimers();
    cwd = ctx.cwd;
    ({ config, userConfiguredTerminals } = loadLayeredConfig(extDir, cwd));
    setDebug(config.debug);
    animator.updateConfig(config);

    // Re-create renderer in case terminal capabilities changed
    lastResolved = resolveRenderer(config.terminals, userConfiguredTerminals);
    renderer = createRendererFromResolved(lastResolved, resolveImageSize(config));
    animator.setRenderer(renderer);

    if (lastResolved.warning) {
      ctx.ui.notify(lastResolved.warning, lastResolved.warningLevel);
    } else if (renderer instanceof AsciiRenderer) {
      ctx.ui.notify("[pi-emote] No image protocol detected \u2014 using ASCII emotes.", "warning");
    }

    ctxRef = ctx;

    if (!config.enabled) return;

    // Resolve emote set for current model
    const modelId = ctx.model?.id ?? "";
    const setName = resolveEmoteSet(modelId, config.emotes);
    log(`session_start: model="${modelId}" set="${setName}" dir="${findEmoteSetDir(setName, extDir, cwd)}"`);
    loadEmoteSet(setName);

    // Create widget
    ctx.ui.setWidget("emote", createWidgetFactory({
      animator,
      config,
      pi,
      getCtxRef: () => ctxRef,
      getCurrentEmoteSet: () => currentEmoteSet,
    }), { placement: "aboveEditor" });

    widgetActive = true;
    setTimeout(() => animator.transitionTo("hi"), 500);

  });

  pi.on("session_shutdown", async (_event, ctx) => {
    animator.clearAllTimers();
    animator.disposeRenderer();
    if (widgetActive && ctx.hasUI) {
      ctx.ui.setWidget("emote", undefined);
      widgetActive = false;
    }
    animator.setTui(null);
    ctxRef = null;
  });

  pi.on("model_select", async (event) => {
    if (!widgetActive) return;
    const modelId = event.model?.id ?? "";
    const resolved = resolveEmoteSet(modelId, config.emotes);
    log(`model_select: model="${modelId}" resolved="${resolved}" current="${currentEmoteSet}"`);
    switchEmoteSetForModel(modelId);
  });

  pi.on("message_update", async (event) => {
    if (!widgetActive) return;
    if (event.message?.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (!streamEvent) return;
    assistantWorkflowActive = true;

    if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
      if (animator.currentState !== "think") {
        animator.transitionTo("think");
      }
      return;
    }

    if (streamEvent.type === "toolcall_start") {
      const partial = streamEvent.partial;
      const block = partial?.content?.[streamEvent.contentIndex];
      if (block && "name" in block && block.name) {
        animator.transitionTo(toolNameToState(block.name));
      } else {
        animator.transitionTo("tool");
      }
      return;
    }

    if (streamEvent.type !== "text_delta") return;
    const text = streamEvent.delta;
    if (!text) return;

    // When TTS is enabled, skip streaming talk — let tts:start handle it.
    if (ttsModeEnabled) return;

    if (animator.currentState !== "talk") {
      animator.transitionTo("talk");
    }
    animator.onTalkToken(text);
  });

  pi.on("agent_end", async () => {
    if (!widgetActive) return;
    assistantWorkflowActive = false;
    if (animator.currentState === "talk") {
      animator.endTalk();
    } else if (animator.currentState !== "idle" && animator.currentState !== "hi" && animator.currentState !== "compact") {
      animator.transitionTo("idle");
    }
    restoreVoiceStateIfAppropriate();
  });

  pi.on("tool_execution_start", async (event) => {
    if (!widgetActive) return;
    assistantWorkflowActive = true;
    animator.transitionTo(toolNameToState(event.toolName));
  });

  pi.on("tool_execution_end", async (event) => {
    if (!widgetActive) return;
    if (event.toolName === "bash" && event.isError) {
      animator.setHoldNextState("read");
      animator.transitionTo("failure");
    } else {
      animator.transitionTo("read");
    }
  });

  pi.on("session_before_compact", async () => {
    if (!widgetActive) return;
    animator.transitionTo("compact");
  });

  pi.on("session_compact", async () => {
    if (!widgetActive) return;
    animator.transitionTo("idle");
  });
}
