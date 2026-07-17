---
name: video-compose
description: Generates and prompts video clips on the filmmaking canvas. Use when the user asks to generate, render, animate, continue, restyle, edit, shoot, or compose a video clip; render script or shot notes as video; animate a storyboard, starting frame, image, character, location, or reference; use image, video, audio, storyboard, starting-frame, or voice refs; compose an ad, brand film, product promo, music-video shot, or video sequence; or before calling generate_video.js. Owns video CLI flags, refs, prompt construction, audio-ref handling, and video-specific failure hints.
---

Intent dispatcher. Patterns name trigger, call, edges, and prompt reference.

## Hard defaults

- Stage by default per `PROJECT_AGENT.md`.
- Audio on by default; pass `--no-audio` only for explicit silent/no-audio requests. Trailer/portrait/cinematic framing is NOT a trigger; audio is the baseline, not optional polish.
- Reference-to-clip default: use available character/variant/location/voice refs directly. Storyboard only if requested, hard to control, or needed for diagnosis.
- Preserve scripted dialogue/VO exactly unless the user asks for rewrite.

## First-use video mode

For the ask-once flow and per-mode prices, see the project `PROJECT_AGENT.md` § "First-use generation choices". Pass `--resolution` only for `480p Draft` or `1080p Final`.

## CLI shape

```
node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." [--duration <seconds>] [--aspect-ratio 16:9]
  [--resolution <480p|1080p>] [--no-audio]
  [--label "..."] [--ref-source-id <id> ...] [--ref-audio-source-id <audio_id> ...]
  [--source-node-id <id>] [--shot-id <N>]
```

Calls go via `--stage` — see the project `PROJECT_AGENT.md` § "Draft gate".

`--label` defaults to truncated prompt. Use `--ref-source-id` for image/video refs, `--ref-audio-source-id` for audio refs, and `--source-node-id` for the authoring note. Mirror external URLs first. Do not set `--shot-id` during speculative/partial generation unless user asks for a reel position; story sequences assign Timeline order after planned clips land.

Match stated single-clip duration with `--duration`; omit for 15s default. Split or chain >15s totals.

Each clip costs real money even after staging — only stage after the user has explicitly asked for a video.

## Reference caps (video-generation)

≤9 image refs, ≤3 audio refs, ≤3 video refs. Audio/video refs must be **1.8s-15.2s each**; video refs also cap at **15s aggregate**. Audio refs need image/video anchor. Read durations from `workflow.json`; on failure, use returned `limits` + `sent`.

## Reference roles — vocabulary

Prompt wording binds each ref role:

| Role | Flag | Wording in prompt |
|---|---|---|
| Character identity | `--ref-source-id` (image) | "the character in @Image1" |
| Location / setting | `--ref-source-id` (image) | "the location shown in @Image1" |
| Opening frame | `--ref-source-id` (image) | "opening frame @Image1, …" |
| Closing frame | `--ref-source-id` (image) | "closing on the frame from @Image1" |
| Source clip — continue (next clip in a chain) | `--ref-source-id` (video) | **Default = hard cut:** "Hard cut from @Video1: open on a NEW camera angle; do not match its final frame." Same-shot ("Continue from @Video1 … maintain camera position") only for an authored held beat / oner / explicit user request — see [`references/video-extension.md`](references/video-extension.md) |
| Source clip — transform | `--ref-source-id` (video) | "Re-render @Video1 in …" |
| Camera-move source | `--ref-source-id` (video) | "camera moves match @Video1" |
| Action source | `--ref-source-id` (video) | "action choreography matches @Video1" |
| VFX template | `--ref-source-id` (video) | "use the visual-effects template from @Video1" |
| Voice / timbre anchor | `--ref-audio-source-id` | "Use @Audio1 as voice/timbre reference. Speak once, no echo." |

## Prompt-language conventions

- Ref syntax: `@Image1` / `@Video1` / `@Audio1`, positional by flag order. Every `@ImageN`/`@VideoN`/`@AudioN` MUST have a matching `--ref-source-id`/`--ref-audio-source-id` flag — the CLI rejects a mismatch (`bad_args`) before generating. Mentioning the same ref many times is fine; only the highest index per kind needs a flag.
- Spoken text: include script/shot/user dialogue/VO verbatim; do not summarize, translate, shorten, polish, or invent.
- Dialogue scenes: keep the shot/script dialogue in the prompt; use one approved voice sample per speaker as a timbre anchor. Bind each quoted line to the intended character and the matching `@AudioN` reference. Do not generate per-line audio refs unless the user explicitly wants separate final audio.
- Final audio exception: if an audio node is the approved narration/line read, use `audio_result.data.text` verbatim. If it is just a character voice sample, do not replace the shot dialogue with the sample text.
- Add dialogue guards for model-spoken lines: *"each line spoken exactly once, no echo, no repeated reads."* Add phonetic spelling for names or words likely to slur.
- One camera move, one action speed, concrete sound/music (`No Music` if none). Use exact terms: `locked off`, `handheld, subtle`, `slow dolly in`, `slow orbit`, `whip pan`, `speed ramp`.
- Avoid conflicts ("static camera" + "orbit shot").
- For brand / MV / ad work, end the prompt with a negative line: *"no captions, watermarks, distortion, stretching."*
- For polish on a single-shot clip: see [`references/video-single-shot.md`](references/video-single-shot.md).

## Patterns

Pick the one that fits. Source lookup follows `PROJECT_AGENT.md`.

**Storyboard guard:** storyboard images route to Pattern 7 / `references/video-multi-shot.md`, never generic I2V/opening-frame wording.

### 1. Standalone T2V

**Triggers:** fresh clip unrelated to canvas content.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..."`; omitted flags default to 15s, 16:9, 720p, audio on. Add `--resolution 480p` or `--resolution 1080p` only if the chosen video mode requires it.
**Edges:** none.
**For the bracket scaffold and slot-by-slot construction when the user wants polish:** see [`references/video-single-shot.md`](references/video-single-shot.md).

### 2. Animate a canvas image (I2V)

**Triggers:** animate/make video/put motion on a specific canvas `image_result`.
**Source:** named `image_result`; storyboard mosaics route through Storyboard guard.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <image.id>`.
**Edges:** `{ from: <source.id>, to: video_<N>, kind: "derived" }` — emitted by the CLI.
**Anchor wording:** opening-frame default (`opening frame @Image1`) or closing-frame (`closing on the frame from @Image1`); both use `--ref-source-id`.
**For slot-by-slot construction and the opening- vs closing-frame phrasing:** see [`references/video-single-shot.md`](references/video-single-shot.md).

### 3. Compose with canvas characters / locations

**Triggers:** video of character, character in setting, character action in location.
**Source:** character / location `image_result` nodes (cap from §Reference caps).
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <char1.id> --ref-source-id <char2.id> ...`.
**Edges:** `{ from: <char.id>, to: video_<N>, kind: "derived" }` — one per `--ref-source-id`.
- Prefer exact shot refs: current wardrobe/state character sheet, detailed location, same-location variant.
**For single-shot composition and adjacent-role wording:** see [`references/video-single-shot.md`](references/video-single-shot.md). **For ≥2 internal shots in one render:** see [`references/video-multi-shot.md`](references/video-multi-shot.md).

### 4. Extend a canvas clip

**Triggers:** continue/extend/what happens after/scene follows existing `video_result`.
**Source:** any canvas `video_result` node — agent-generated *or* user-uploaded (`data.metadata.source` is `"pai"` for generated and `"user_upload"` for dropped).
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <source_video.id>`.
**Edges:** `{ from: <source_video.id>, to: video_<N>, kind: "derived" }`.
**Boundary defaults to a HARD CUT** (clip 2 opens on a new angle — this avoids the same-shot seam morph). If the whole sequence fits ≤15s, render ONE multi-shot clip (Pattern 7) instead of chaining. Same-shot continuation is the exception (authored held beat / story-required oner / explicit user request).
**For the hard-cut + same-shot prefixes, the ≤15s guard, the sub-intent decision tree, and sequencing across linked calls:** see [`references/video-extension.md`](references/video-extension.md).

### 5. Edit a canvas clip

**Triggers:** re-render/restyle/add/remove/swap/change/rewrite existing `video_result`. Creative edits use `generate_video.js`; ffmpeg is for mechanical ops.
**Source:** any canvas `video_result` node — agent-generated *or* user-uploaded.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-source-id <source_video.id>`.
**Edges:** `{ from: <source_video.id>, to: video_<N>, kind: "derived" }`.
**For the Restyle / Partial / Replace / Re-plot decision tree and per-mode templates:** see [`references/video-editing.md`](references/video-editing.md).

### 6. Voice-driven clip

**Triggers:** have character say/narrate, use character voice.
**Source:** any canvas `audio_result` node — agent-generated or user-uploaded.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." --ref-audio-source-id <audio_id>`. Often combined with character image refs for face + voice — pass both `--ref-source-id <character_id>` (for the character image) and `--ref-audio-source-id <audio_id>` (for the voice).
**Prompt:**
- Character voice sample: *`The character in @Image1 says exactly: "...". Use @Audio1 as the voice/timbre reference only. Speak the quoted line exactly once, no echo, no repeated reads.`*
- Multiple speakers: bind each visual ref and audio ref explicitly, e.g. *`The character in @Image1 uses @Audio1 and says exactly: "..."; the character in @Image2 uses @Audio2 and replies exactly: "...". Each line is spoken exactly once, no echo, no repeated reads.`*
- Approved final narration/line read: use `audio_result.data.text` exactly and bind it with *`Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`*
- No audio node: preserve requested dialogue verbatim as `[Character] says exactly: "..."`; add the once/no-echo guard and phonetic spellings for risky words.
- Audio uploads without `data.text`: sound/timing only; do not invent transcript.
- Images identify speakers; spoken words come from audio text, script/shot note, or user dialogue.

**Edges:** depends on which character refs attach (one `kind: "derived"` per ref).

### 7. Multi-shot / brand / ad / MV

**Triggers:** ≥2 shots inside one render, ad/MV/brand framing, or ≥10s with multiple movements.
**Call:** `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "..." [--ref-source-id <image|video.id> ...] [--ref-audio-source-id <audio.id> ...]`.
**Edges:** as per the underlying pattern (3, 4, 5) for any refs attached.
**For the 4-section scaffold (timeline / effects inventory / density map / energy arc) and how to populate the timeline from canvas script shot notes or storyboard mosaic panels:** see [`references/video-multi-shot.md`](references/video-multi-shot.md).

## Common combinations

Cross-pattern asks route to one primary reference:

| Combo | Primary reference | Extra refs to attach |
|---|---|---|
| Character + voice-over | (Pattern 6 inline) | character image |
| Music video with characters | `video-multi-shot.md` | character images + audio (Pattern 6 wording) |
| Restyle preserving identity | `video-editing.md` (Restyle) | source video + character image |
| Multi-clip chained sequence | `video-extension.md` | source video for each link |
| Compose with camera-move from reference | `video-single-shot.md` | character images + camera-move video ref |
| Render one script shot from canvas | Pattern 1, 2, or 3 by shot content (no dispatch — translate the shot note body to slot rules; preserve dialogue/VO verbatim) | character / variant refs + location / variant refs + voice anchors if the shot involves them |
| Render a continuous script span (>15s total) as a dependent sequence | `video-extension.md` (script-driven chain; **hard-cut handoffs by default** — keep a link same-shot only for an unbroken oner the viewer must read as one motion) | source video per link + **character refs (mandatory under hard cut)** for identity |
| Render a short script (≤15s total) as one piece | `video-multi-shot.md` (cross-skill source) | character image refs locked across shots |
| Render a storyboard mosaic as one 15s video (every panel becomes a shot block) | `video-multi-shot.md` (storyboard cross-skill source; required for `image_result.subtype === "storyboard"`) | mosaic image + character / location image refs that authored the mosaic |

## Sequence dispatch guidance

For multiple clips, prefer hybrid dispatch: independent for separate scenes/time jumps/wardrobe-state changes/montage; chain only same continuous action/location/lighting/wardrobe-state/emotional beat. Do not chain across breaks where continuity is undesirable.

If a budget-aware caller needs savings, lower video resolution before shortening runtime. Do not suggest dropping material character variants, location variants, or voice anchors that preserve continuity.

## After the CLI returns

For draft-stage JSON, one sentence with the price/status — see the project `PROJECT_AGENT.md` § "Draft gate". For terminal results, run the alignment check (frames via `extract_frames.js`) before the next-step recommendation — see the project `PROJECT_AGENT.md` § "Prompt alignment check". `--ref-source-id` flags drive provenance edges; they're captured in the draft argv and materialize on the real `video_result` after the user fires.

## Failure hints

Video-specific message hints:

- `asset_rejected` with *"DownloadFailed"* — `failed_url` was unreachable; swap.
- `asset_rejected` with *"DurationTooLong"* / *"DurationTooShort"* — `failed_url`'s duration is outside 1.8s–15.2s. Swap it or trim with ffmpeg.
- `bad_args` with *"reference_audio cannot be the only reference input"* — add an image or video ref alongside the audio.
- `bad_args` with *"invalid video duration, exceeds 15s"* — sum of video refs breached `limits.max_total_video_sec`. Read each `video_result.data.duration` from canvas and drop refs until the sum is ≤15s.
