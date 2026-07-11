import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";

/* ── Menu types ───────────────────────────────────────────── */

export type MenuItem =
  | { type: "action"; id: string; label: string }
  | { type: "submenu"; id: string; label: string; children: () => MenuItem[] }
  | { type: "input"; id: string; label: string; prompt: string; placeholder?: string; currentValue?: string; isSecret?: boolean; clearOnEdit?: boolean };

export type MenuTreeFactory = () => MenuItem[];
export type MenuActionCallback = (id: string, value?: string) => Promise<void>;

/* ── Menu state ───────────────────────────────────────────── */

interface MenuLevel {
  title: string;
  items: MenuItem[];
  selected: number;
}

/* ── Public entry point ───────────────────────────────────── */

/**
 * Open the notification menu.  Stays alive until the user presses Escape
 * at the root level.  Calls `onAction(id, value?)` for leaf actions and
 * input submissions — the callback may mutate settings / persist / play
 * audio.  After the callback resolves the menu re-renders via `treeFactory`.
 */
export async function openMenu(
  ctx: ExtensionCommandContext,
  rootTitle: string,
  treeFactory: MenuTreeFactory,
  onAction: MenuActionCallback,
): Promise<void> {
  if (!ctx.hasUI) return;

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    // ── State ──────────────────────────────────────────────
    const root: MenuLevel = { title: rootTitle, items: treeFactory(), selected: 0 };
    const stack: MenuLevel[] = [root];
    let mode: "browse" | "input" = "browse";
    let inputBuffer = "";
    let inputItem: Extract<MenuItem, { type: "input" }> | null = null;
    let busy = false; // prevent key handling during async action

    const current = () => stack[stack.length - 1];

    // ── Helpers ────────────────────────────────────────────

    function clampSelected(level: MenuLevel) {
      const n = level.items.length;
      if (n === 0) { level.selected = 0; return; }
      level.selected = Math.max(0, Math.min(n - 1, level.selected));
    }

    function redact(id: string, value: string): string {
      if (id.includes("api-key") || id.includes("apiKey")) return "••••••••";
      return value;
    }

    // ── Render ─────────────────────────────────────────────

    function render(): string[] {
      const lines: string[] = [];

      if (mode === "input" && inputItem) {
        lines.push(theme.fg("accent", theme.bold(current().title)));
        lines.push("");
        lines.push(theme.fg("muted", inputItem.prompt));
        lines.push(theme.fg("accent", `▸ ${inputBuffer}`));
        lines.push("");
        const hints = "Enter confirm  ·  Esc cancel";
        lines.push(theme.fg("dim", hints));
        return lines;
      }

      const level = current();
      lines.push(theme.fg("accent", theme.bold(level.title)));
      lines.push("");

      const items = level.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const sel = i === level.selected;
        let label = item.label;

        if (item.type === "submenu") label += " …";
        if (item.type === "input" && item.currentValue !== undefined && item.currentValue !== "") {
          label += `  (${redact(item.id, item.currentValue)})`;
        }

        if (sel) {
          lines.push(theme.fg("accent", `▸ ${label}`));
        } else {
          lines.push(`  ${label}`);
        }
      }

      lines.push("");
      const hints: string[] = [];
      if (stack.length > 1) hints.push("Esc back");
      else hints.push("Esc close");
      hints.push("Enter select");
      lines.push(theme.fg("dim", hints.join("  ·  ")));
      return lines;
    }

    const container = new Container();
    let textComp = new Text("", 0, 0);
    container.addChild(textComp);

    function refresh() {
      textComp.setText(render().join("\n"));
      tui.requestRender();
    }
    refresh();

    // ── Action execution ───────────────────────────────────

    async function executeAction(id: string, value?: string) {
      if (busy) return;
      busy = true;
      // Show a brief indicator
      textComp.setText(theme.fg("dim", "  …"));
      tui.requestRender();
      try {
        await onAction(id, value);
      } catch (e) {
        // onAction should handle its own errors / notifications
      } finally {
        busy = false;
        // Rebuild tree and refresh
        rebuildTree();
        refresh();
      }
    }

    function rebuildTree() {
      // Rebuild from root, preserving stack depth path
      root.items = treeFactory();
      clampSelected(root);
      // Re-resolve submenu children up the stack
      for (let i = 1; i < stack.length; i++) {
        const parentItems = stack[i - 1].items;
        const parentSel = stack[i - 1].selected;
        const parentItem = parentItems[parentSel];
        if (parentItem && parentItem.type === "submenu") {
          stack[i].items = parentItem.children();
          clampSelected(stack[i]);
        }
      }
    }

    // ── Input handling ─────────────────────────────────────

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (busy) return;

        // ── Input mode ─────────────────────────────────────
        if (mode === "input" && inputItem) {
          if (matchesKey(data, "enter")) {
            const value = inputBuffer.trim();
            const id = inputItem.id;
            mode = "browse";
            inputBuffer = "";
            inputItem = null;
            void executeAction(id, value);
            return;
          }
          if (matchesKey(data, "escape")) {
            mode = "browse";
            inputBuffer = "";
            inputItem = null;
            refresh();
            return;
          }
          if (matchesKey(data, "backspace")) {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (matchesKey(data, "escape")) {
            // ignore stray escape chars during input
          } else {
            // Handle bracketed paste (\x1b[200~...content...\x1b[201~) and plain keystrokes
            const pasteMatch = data.match(/^\x1b\[200~(.*)\x1b\[201~$/s);
            if (pasteMatch) {
              inputBuffer += pasteMatch[1].replace(/\r$/, "");
            } else if (data.length === 1 && data !== "\n" && data !== "\r") {
              inputBuffer += data;
            }
          }
          refresh();
          return;
        }

        // ── Browse mode ────────────────────────────────────
        const level = current();
        const n = level.items.length;

        if (matchesKey(data, "up")) {
          if (n > 0) level.selected = (level.selected - 1 + n) % n;
          refresh();
          return;
        }

        if (matchesKey(data, "down")) {
          if (n > 0) level.selected = (level.selected + 1) % n;
          refresh();
          return;
        }

        if (matchesKey(data, "escape")) {
          if (stack.length > 1) {
            stack.pop();
            clampSelected(current());
            refresh();
          } else {
            done();
          }
          return;
        }

        if (matchesKey(data, "enter")) {
          const item = level.items[level.selected];
          if (!item) return;

          if (item.type === "action") {
            void executeAction(item.id);
            return;
          }

          if (item.type === "input") {
            mode = "input";
            inputBuffer = item.clearOnEdit ? "" : (item.currentValue && !item.isSecret ? item.currentValue : "");
            inputItem = item;
            refresh();
            return;
          }

          if (item.type === "submenu") {
            const childLevel: MenuLevel = {
              title: `${level.title} › ${item.label}`,
              items: item.children(),
              selected: 0,
            };
            stack.push(childLevel);
            refresh();
            return;
          }
        }
      },
    };
  });
}
