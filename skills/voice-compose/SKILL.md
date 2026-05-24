---
name: voice-compose
description: Designs and attaches voices to characters on the filmmaking canvas via the local generate_voice.js CLI, following canvas-aware conventions for voice description, sample text, and attachment to the target node. Use when the user asks to give a character a voice; design a voice, sample, or read; preview how a character sounds; or generate a standalone narration / voice-over track that isn't tied to a specific character.
---

**Background by default.** Every `generate_voice.js` Bash call must pass `run_in_background: true` and be polled with BashOutput — the PreToolUse hook blocks foreground attempts (including parallel bulk-voice calls; each one needs the flag).

## Patterns

Pick the one that fits. When unsure, read `./workflow.json` first to see which character the voice attaches to.

### 1. Character voice

Triggers: "give / design a voice for [character]", "what does [character] sound like", "voices for all the characters on the canvas".

- Identify the target — any `image_result` of the person you want to voice. Don't gate on `data.subtype`.
- Read the image first. Open `data.local_path` before composing the prompt — voice description is grounded in what you see. Any `data.name` / `role` / `description` on the node layers on top, doesn't replace.
- Run via Bash (`$PAI_REPO_ROOT` is exported by the viewer — see CLAUDE.md § "Media CLIs / Invocation path"):
  ```
  node "$PAI_REPO_ROOT/server/cli/generate_voice.js" \
    --text "<line>" \
    --prompt "<voice design brief>" \
    --source-node-id <character.id>
  ```
- `prompt` template — describe the **voice itself**, not the character:
  > `[age bracket] [gender], [timbre], [register], [pace], [accent if relevant]. [optional emotional color].`

  ✅ "Mid-50s man, gravelly baritone, measured pace, slight rasp from decades of smoking, weary but steady."
  ✅ "Young woman, bright mezzo, warm, quick and percussive. Slight Southern lilt."
  ❌ "Detective Morris's voice." — names the character, not the voice. The model needs sound qualities.
- `text` template — a short in-character line the user will actually hear. 1–3 sentences, ≤200 characters is plenty. Pick something that reveals the character:
  - a characteristic line from an imagined scene,
  - a brief self-introduction in their voice ("I've been working this beat for twenty years…"),
  - or a catchphrase.
- Calls go via `--stage` — see CLAUDE.md § "Draft gate". Bulk asks: one Bash call per target in a single turn, each becoming its own draft card.
- The real `audio_result` (subtype `voice`, with `source_id` + derived edge to the source image) is minted only after the user fires the draft.

### 2. Standalone voice / narration / V.O.

Triggers: "a narrator voice", "voice-over for the opener", "a voice that says X" (no specific character named), "drop a narration track on the canvas".

- Omit `--source-node-id`. The CLI creates a free-floating `audio_result` (subtype `voice`, no `source_id`, no edge):
  ```
  node "$PAI_REPO_ROOT/server/cli/generate_voice.js" \
    --text "<the narration line>" \
    --prompt "<voice design brief>"
  ```
- Same `prompt` and `text` conventions as Pattern 1.
- After the user fires, the audio lands as a standalone `audio_result` on the canvas — usable as a `--ref-audio-source-id` for a later video gen, or just to preview a tone.

### More patterns (future)

This skill will grow to cover dialogue line readings and singing samples. For now Patterns 1 + 2 cover both attached and standalone voice generation. If the user asks for something that doesn't fit, describe what you'd do and ask before calling the tool.

## On failure

See CLAUDE.md § "Failure handling". For `content_filtered`, drop charged adjectives in the prompt.
