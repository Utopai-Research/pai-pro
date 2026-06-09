---
name: voice-compose
description: Designs and attaches voice samples or final narration/line audio on the filmmaking canvas via the local generate_voice.js CLI. Use before calling generate_voice.js; when the user asks to give a character a voice, preview how a character sounds, create a reusable timbre anchor for video dialogue, or create exact narration/VO/final line audio.
---

**Stage by default.** Every `generate_voice.js` call goes through `--stage`; see the project `PROJECT_AGENT.md` § "Draft gate" for draft and result handling.

`--text` is the exact spoken text for this audio node. For video dialogue, default to one short reusable voice sample per speaking character; downstream `video-compose` keeps the actual shot dialogue in the video prompt and uses the sample as a timbre anchor. Only treat `audio_result.data.text` as the downstream speech source when the node is an approved final narration or line read.

## Patterns

Pick the one that fits. For target lookup, follow the project `PROJECT_AGENT.md` § "Choosing context"; this skill only owns voice-specific prompt and CLI shape.

### 1. Character voice sample

Triggers: "give / design a voice for [character]", "what does [character] sound like", "voices for all the characters on the canvas".

- Identify the target — any `image_result` of the person you want to voice. Don't gate on `data.subtype`.
- Read the image first. Open `data.local_path` before composing the prompt — voice description is grounded in what you see. Any `data.name` / `role` / `description` on the node layers on top, doesn't replace.
- Run via Bash (`$PAI_REPO_ROOT` is exported by the viewer — see the project `PROJECT_AGENT.md` § "Media CLIs (server/cli/)"):
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
- `text` template — a short in-character sample, not every script line. 1–3 sentences, ≤200 characters is plenty. Pick something that reveals the character:
  - a characteristic line from an imagined scene,
  - a brief self-introduction in their voice ("I've been working this beat for twenty years…"),
  - or a catchphrase.
- For scripted video dialogue, generate one sample per speaker unless the user explicitly asks for separate final line reads. The video prompt still carries each shot's dialogue verbatim.
- Calls go via `--stage` — see the project `PROJECT_AGENT.md` § "Draft gate". Bulk asks: one call per target in a single turn, each becoming its own draft card.
- The real `audio_result` (subtype `voice`, with `source_id` + derived edge to the source image) is minted only after the user fires the draft.

### 2. Final narration / line audio

Triggers: "a narrator voice", "voice-over for the opener", "a voice that says X" (no specific character named), "drop a narration track on the canvas", or an explicit request for final line-read audio.

- Omit `--source-node-id`. The CLI creates a free-floating `audio_result` (subtype `voice`, no `source_id`, no edge):
  ```
  node "$PAI_REPO_ROOT/server/cli/generate_voice.js" \
    --text "<the narration line>" \
    --prompt "<voice design brief>"
  ```
- Same `prompt` convention as Pattern 1. Copy the approved narration/dialogue exactly into `--text`; this node's `data.text` is then the source of truth for that final audio.
- After the user fires, the audio lands as a standalone `audio_result` on the canvas — usable as final audio or as a `--ref-audio-source-id` when the video must follow that exact read.
