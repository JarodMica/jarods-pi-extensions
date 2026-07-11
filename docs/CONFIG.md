# Notification Configuration

Configuration for the response notification extension.

## Interactive Menu
Run `/notification` to open the drill-down configuration menu:

- **↑↓** — Navigate items
- **Enter** — Select action or enter submenu
- **Esc** — Go back one level (or close at root)

Menu sections:

| Section | Purpose |
|---|---|
| **Mode** | Set notification mode: `off`, `beep`, `tts`, `both` |
| **Engine** | Select TTS engine and configure per-engine settings |
| **TTS Output** | Configure how TTS handles output (verbose vs. summarized) |
| **Debug** | Test beep playback and TTS synthesis |
| **Status** | Show current configuration summary |

### Engine Configuration
Each engine has its own submenu under **Engine**:

**fish:**
- Select fish
- Set API key (value is never displayed)
- Clear API key
- Set reference ID
- Set model

**openai-compatible:**
- Select openai-compatible
- Set API key (value is never displayed)
- Clear API key
- Set base URL
- Set model
- Set voice

**windows-native:**
- Select windows-native

**vllm-omni:**
- Select vllm-omni
- Browse audio (.wav) — pick a reference audio file via file dialog
- Browse transcript (.txt) — pick the transcript file (optional but recommended)
- Test server connection — verify the server at `http://localhost:8091` is reachable
- Upload & cache voice — upload the audio to the server and cache the voice
- Test TTS playback — synthesize and play a short test sentence

Voice name is auto-derived from the audio file name (e.g. `my_voice.wav` → `my_voice`).
The transcript is read directly from the selected `.txt` file.

### TTS Output Configuration
Under **TTS Output**:

- **Output Style** — Choose `verbose` (read full output) or `shortened` (summarize before TTS)
- **Select summarizer model** — Pick an LLM model from those available via `/model` (must have auth configured)
- **Set skip threshold (sentences)** — Responses shorter than this many sentences are not summarized (default: 4)
- **Set summarizer timeout (seconds)** — Increase or decrease the LLM summarizer request timeout (default: 90)
- **Summary Style** — Choose `plain` or `Fish Audio tags` for shortened summaries
- **Show Fish Audio tags prompt file path** — Display the Markdown file used for Fish Audio tag instructions
- **Reset Fish Audio tags prompt file** — Restore the bundled Fish Audio tag instructions

When `shortened` is active, the assistant response is sent to the configured summarizer model as a separate API call. The summarizer returns a concise spoken summary, shown below the final output as a dim custom message that is not sent to the LLM as chat context. If the response contains multiple distinct questions, choices, or tasks that may need an answer, the summarizer is prompted to preserve them as a short spoken sequence using natural labels such as "First," "Second," and "Third." The preview label changes from `TTS summary` to `TTS action items` when the generated summary appears to contain that spoken sequence. If `Fish Audio tags` summary style is enabled, that summary may include Fish Audio bracket cues such as `[calm]`, `[emphasis]`, `[break]`, and `[laughing]` for more natural TTS performance. If the summarizer call fails, an error is shown and TTS is skipped for that message.

## Startup Flag
Override the notification mode at launch:
```bash
pi --notification beep   # or tts, both, off
```

## Settings File
Settings are persisted to `~/.pi/agent/notification.json` (via `getAgentDir()`).

### Configuration Fields
- `mode`: Notification behavior.
  - `off`: No notifications.
  - `beep`: Play a sound at the end of a response.
  - `tts`: Read the final response using the configured TTS engine.
  - `both`: Beep and read the response at the end.
- `ttsEngine`: The engine used for speech synthesis.
  - `fish`: High-quality streaming TTS (Fish Audio).
  - `openai-compatible`: OpenAI-compatible TTS API.
  - `windows-native`: Local Windows SAPI using the system default voice.
  - `vllm-omni`: Local vLLM-Omni server (S2-Pro) via WebSocket streaming.
- `fish`:
  - `apiKey`: API key for Fish Audio.
  - `referenceId`: The voice reference ID to use.
  - `model`: The synthesis model (e.g., `s2-pro`).
- `openAiCompatible`:
  - `apiKey`: API key for the provider.
  - `baseUrl`: The API base URL.
  - `model`: The TTS model to use.
  - `voice`: The voice name/ID.
- `vllmOmni`:
  - `baseUrl`: The vLLM-Omni server base URL (e.g. `http://localhost:8091`).
  - `audioPath`: Path to the local reference `.wav` file.
  - `refTextPath`: Path to the transcript `.txt` file (read automatically, no typing needed).
  - `voiceCached`: Whether the voice has been uploaded to the server.
  - `maxNewTokens`: Maximum generation tokens (default `256`).
  - Voice name is auto-derived from the audio file basename.
- `ttsOutputMode`: How TTS handles the assistant output.
  - `verbose`: Read the full response as-is (default).
  - `shortened`: Send the response to an LLM summarizer first, then read the summary. Skips summarization if the response has fewer sentences than `summarizer.skipThreshold`.
- `summarizer`:
  - `provider`: The model provider (e.g. `anthropic`). Selected from models available via `/model`.
  - `modelId`: The model ID (e.g. `claude-sonnet-4-20250514`).
  - `skipThreshold`: Minimum sentence count before summarization is applied (default `4`).
  - `timeoutSeconds`: LLM summarizer request timeout in seconds (default `90`).
  - `disableThinking`: Whether summarizer requests should ask supported models to disable thinking/reasoning (default `true`).
  - `summaryStyle`: Summary output style for shortened TTS summaries: `plain` or `fish-audio-tags` (default `plain`).
  - Fish Audio tag instructions are loaded from `extensions/notification/fish-audio-tags-prompt.md` when `summaryStyle` is `fish-audio-tags`.

## Environment Variables
API keys can be provided via environment variables to override stored settings:
- `PI_NOTIFICATION_FISH_API_KEY` or `FISH_AUDIO_API_KEY`
- `PI_NOTIFICATION_OPENAI_TTS_API_KEY` or `OPENAI_API_KEY`

## Emote Synchronization

When both the notification and pi-emote extensions are installed, the emote's mouth animation syncs to TTS audio:

| Mode | Emote behavior during streaming | Emote behavior during TTS |
|---|---|---|
| `off` | Mouth animates per token, goes idle when streaming ends | N/A |
| `beep` | Mouth animates per token, goes idle when streaming ends | N/A |
| `tts` | Stays in think/tool/idle states (no streaming talk) | Mouth animates for full playback duration |
| `both` | Stays in think/tool/idle states (no streaming talk) | Mouth animates for full playback duration |

## Defaults
| Setting | Default |
|---|---|
| Mode | `off` |
| TTS Engine | `fish` |
| Fish model | `s2-pro` |
| Fish reference_id | `6d370109274d4c29ab83ad6b6af77978` |
| OpenAI-compatible base URL | `http://localhost:8000/v1` |
| OpenAI-compatible model | `tts-1` |
| OpenAI-compatible voice | `alloy` |
| vLLM-Omni base URL | `http://localhost:8091` |
| vLLM-Omni voice name | auto-derived from audio filename |
| vLLM-Omni max_new_tokens | `256` |
| vLLM-Omni sample rate | `44100` (PCM16 mono) |
| TTS output mode | `verbose` |
| Summarizer model | not set |
| Summarizer skip threshold | `4` sentences |
| Summarizer timeout | `90` seconds |
| Summarizer max output tokens | `1200` |
| Summarizer thinking | disabled by default |
| Summarizer style | `plain` |
| Fish Audio tags prompt | `extensions/notification/fish-audio-tags-prompt.md` |
