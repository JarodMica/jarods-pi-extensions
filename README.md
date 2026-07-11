# Jarod's Pi Extensions

A collection of extensions for the [pi coding agent](https://github.com/badlogic/pi-mono/).

Includes notifications (beep / TTS), voice input, an animated pixel-art emote widget, an MCP server adapter, and long-running job monitoring — all installable in one step.

## Prerequisites

- **pi** installed (`npm install -g @earendil-works/pi-coding-agent`)
- **Node.js** 18+

### Optional (Windows)
- For the emote extension's image rendering, install [Chafa](https://hpjansson.org/chafa/) via `winget install hpjansson.Chafa` and run pi in **Windows Terminal**.

## Install

```bash
git clone https://github.com/JarodMica/jarods-pi-extensions.git
cd jarods-pi-extensions
npm install
pi install .
```

`npm install` installs this package's runtime dependencies for local path installs. Then start pi (or run `/reload` if already running).

## Uninstall

```bash
pi remove .
```

## Extensions

| Extension | Description | Docs |
|-----------|-------------|------|
| **[notification](extensions/notification/)** | Audio notifications — beep, TTS, or both (4 engine backends) | [README](extensions/notification/README.md) |
| **[voice-input](extensions/voice-input/)** | Local voice input that streams microphone audio to either the bundled Voxtral worker or a local WebSocket ASR server, fills the editor, and supports voice submit commands | [README](extensions/voice-input/README.md) |
| **[pi-emote](extensions/pi-emote/)** | Animated pixel-art avatar that reacts to agent activity | [README](extensions/pi-emote/README.md) |
| **[pi-mcp-adapter](extensions/pi-mcp-adapter/)** | Connect to MCP servers via a single ~200-token proxy tool | [README](extensions/pi-mcp-adapter/README.md) |
| **[system-prompt](extensions/system-prompt/)** | Select append-only system prompt profiles, including trust-but-verify validation behavior | [README](extensions/system-prompt/README.md) |
| **[job-monitor](extensions/job-monitor/)** | Launch and monitor long-running scripts without spending model tokens while waiting | [README](extensions/job-monitor/README.md) |

## Repository Structure

```
jarods-pi-extensions/
├── extensions/
│   ├── notification/     — Notification extension (beep / TTS)
│   ├── voice-input/      — Local voice input extension (bundled Voxtral worker or WebSocket ASR server)
│   ├── pi-emote/         — Pixel-art emote widget (vendored from cgxeiji/pi-emote)
│   ├── pi-mcp-adapter/   — MCP server adapter (vendored from nicobailon/pi-mcp-adapter)
│   ├── system-prompt/    — Append-only selectable system prompt profiles
│   └── job-monitor/      — Long-running process monitoring tool
├── skills/               — Skill directories (placeholder, add SKILL.md files)
├── prompts/              — Prompt templates (placeholder, add .md files)
├── docs/
│   ├── CONFIG.md         — Notification configuration reference
│   ├── CODE_STANDARDS.md — Repository code and workflow standards
│   └── AUTHOR_NOTES.md   — Author-facing documentation guidance
├── package.json          — Root package manifest (pi discovers extensions/skills/prompts)
└── tsconfig.json         — TypeScript config
```

The root `package.json` declares `pi.extensions`, `pi.skills`, and `pi.prompts` paths. Pi discovers extension subdirectories under `./extensions` and honors each subpackage's `pi.extensions` manifest. For a cloned local checkout, run `npm install` first so extension dependencies are available, then run `pi install .`.

## Adding Your Own Extensions, Skills, or Prompts

- **Extensions:** Create a subdirectory under `extensions/` with a `package.json` containing a `pi.extensions` array pointing to your entry point.
- **Skills:** Add a directory under `skills/` with a `SKILL.md` file.
- **Prompts:** Add Markdown files under `prompts/`.

After adding content, run `/reload` inside pi to pick up the changes.

## Vendored Extensions

`pi-emote` and `pi-mcp-adapter` are vendored copies of their upstream repositories. To update them:

1. Pull changes from the upstream repo into `upstream_extensions/<name>/`
2. Copy the updated files into `extensions/<name>/`
3. Commit and test

## Upstream Sources

| Extension | Upstream |
|-----------|----------|
| `pi-emote` | [cgxeiji/pi-emote](https://github.com/cgxeiji/pi-emote) |
| `pi-mcp-adapter` | [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) |
| `notification` | Local / custom |
| `voice-input` | Local / custom |
| `job-monitor` | Local / custom |
