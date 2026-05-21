---
name: image-compose
description: Generates or edits images on the filmmaking canvas via the local generate_image.js CLI, following the canvas-aware conventions for subtype stamping, reference wiring, and provenance edges. Use when the user asks to design a character, portrait, hero, or villain; design an establishing still of a script location or setting; edit, change, swap, add, or remove something in an existing canvas image; make a variation, turnaround, 3D version, or alternate-style version of an image; compose a scene featuring one or more existing characters; generate a standalone still unrelated to existing canvas content; or lay out a storyboard mosaic, shot list, keyframe sheet, or image previs from a script's shots and locations. STORYBOARD SHAPE — storyboard / mosaic / 分镜 / shot list / keyframe sheet / coverage / previs = ONE composite image with N×M panels per location, NOT N separate calls. Re-invoke this skill (Pattern 6) before firing the CLI.
---

## CLI shape

All patterns below shell out to:

```
node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." [--aspect-ratio 16:9] [--image-size 2K] [--label "..."] [--subtype <character|location|edit|reference|split>] [--name "..."] [--role "..."] [--description "..."] [--source-node-id <id>] [--ref-source-id <id> ...]
```

`$PAI_REPO_ROOT` is exported by the viewer — see CLAUDE.md § "Media CLIs / Invocation path".

Calls go via `--stage` — see CLAUDE.md § "Draft gate". **Pass `run_in_background: true` on the Bash call and poll with BashOutput** — the PreToolUse hook blocks foreground attempts (each parallel-staged variant needs the flag too).

`--label` defaults to the truncated prompt (≤30 chars) if omitted; pass an explicit one when you have a better caption.

When references are passed, refer to them in the prompt positionally as `@Image1`, `@Image2`, … in `--ref-source-id` order. The CLI emits one `derived` edge per `--ref-source-id`.

External URLs (a pasted CDN link, a moodboard image) must be mirrored onto the canvas first via `mirror_url.js --url <URL>` — the returned `node_id` then plugs into `--ref-source-id` like any other canvas source. There is no separate URL-passthrough flag.

If a canvas note authored this image (a shot note rendered as a still, a script note designing a character / location), pass `--source-node-id <note_id>` — see CLAUDE.md § "Authorship edges".

Do not attempt to invent images via ASCII art or markdown embedding — call the CLI.

## Patterns

Pick the one that fits. When unsure, read `./workflow.json` first to see what's already on the canvas (reads are unrestricted; only writes go through the mutator).

### 1. Character portrait

Triggers: "design / create / introduce / cast a character / protagonist / antagonist / hero / villain / lead / portrait / headshot".

- `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." --aspect-ratio 9:16 --image-size 2K --subtype character --name "Detective Morris" --role "..." --description "..."` — **no refs**. A character is an identity anchor, not a derivative.
- Prompt template:
  > `[style] character portrait of [NAME], [role]. [age, build, wardrobe, distinguishing features]. Front-facing medium close-up, eye-level, looking directly at camera, neutral expression. Plain neutral background, soft even lighting. No dramatic shadows, no stylized lighting, no side profile, no multiple views.`
- Inherit the project's style if one is already established on the canvas; otherwise default to realistic. Name the character if the user didn't ("Detective Morris", "The Prospector").
- No edges — characters are roots, so no `--ref-source-id`.

### 2. Location establishing still

Triggers: "establish / design / picture [LOCATION]", or "yes" to a `script-compose` parse offer listing locations.

- `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." --aspect-ratio 16:9 --image-size 2K --subtype location --name "Causeway" --description "..."` — **no refs**. A location is a setting anchor, not a derivative.
- Prompt template:
  > `[style] establishing still of [LOCATION NAME]. [visual brief — architecture, lighting, atmosphere]. Wide shot, eye-level, no characters present.`
- Keep the frame empty of characters — locations are reusable references for later scenes. Inherit project style if one exists.
- No edges — locations are roots.
- *Follow-on:* once you've designed **every** location identified by a `script-compose` parse offer (i.e. the last location in the run), offer the user one short line: "Locations are up — want me to lay out a storyboard per location?" Bridges into Pattern 6. Skip if locations were designed ad-hoc, not from a script offer.

### 3. Edit / variation / turnaround of an existing image

Triggers: "change / edit / swap / replace / add / remove / tweak / what-if", OR "make a turnaround / 3D version / alternate style / variation" — applied to an image already on the canvas.

- Identify the source node (usually the most recent `image_result`, or one the user named). Grab `source.id` and `source.metadata.aspect_ratio`.
- `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." --aspect-ratio <source ratio> --image-size <source size or 2K> --subtype edit --source-node-id <source.id> --ref-source-id <source.id>`.
- Prompt as a **transformation**, not a full re-description:
  > `<concrete change>. Preserve everything else.`

  ✅ "Change the rain to falling snow. Keep the detective, wardrobe, and camera framing unchanged."
  ✅ "Render as a full 3D turnaround sheet of the same character. Preserve face, wardrobe, and proportions."
  ❌ "A detective in a snowy alley at night wearing a trench coat…" — over-specifies, identity drifts.
- The CLI emits the derived edge from `<source.id>` based on `--ref-source-id`.
- **Multi-step chains** (A → B → C) use one edge per step. Do not flatten to a single A → C — make N separate CLI calls, each with the previous result as the new source.

### 4. Scene featuring existing characters

Triggers: "put [character] in [setting]", "a shot of [X] and [Y]", "[character] does [action] in [location]" — when at least one canvas character is involved.

- Identify each character involved — any `image_result` of that person (up to 16). Collect each one's `id`.
- `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." --aspect-ratio <fit the shot> --image-size 2K --ref-source-id <char1.id> --ref-source-id <char2.id> ...`.
- Prompt: the full scene description. Name each character by their role so the generator binds identity to role. Refer to them in the prompt as `@Image1`, `@Image2`, … in `--ref-source-id` order.
- **No `--subtype`** — a scene is neither a character nor an edit. CLI emits one derived edge per `--ref-source-id`.

### 5. Standalone still

Triggers: a fresh image unrelated to existing canvas content ("generate a mountain at dusk", "a noir alley — just the setting").

- Plain `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..."` with sensible defaults (16:9, 2K unless the user asks otherwise). No subtype, no refs.

### 6. Storyboard mosaic — one composite per location

Triggers: user asks for a storyboard, mosaic, NxN / N×M grid, shot list, coverage, keyframe sheet, shot planning, or image previs. The intent is **ONE composite image with N×M panels per location**, NOT one image per panel and NOT a video.

- **Tool**: `generate_image.js` (standard tier). Layout fidelity is best at ≤4 cells; past that, cells drift in framing and identity. Warn the user one short line before firing for any grid larger than 2×2: "Heads up — the standard image tier loses layout fidelity past ~4 cells; cells may drift in framing."
- **Single call per mosaic**: ONE `node "$PAI_REPO_ROOT/server/scripts/generate_image.js" --prompt "..." --aspect-ratio 16:9 --image-size 2K --label "Storyboard — <location>"` per mosaic. The pattern's point is one composite image per location, not N×M small generations.
- **Aspect ratio**: ALWAYS default to **`16:9`** — this is filmmaking. Each panel inside the mosaic is a 16:9 cinematic frame, and the overall sheet should also feel cinematic landscape. The grid shape (3×3, 4×2, etc.) describes cell layout, NOT canvas shape. Only override `16:9` if the user explicitly says "portrait", "square", "vertical", or names a different ratio:
  - "3x3 storyboard" → `16:9` (default)
  - "3x3 square storyboard" → `1:1`
  - "3x3 portrait storyboard" → `9:16`
  - "vertical 2x4 mosaic" → `9:16`
- **Default grid**: 2×2 unless the user specified another. Announce in chat one short line before each call ("Generating a 2×2 mosaic for <location>" or "Generating a 2×2 mosaic.") — don't paste the prompt.
- **Optional refs**: if a character / location reference is on the canvas, pass it via `--ref-source-id` (≤16) so identity stays locked across cells and the provenance edges land. The script-analyzed case (shot notes + locations on the canvas) triggers one-mosaic-per-location iteration with required ref ordering — see `references/storyboard-mosaic.md`.
- **Grid size limit**: standard-tier layout fidelity degrades fast past ~4 cells. If the user asks for `3×3` or larger, warn first: "grids past 2×2 lose layout fidelity on the standard tier — consider a smaller grid or per-panel generation."

**For the canvas pre-flight, per-location iteration logic, no-location nudge, verbatim prompt template, and default 9-panel coverage when no script slice exists**: see [references/storyboard-mosaic.md](references/storyboard-mosaic.md).

#### Node fields the CLI sets

- ONE `image_result` node PER mosaic.
- The CLI uses your `--label` ("Storyboard — <location_name>" if per-location; "Storyboard" if location-less), and stamps `metadata.task_type: "storyboard_mosaic"`, `metadata.grid: "NxM"`, `metadata.location_id` / `metadata.shot_ids` if you pass them via additional metadata flags. (Storyboard-mosaic-specific extras: pass `--ref-source-id <location_id>` and one per shot reference; the CLI emits derived edges from each.)

## After the CLI returns

One sentence with the price — see CLAUDE.md § "Draft gate".

## On failure

See CLAUDE.md § "Failure handling". `limits.max_image_refs` is 16. For `content_filtered`, propose softer wording.
