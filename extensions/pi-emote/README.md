# CGx's pi-emote
> This is sourced from: https://github.com/cgxeiji/pi-emote

> **Looking to expand the emotes gallery!** If you have an emote set to submit, please contribute to the [upstream repo](https://github.com/cgxeiji/pi-emote).

Animated pixel-art emote that lives in the top-right corner of your pi TUI session. Reacts to what the agent is doing — thinking, talking, reading, writing, using tools, etc.

![pi-emote demo](pi-emote-demo.gif)

Supports Kitty, iTerm2, Sixel, and ASCII rendering.

## Gallery

Community-contributed emote sets.

### Image Sets

| Avatar | Name | Contributor |
|--------|------|-------------|
| <img src="emotes/default/hi/hi1.png" width="64"> | `default` | [@cgxeiji](https://github.com/cgxeiji) |
| <img src="emotes/aza_choi/hi/hi_1.png" width="64"> | `aza_choi` | [@shennguyenrs](https://github.com/shennguyenrs) |
| <img src="emotes/aza_choi_nobg/hi/hi_1.png" width="64"> | `aza_choi_nobg` | [@shennguyenrs](https://github.com/shennguyenrs) |

### ASCII Sets

| Avatar | Name | Contributor |
|--------|------|-------------|
| `(^ ◡ ^)/` | `ascii` | [@cgxeiji](https://github.com/cgxeiji) |
| `ʕ•̫͡•ʔ` | `ascii-bear` | [@LCorleone](https://github.com/LCorleone) |

## Install

This extension is vendored inside **[Jarod's Pi Extensions](../../README.md)** and is installed by the parent package. From the repository root:

```bash
npm install
pi install .
```

`npm install` installs this package's runtime dependencies for local path installs. Then restart pi or run `/reload` if pi is already running.

For standalone upstream installation outside this repo, see [cgxeiji/pi-emote](https://github.com/cgxeiji/pi-emote).

## Windows Setup

For Windows, the recommended setup is to run pi in **Windows Terminal** and let pi-emote use the Sixel renderer through Chafa.

### Recommended: Windows Terminal + Chafa

1. Install Chafa:

```powershell
winget install hpjansson.Chafa
```

2. Open **Windows Terminal**. Confirm it is actually Windows Terminal:

```powershell
$env:WT_SESSION
```

If this prints a value, pi-emote will auto-detect Windows Terminal and use:

```json
{ "match": "windows-terminal", "render": "sixel" }
```

3. Start or reload pi:

```text
/reload
```

If Chafa is installed somewhere unusual, point pi-emote at it explicitly:

```powershell
$env:PI_EMOTE_CHAFA_PATH="C:\path\to\Chafa.exe"
```

### VS Code Integrated Terminal

VS Code's integrated terminal is **not Windows Terminal**, even when it uses PowerShell. It reports:

```powershell
$env:TERM_PROGRAM
# vscode
$env:WT_SESSION
# empty
```

**Image rendering is not supported in the VS Code integrated terminal.** pi-emote maps `vscode` to the ASCII renderer. See the [VS Code Integrated Terminal (ASCII)](#vs-code-integrated-terminal-ascii) section below for details. For full image rendering on Windows, use the external Windows Terminal + Chafa path above.

## States

| State | Trigger |
|-------|---------|
| hi | Session start |
| idle | Nothing happening (blinks occasionally) |
| think | Reasoning tokens streaming |
| talk | Text response streaming (TTS off) or TTS audio playback (TTS on) |
| read | `read` tool / reading tool output |
| write | `write` or `edit` tool |
| tool | Any other tool |
| failure | `bash` tool execution error |
| compact | Context compaction |

## Voice Input Integration

When the **voice-input** extension is also installed, pi-emote reacts to voice activity via `voice:state` events:

- **`listening` / `wake` / `transcribing`** → `think` animation
  - The avatar uses the thinking animation while you are speaking and during transcription (not the talk/speaking animation).

- **Assistant workflow priority**
  - While the assistant is actively working (thinking tokens, text response streaming, tool calls, or TTS playback), the assistant's own workflow states take priority over the voice listening state.
  - This prevents the avatar from showing the voice/listening animation while the assistant is still processing your prompt.

- **Restoration after assistant finishes**
  - After `agent_end` (or `tts:end`), if voice input is still listening, the avatar automatically returns to the `think` (listening) animation.

## Config

Drop a `config.json` in one of these paths (highest priority wins):

- `~/.pi/agent/extensions/pi-emote/config.json` — your global prefs
- `.pi/extensions/pi-emote/config.json` — project override

Only include what you want to change:

```json
{
  "size": 12,
  "imageSize": 32,
  "emotes": [
    { "model": "*claude*", "emote-set": "my-avatar" }
  ]
}
```

- `size` — grid width for ASCII/text fallback emotes (characters wide)
- `imageSize` — grid width for image protocols (Kitty, Sixel, iTerm2). Defaults to `size` when not set. Use a larger value to make image emotes bigger without affecting ASCII.

See `config.json` in the extension root for all defaults.

### Slash Command

Use `/emote` inside pi to inspect or change the default face set:

```text
/emote list
/emote set aza_choi_nobg
/emote import
/emote image-size 32
/emote always-show on
```

- `/emote list` — show current settings and available emote sets
- `/emote set <name>` — change the emote set (autocompletes)
- `/emote import` — open a folder picker, choose a `.zip`, validate it, and import it into your user emote sets. Existing set names prompt before overwrite; importing does not switch the active set.
- `/emote image-size <cols>` — change image sprite size (2–120 columns, applies immediately)
- `/emote always-show on|off` — keep the sprite visible even on narrow terminals (overrides `hideBelow`)

All settings save to `~/.pi/agent/extensions/pi-emote/config.json` and apply immediately.

## Supported Terminals

pi-emote uses terminal-specific image protocols to render the sprite. The correct renderer is auto-detected based on your environment, but some terminals require specific setup:

### Windows Terminal (Sixel via Chafa)

Windows Terminal supports the Sixel protocol, but pi-emote uses the [Chafa CLI](https://hpjansson.org/chafa/) as a bridge to generate the Sixel DCS sequences.

**Prerequisites:**
Install Chafa (e.g., via Winget):
```powershell
winget install hpjansson.Chafa
```

**How it works:**
- When pi-emote detects `WT_SESSION`, it automatically maps to the `sixel` renderer.
- Chafa converts the PNG frames into Sixel escape sequences.
- The output is wrapped in cursor save/restore codes (`ESC 7` / `ESC 8`) to prevent the TUI layout from drifting as the sprite animates.
- Chafa is constrained to the sprite's allocated rows/columns so it aligns perfectly in the avatar corner.

If Chafa isn't found in your PATH, you can set its location via environment variable:
```powershell
$env:PI_EMOTE_CHAFA_PATH="C:\path\to\Chafa.exe"
```

### VS Code Integrated Terminal (ASCII)

VS Code's integrated terminal uses xterm.js with the `xterm-addon-image` addon. The addon's image protocol support is incomplete for pi-emote's animation pattern:

- **Kitty graphics protocol** — alpha-stage support in xterm-addon-image. Lacks transparency composition, so the sprite area renders with a grey/checkerboard placement rectangle.
- **Sixel** — beta support, but every emitted frame is treated as a new image by the addon's storage. As the widget animates and the conversation scrolls, evicted frames leave grey/checkerboard placeholders behind and ghost sprites pile up the screen.
- **iTerm2 IIP** — causes cursor/layout drift inside the pi TUI.

All three image protocols were tested. None produce a clean result. pi-emote therefore maps VS Code to the ASCII renderer by default:

```json
{ "match": "vscode", "render": "ascii" }
```

**For full image rendering on Windows, run pi in Windows Terminal** instead — see the Windows Terminal section above. The Sixel/Chafa path there is stable.

**Workaround if you want both VS Code and the pixel sprite:** Windows Terminal can't be embedded inside VS Code's terminal pane — `wt.exe` is itself a terminal emulator (GUI host), not a shell, so it can't be selected as a VS Code terminal profile the way `bash.exe` or `pwsh.exe` can. The practical option is to run Windows Terminal as a separate window snapped alongside VS Code (Win+Left / Win+Right). You lose true docking but get the working sprite plus your editor side by side.

If you want to opt into a (known-broken) image renderer in VS Code anyway — for example to test future xterm-addon-image fixes — override the renderer in your user or project config via [Manual Terminal Overrides](#manual-terminal-overrides). Known-broken values for VS Code: `kitty`, `sixel`, `iterm2`.

> _Note: the analysis above (xterm-addon-image limitations, why Windows Terminal can't be embedded as a VS Code profile, and the recommended ASCII fallback) was written by Claude during a debugging session. Treat it as a starting point — if VS Code or xterm-addon-image ships fixes in a later release, this section may need re-testing._

### Manual Terminal Overrides

You can force a specific renderer for any terminal in your user or project config:

```json
{
  "terminals": [
    { "match": "vscode", "render": "ascii" },
    { "match": "windows-terminal", "render": "sixel" },
    { "match": "ghostty", "render": "kitty" },
    { "match": "wezterm", "render": "iterm2" }
  ]
}
```

Available render values: `"kitty"`, `"kitty-unicode"`, `"iterm2"`, `"sixel"`, `"ascii"`, `"auto"`.

## Multiplexers

pi-emote can render image avatars through **tmux** using DCS passthrough. When tmux is detected, pi-emote auto-detects the outer terminal and picks the right image protocol.

### tmux Setup

Add these to your `tmux.conf`:

```bash
# Required — allow image sequences to pass through to the outer terminal
set -g allow-passthrough on

# Required — detect outer terminal when attaching from a different terminal
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM

# Recommended — reduces flicker during animation
set -sg escape-time 0
```

Then restart tmux completely:

```bash
tmux kill-server && tmux
```

Without `allow-passthrough`, pi-emote defaults to ASCII and shows a one-time warning with setup instructions.

### Experimental Multiplexer Support

| Outer Terminal | Protocol | Status |
|----------------|----------|--------|
| Ghostty | kitty-unicode | ✅ Stable, pane-safe, auto-detected |
| kitty | kitty-unicode | ⚠️ Untested, pane-safe, auto-detected |
| iTerm2 | iterm2 | ⚠️ Experimental, opt-in only (pane bleed in multi-pane layouts) |
| WezTerm | iterm2 | ⚠️ Experimental; uses WezTerm's plain iTerm2 inline-image protocol |

The outer terminal is detected via `tmux show-environment TERM_PROGRAM`, which reflects the currently attached terminal.

Ghostty and kitty use the **kitty-unicode** renderer (Unicode placeholders) which is pane-safe — images stay within their pane and clean up on session switch. This is the default when auto-detected.

iTerm2 uses DCS passthrough for the iTerm2 image protocol. This works but has known limitations: images can bleed into adjacent panes and persist when switching sessions. On Windows, WezTerm renders the plain iTerm2 inline-image protocol (its own `imgcat` path) correctly at the cursor, so pi-emote uses the standard iTerm2 renderer there rather than raw Kitty graphics. Note: WezTerm's `doNotMoveCursor=1` extension corrupts the image render and must not be used. If you force image rendering through tmux, treat it as experimental. **Not enabled by default** — opt in explicitly:

```json
{
  "terminals": [
    { "match": "tmux", "render": "iterm2" }
  ]
}
```

### Other Multiplexers

**zellij** and **screen** are not yet supported and default to ASCII.

### Manual Override

Force a specific renderer:

```json
{
  "terminals": [
    { "match": "tmux", "render": "kitty-unicode" }
  ]
}
```

Available render values for tmux: `"auto"`, `"kitty-unicode"`, `"kitty"`, `"iterm2"`, `"ascii"`.

- `"auto"` — detect outer terminal; uses kitty-unicode for Ghostty/kitty, ASCII for others
- `"kitty-unicode"` — pane-safe Unicode placeholders (Ghostty, kitty)
- `"kitty"` — classic DCS passthrough (single-pane only, experimental)
- `"iterm2"` — iTerm2 DCS passthrough (single-pane only, experimental)
- `"ascii"` — text fallback

## Custom Emotes

Emote sets live in `emotes/<set-name>/` with PNG frames per state. Importable zip files should contain one top-level set folder using the same layout:

```
my-avatar.zip
└── my-avatar/
```

After import, the set is copied to `~/.pi/agent/extensions/pi-emote/emotes/<set-name>/` and appears in `/emote list` / `/emote set <name>`. If the set name already exists, pi-emote asks before replacing it. Importing a set does not automatically activate it.

```
emotes/my-avatar/
├── emotes.json          # optional frame hints for idle/think/talk
├── idle/*.png
├── think/*.png
├── talk/*.png
├── read/*.png
├── write/*.png
├── tool/*.png
└── ...                  # hi, failure, compact (success is reserved/unused)
```

Not all states are required. Missing ones just won't animate. PNG files must use lowercase `.png` extensions.

### Where to put them

pi-emote searches in order:

1. `.pi/extensions/pi-emote/emotes/<name>/` (project)
2. `~/.pi/agent/extensions/pi-emote/emotes/<name>/` (user)
3. Extension built-in → falls back to `default`

### Map models to sets

Glob patterns against model ID, last match wins:

```json
{
  "emotes": [
    { "model": "*", "emote-set": "default" },
    { "model": "*claude*", "emote-set": "my-avatar" },
    { "model": "*haiku*", "emote-set": "haiku-avatar" }
  ]
}
```

In this example, `claude` models use `my-avatar`, but `haiku` ones use `haiku-avatar`.
See `emotes/default/emotes.json` for per-set frame config (blink frames, talk weights).

## License

MIT
