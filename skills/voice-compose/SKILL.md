---
name: voice-compose
description: Designs and attaches voice samples or final narration/line audio on the filmmaking canvas via the local generate_voice.js CLI. Use before calling generate_voice.js; when the user asks to give a character a voice, preview how a character sounds, create reusable timbre anchors for every speaking character or VO/narration, or create exact narration/VO/final line audio.
---

Default to one short reusable timbre sample per speaking character and one VO/narrator sample when narration exists. `video-compose` keeps actual shot dialogue/VO in the video prompt. Treat `audio_result.data.text` as downstream speech only for approved final narration/line reads.

## Patterns

Follow `PROJECT_AGENT.md` for context/staging. This skill owns voice prompt + CLI shape.

### 1. Character voice sample

Triggers: "give / design a voice for [character]", "what does [character] sound like", "voices for all the characters on the canvas".

- Target: any `image_result` for the person; don't gate on subtype. Read `data.local_path` before prompt; layer `name`/`role`/`description` on top.
- Call:
  ```
  node "$PAI_REPO_ROOT/server/cli/generate_voice.js" \
    --text "<line>" \
    --prompt "<voice design brief>" \
    --source-node-id <character.id>
  ```
- Prompt describes the **voice**, not the character:
  > `[age bracket] [gender], [timbre], [register], [pace], [accent if relevant]. [optional emotional color].`

- `text`: 1-3 sentence in-character sample (≤200 chars), not every script line.
- Script breakdowns: one staged call per speaker; preserve labels. Add separate VO/narrator via Pattern 2.

### 2. Narrator / VO voice sample or final line audio

Triggers: narrator voice, voice-over, "a voice that says X" without character, narration track, or explicit final line-read audio.

- Omit `--source-node-id`:
  ```
  node "$PAI_REPO_ROOT/server/cli/generate_voice.js" \
    --text "<the narration line>" \
    --prompt "<voice design brief>"
  ```
- Same prompt convention as Pattern 1.
- Reusable VO/narrator anchor: short sample line in narrator style, not full script narration.
- Final narration/line-read: copy approved text exactly into `--text`; then `data.text` is source of truth.
