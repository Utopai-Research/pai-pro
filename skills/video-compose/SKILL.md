---
name: video-compose
description: Generates and prompts video clips on the filmmaking canvas. Use when the user asks to generate, render, animate, continue, restyle, edit, shoot, or compose a video clip; render script or shot notes as video; animate a storyboard, starting frame, image, character, location, or reference; use image, video, audio, storyboard, starting-frame, or voice refs; compose an ad, brand film, product promo, music-video shot, or video sequence; or before calling generate_video.js. Owns video CLI flags, refs, prompt construction, audio-ref handling, and video failure recovery.
---

This file is the intent dispatcher. Each pattern below names triggers, the CLI invocation, edge / node rules, and which reference owns the prompt construction. References live in `references/`.

## Hard defaults

Behaviors that production-judgment instinct will silently flip when they aren't enshrined here. Don't override these without the user explicitly asking.

- **STAGE BY DEFAULT** — every `generate_video.js` call goes through `--stage`; see the project `PROJECT_AGENT.md` § "Draft gate" for draft and result handling.
- **AUDIO ON BY DEFAULT** — every `generate_video.js` call generates an audio track (`generate_audio: true`). Pass `--no-audio` ONLY when the user has explicitly asked for a silent clip ("silent", "no audio", "I'll add sound in post"). Trailer / portrait / cinematic framing is NOT a trigger; audio is the baseline, not optional polish.

## First-use video mode

Before the first video generation in a project/session, ask once if no video mode is known: `720p Preview ~$0.20/s` recommended, `480p Draft ~$0.08/s`, or `1080p Final ~$0.44/s`. Put the price in each option label. If the user skips, use `720p Preview`. Pass `--resolution` only for `480p Draft` or `1080p Final`.

## CLI shape

```
node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." [--duration 15] [--aspect-ratio 16:9]
  [--resolution <480p|1080p>] [--no-audio]
  [--label "..."] [--ref-source-id <id> ...] [--ref-audio-source-id <audio_id> ...]
  [--source-node-id <id>] [--shot-id <N>]
```

`$PAI_REPO_ROOT` is exported by the viewer — see the project `PROJECT_AGENT.md` § "Media CLIs (server/cli/)".

Calls go via `--stage` — see the project `PROJECT_AGENT.md` § "Draft gate".

`--label` defaults to the truncated prompt (≤30 chars) if omitted. Pass
`--ref-source-id <id>` once per `image_result` / `video_result` source
node you want as a byte ref — the CLI resolves each source's
`local_path`, hands the tunnel URL to PAI's `video-generation-assets`
endpoint, and emits one `derived` edge per ref. Pass
`--ref-audio-source-id <audio_id>` once per canvas `audio_result` node
you want as an audio ref (same wiring; separate flag so the CLI can
partition by type without reading the workflow). External URLs (a
pasted CDN link, a still you want as a ref) must be mirrored onto the
canvas first via `mirror_url.js --url <URL>` — the returned
`node_id` plugs into `--ref-source-id` like any other canvas source.
When a canvas note authored the clip (most commonly a shot note being
rendered), pass `--source-node-id <note_id>` — see the project `PROJECT_AGENT.md` §
"Asset, ref, and edge rules". Don't set `--shot-id` unless the user asked for a
specific reel position; the Timeline UI owns shot_id assignment.

Each clip costs real money even after staging — only stage after the user has explicitly asked for a video.

## Reference caps (video-generation)

≤9 image refs, ≤3 audio refs, ≤3 video refs. Each audio / video ref must be **1.8s–15.2s per file**. **Video refs additionally cap at 15s aggregate** (sum across the ≤3 video refs); audio has no aggregate cap. Audio refs need an image or video anchor — they can't be the only reference. Don't preflight — submit and read `limits` + `sent` on failure. Audio / video duration is on canvas — read `audio_result.data.metadata.duration_sec` and `video_result.data.duration` from `workflow.json`. Never ffprobe canvas-local files (and ffprobe may not be installed).

## Reference roles — vocabulary

The same CLI flag can serve different semantic roles depending on how the prompt names the ref. Choose the role first; the prompt phrasing binds it.

| Role | Flag | Wording in prompt |
|---|---|---|
| Character identity | `--ref-source-id` (image) | "the character in @Image1" |
| Location / setting | `--ref-source-id` (image) | "the location shown in @Image1" |
| Opening frame | `--ref-source-id` (image) | "opening frame @Image1, …" |
| Closing frame | `--ref-source-id` (image) | "closing on the frame from @Image1" |
| Source clip — continue | `--ref-source-id` (video) | "Continue from @Video1 — start after its final frame, no frames from @Video1 in the new clip" |
| Source clip — transform | `--ref-source-id` (video) | "Re-render @Video1 in …" |
| Camera-move source | `--ref-source-id` (video) | "camera moves match @Video1" |
| Action source | `--ref-source-id` (video) | "action choreography matches @Video1" |
| VFX template | `--ref-source-id` (video) | "use the visual-effects template from @Video1" |
| Spoken audio / voice | `--ref-audio-source-id` | "Use @Audio1 for timing, cadence, and voice." |

## Prompt-language conventions

- Reference syntax: `@Image1` / `@Video1` / `@Audio1`, positional, in `--ref-source-id` / `--ref-audio-source-id` order (image and video refs share the `@Image…` / `@Video…` slot per their source node type).
- Spoken text rule: when a script note, shot note, user dialogue, or `audio_result.data.text` contains spoken words, include those words in the video prompt verbatim. Do not summarize, translate, shorten, polish, or invent dialogue/VO.
- Spoken source priority: use `audio_result.data.text` when present; otherwise use the exact script/shot-note dialogue. If audio text and note text disagree, ask unless the audio node is clearly the approved final read. For audio uploads without text, reference the audio but do not invent transcript text.
- Camera language is **rules, not adjectives** — *"one-take"*, *"steady follow shot"*, *"Iaijutsu draw"* not *"cinematic"*, *"fast"*, *"high-quality"*.
- Avoid conflicting instructions ("static camera" + "orbit shot").
- For brand / MV / ad work, end the prompt with a negative line: *"no captions, watermarks, distortion, stretching."*
- For polish on a single-shot clip: see [`references/video-single-shot.md`](references/video-single-shot.md).

## Patterns

Pick the one that fits. For source lookup, follow the project `PROJECT_AGENT.md` § "Choosing context"; this skill only owns video-specific prompt and CLI shape.

**Storyboard guard:** if a source image has `data.subtype === "storyboard"`, or legacy label/prompt evidence clearly marks it as a storyboard mosaic, route to Pattern 7 / `references/video-multi-shot.md` before generic I2V. Never describe a storyboard mosaic as `Opening frame @Image1`; it is a panel sequence, not a single starting frame.

### 1. Standalone T2V

**Triggers:** a fresh clip unrelated to canvas content ("a noir alley at dawn, slow dolly-in", "a runner in a stadium, 10 seconds").
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..."` with sensible defaults (15s, 16:9, 720p, audio on). Add `--resolution 480p` or `--resolution 1080p` only if the chosen video mode requires it.
**Edges:** none.
**For the bracket scaffold and slot-by-slot construction when the user wants polish:** see [`references/video-single-shot.md`](references/video-single-shot.md).

### 2. Animate a canvas image (I2V)

**Triggers:** "animate this", "make a video of this image", "put motion on this still" — applied to a specific canvas `image_result` (character, location, or otherwise).
**Source:** the named `image_result` node — just `id`; excludes storyboard mosaics, which route through the Storyboard guard above.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <image.id>`.
**Edges:** `{ from: <source.id>, to: video_<N>, kind: "derived" }` — emitted by the CLI.
**Anchor sub-variants:** opening-frame (default — *"opening frame @Image1, …"*) and closing-frame (*"closing on the frame from @Image1"*) — both pass the image as `--ref-source-id`; the anchor direction lives in the prompt wording, since the upstream model exposes no separate last-frame param.
**For slot-by-slot construction and the opening- vs closing-frame phrasing:** see [`references/video-single-shot.md`](references/video-single-shot.md).

### 3. Compose with canvas characters / locations

**Triggers:** "a video of [character]", "put [character] in [setting]", "[character] does [action]" — when at least one canvas character or location is involved.
**Source:** character / location `image_result` nodes (cap from §Reference caps).
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <char1.id> --ref-source-id <char2.id> ...`.
**Edges:** `{ from: <char.id>, to: video_<N>, kind: "derived" }` — one per `--ref-source-id`.
**For single-shot composition and adjacent-role wording:** see [`references/video-single-shot.md`](references/video-single-shot.md). **For ≥2 internal shots in one render:** see [`references/video-multi-shot.md`](references/video-multi-shot.md).

### 4. Extend a canvas clip

**Triggers:** "continue from this", "extend this clip by Ns", "what happens after", "scene 2 follows scene 1" — applied to an existing canvas `video_result`.
**Source:** any canvas `video_result` node — agent-generated *or* user-uploaded (`data.metadata.source` is `"pai"` for generated and `"user_upload"` for dropped).
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <source_video.id>`.
**Edges:** `{ from: <source_video.id>, to: video_<N>, kind: "derived" }`.
**For the continuity prefix, sub-intent decision tree, and sequencing across multiple linked calls:** see [`references/video-extension.md`](references/video-extension.md).

### 5. Edit a canvas clip

**Triggers:** "re-render in golden hour", "restyle as anime", "add rain", "remove the passerby", "swap the product", "change the wardrobe color", "rewrite what happens" — applied to an existing canvas `video_result`. Creative edits go through `generate_video.js`, not local `ffmpeg` (which is reserved for mechanical ops).
**Source:** any canvas `video_result` node — agent-generated *or* user-uploaded.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <source_video.id>`.
**Edges:** `{ from: <source_video.id>, to: video_<N>, kind: "derived" }`.
**For the Restyle / Partial / Replace / Re-plot decision tree and per-mode templates:** see [`references/video-editing.md`](references/video-editing.md).

### 6. Voice-driven clip

**Triggers:** "have [character] say this", "make a video where [character] says / narrates …", "use [character]'s voice in this clip".
**Source:** any canvas `audio_result` node — agent-generated or user-uploaded.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-audio-source-id <audio_id>`. Often combined with character image refs for face + voice — pass both `--ref-source-id <character_id>` (for the character image) and `--ref-audio-source-id <audio_id>` (for the voice).
**Prompt — inline this iteration:**
- If the audio node contains speech (`audio_result.data.text`), include that exact text in the video prompt and bind `@Audio1` to timing/cadence/voice.
- For off-screen narration: *`V.O. says exactly: "..." Use @Audio1 for narration timing, cadence, and voice. Visuals should pace to the narration. Do not render captions or on-screen transcript text.`*
- For on-screen dialogue with a character image: *`The character in @Image1 says exactly: "...". Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`*
- If there is no audio node yet and the user wants the video model to generate speech directly, preserve the requested dialogue verbatim in the prompt as `[Character] says exactly: "..."`; prefer routing to `voice-compose` first when exact VO/dialogue matters.
- For audio uploads without `data.text`, reference the audio for sound/timing but do not invent transcript text.
- Never treat an image as the speech source; images can identify the speaker, but the spoken words come from the audio node, script/shot note, or user-provided dialogue.

**Edges:** depends on which character refs attach (one `kind: "derived"` per ref).

### 7. Multi-shot / brand / ad / MV

**Triggers:** ≥2 distinct shots inside one render, ad / music-video / brand framing, durations ≥10s with multiple movements.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." [--ref-source-id <image|video.id> ...] [--ref-audio-source-id <audio.id> ...]`.
**Edges:** as per the underlying pattern (3, 4, 5) for any refs attached.
**For the 4-section scaffold (timeline / effects inventory / density map / energy arc) and how to populate the timeline from canvas script shot notes or storyboard mosaic panels:** see [`references/video-multi-shot.md`](references/video-multi-shot.md).

## Common combinations

Cross-pattern asks. Each combo routes to one primary reference — references don't link to each other.

| Combo | Primary reference | Extra refs to attach |
|---|---|---|
| Character + voice-over | (Pattern 6 inline) | character image |
| Music video with characters | `video-multi-shot.md` | character images + audio (Pattern 6 wording) |
| Restyle preserving identity | `video-editing.md` (Restyle) | source video + character image |
| Multi-clip chained sequence | `video-extension.md` | source video for each link |
| Compose with camera-move from reference | `video-single-shot.md` | character images + camera-move video ref |
| Render one script shot from canvas | Pattern 1, 2, or 3 by shot content (no dispatch — translate the shot note body to slot rules) | character / location refs if the shot involves them |
| Render a continuous script span (>15s total) as a dependent sequence | `video-extension.md` (script-driven chain) | source video only for dependent links; character refs for identity continuity |
| Render a short script (≤15s total) as one piece | `video-multi-shot.md` (cross-skill source) | character image refs locked across shots |
| Render a storyboard mosaic as one 15s video (every panel becomes a shot block) | `video-multi-shot.md` (storyboard cross-skill source; required for `image_result.subtype === "storyboard"`) | mosaic image + character / location image refs that authored the mosaic |

## After the CLI returns

For draft-stage JSON, one sentence with the price/status — see the project `PROJECT_AGENT.md` § "Draft gate". For terminal results, follow the project manual's next-step recommendation rule. `--ref-source-id` flags drive provenance edges; they're captured in the draft argv and materialize on the real `video_result` after the user fires.

## On failure

Shape and class taxonomy: see the project `PROJECT_AGENT.md` § "Failure handling". Video-specific:

- `asset_rejected` with *"DownloadFailed"* — `failed_url` was unreachable; swap.
- `asset_rejected` with *"DurationTooLong"* / *"DurationTooShort"* — `failed_url`'s duration is outside 1.8s–15.2s. Swap it or trim with ffmpeg.
- `bad_args` with *"reference_audio cannot be the only reference input"* — add an image or video ref alongside the audio.
- `generation_failed` with *"invalid video duration, exceeds 15s"* — sum of `sent.video_urls` durations breached `limits.max_total_video_sec`. Read each video_result's `data.duration` from canvas (or ffprobe external URLs) and drop refs until the sum is ≤15s.
- `generation_failed` (other) — upstream non-policy failure. Paraphrase and ask.

**Never auto-retry.** Each call is real money.
