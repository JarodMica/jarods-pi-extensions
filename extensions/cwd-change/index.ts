import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Container,
  truncateToWidth,
  type Component,
  type TUI,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  SessionManager,
  Theme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Directory Picker Component
// ---------------------------------------------------------------------------

interface DirectoryItem {
  name: string;
  path: string;
  isDir: boolean;
  isParent?: boolean;
}

class DirectoryPicker implements Component {
  private currentPath: string;
  private allItems: DirectoryItem[] = [];
  private items: DirectoryItem[] = [];
  private selectedIndex = 0;
  private showFiles = false;
  private query = "";
  private cachedWidth?: number;
  private cachedLines?: string[];

  public onSelect?: (dir: string) => void;
  public onCancel?: () => void;

  constructor(private tui: TUI, private theme: Theme, initialPath: string) {
    this.currentPath = resolve(initialPath);
    this.loadItems();
  }

  private loadItems(): void {
    this.allItems = [];
    const parent = join(this.currentPath, "..");
    if (resolve(parent) !== this.currentPath) {
      this.allItems.push({ name: "..", path: parent, isDir: true, isParent: true });
    }

    try {
      const entries = readdirSync(this.currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(this.currentPath, entry.name);
        if (entry.isDirectory()) {
          this.allItems.push({ name: entry.name + "/", path: fullPath, isDir: true });
        } else if (this.showFiles) {
          this.allItems.push({ name: entry.name, path: fullPath, isDir: false });
        }
      }
    } catch {
      // Gracefully handle permission denied or other filesystem errors
    }

    this.allItems.sort((a, b) => {
      if (a.isParent) return -1;
      if (b.isParent) return 1;
      return a.name.localeCompare(b.name);
    });
    this.applyFilter();
  }

  private applyFilter(): void {
    const normalizedQuery = this.query.trim().toLowerCase();
    if (!normalizedQuery) {
      this.items = [...this.allItems];
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
      this.invalidate();
      return;
    }

    const parent = this.allItems.find((item) => item.isParent);
    const matches = this.allItems.filter((item) => {
      if (item.isParent) return false;
      return item.name.toLowerCase().includes(normalizedQuery);
    });

    this.items = parent ? [parent, ...matches] : matches;
    this.selectedIndex = matches.length > 0 && parent ? 1 : 0;
    this.invalidate();
  }

  private setQuery(query: string): void {
    this.query = query;
    this.applyFilter();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    // Current path header
    const pathDisplay = this.currentPath.replace(/\\/g, "/");
    lines.push(this.theme.fg("muted", truncateToWidth(`  ${pathDisplay}`, width)));
    const queryText = this.query ? this.theme.fg("accent", this.query) : this.theme.fg("dim", "type to filter folders");
    lines.push(truncateToWidth(`  Search: ${queryText}`, width));
    lines.push(this.theme.fg("dim", "─".repeat(Math.min(width - 2, 80))));

    if (this.items.length === 0) {
      lines.push(this.theme.fg("warning", this.query ? "  (no matches)" : "  (empty directory)"));
    }

    // Scrolling list
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.items.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.items.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i]!;
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "› ") : "  ";
      const itemText = item.isDir ? this.theme.fg("text", item.name) : this.theme.fg("dim", item.name);
      const line = prefix + itemText;

      if (isSelected) {
        lines.push(this.theme.bg("selectedBg", truncateToWidth(line, width)));
      } else {
        lines.push(truncateToWidth(line, width));
      }
    }

    if (startIndex > 0 || endIndex < this.items.length) {
      lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`));
    }

    lines.push("");
    const hints = "type filter · ↑↓ navigate · Enter open · Tab select cwd · Backspace edit/up · Ctrl+F files · Esc clear/cancel";
    lines.push(this.theme.fg("dim", truncateToWidth(hints, width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, "enter")) {
      const item = this.items[this.selectedIndex];
      if (item && item.isDir) {
        this.currentPath = item.path;
        this.query = "";
        this.selectedIndex = 0;
        this.loadItems();
      }
    } else if (matchesKey(data, "tab")) {
      this.onSelect?.(this.currentPath);
      return;
    } else if (matchesKey(data, "escape")) {
      if (this.query) {
        this.setQuery("");
      } else {
        this.onCancel?.();
        return;
      }
    } else if (matchesKey(data, "backspace")) {
      if (this.query) {
        this.setQuery(this.query.slice(0, -1));
      } else {
        const parent = join(this.currentPath, "..");
        if (resolve(parent) !== this.currentPath) {
          this.currentPath = parent;
          this.selectedIndex = 0;
          this.loadItems();
        }
      }
    } else if (matchesKey(data, "ctrl+f")) {
      this.showFiles = !this.showFiles;
      this.loadItems();
    } else if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.setQuery(this.query + data);
    } else {
      return; // Ignore unhandled keys
    }

    this.invalidate();
    this.tui.requestRender();
  }
}

// ---------------------------------------------------------------------------
// Extension Logic
// ---------------------------------------------------------------------------

async function switchCwd(ctx: ExtensionCommandContext, targetCwd: string): Promise<void> {
  if (!existsSync(targetCwd)) {
    ctx.ui.notify(`Directory does not exist: ${targetCwd}`, "error");
    return;
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (!currentSessionFile) {
    ctx.ui.notify("No active session file to fork from.", "error");
    return;
  }

  try {
    const newSessionManager = SessionManager.forkFrom(currentSessionFile, targetCwd);
    const newSessionFile = newSessionManager.getSessionFile();
    if (!newSessionFile) {
      ctx.ui.notify("Failed to create forked session file.", "error");
      return;
    }

    await ctx.switchSession(newSessionFile, {
      withSession: async (newCtx) => {
        newCtx.ui.notify(`Switched cwd to: ${newCtx.cwd}`, "info");
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to switch cwd: ${msg}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cwd-change", {
    description: "Fork the current session into a new working directory",
    handler: async (args, ctx) => {
      const targetPath = args.trim();

      // If a valid directory path is provided, switch directly
      if (targetPath && existsSync(targetPath)) {
        await switchCwd(ctx, resolve(targetPath));
        return;
      }

      // Otherwise, open the TUI directory picker
      const startPath = targetPath || ctx.cwd;
      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const picker = new DirectoryPicker(tui, theme, startPath);
        picker.onSelect = (dir) => done(dir);
        picker.onCancel = () => done(null);

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(picker);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        // Container doesn't auto-delegate handleInput to children — wire it up explicitly
        return {
          render: (w: number) => container.render(w),
          invalidate: () => { container.invalidate(); },
          handleInput: (data: string) => {
            picker.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result) {
        await switchCwd(ctx, result);
      }
    },
  });
}
