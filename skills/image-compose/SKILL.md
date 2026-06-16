---
name: image-compose
description: >-
  Generates/edits filmmaking canvas images via generate_image.js and
  generate_image_pro.js. Use before image CLIs for character/location design,
  refs, starting frames, storyboards, stills, edits, variations, and downstream
  video anchors. Video-bound characters default to Pattern 7 4-panel sheets;
  one-off static portraits use Pattern 1. Story/script breakdowns should create
  detailed location anchors plus material character/location variants. Storyboards
  use Pattern 6: one pro composite mosaic per clip/<=15s shot note.
---

## CLI shape

Standard tier:

```
node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." [--aspect-ratio 16:9] [--image-size 2K] [--label "..."] [--subtype <character|location|edit|reference|split|storyboard>] [--name "..."] [--role "..."] [--description "..."] [--source-node-id <id>] [--ref-source-id <id> ...]
```

Pro tier for storyboard mosaics and video-bound character sheets:

```
node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --prompt "..." --size 2560x1440 [--label "..."] [--subtype <character|location|edit|reference|split|storyboard>] [--name "..."] [--role "..."] [--description "..."] [--source-node-id <id>] [--ref-source-id <id> ...]
```

Pro accepts `--size` only; no `--aspect-ratio` / `--image-size`. Common sizes: `1024x1024`, `1280x720`, `720x1280`, `1920x1920`, `2560x1440`, `1440x2560`, `3840x2160`, `2160x3840`.

`--label` defaults to the truncated prompt (≤30 chars) if omitted; pass an explicit one when you have a better caption.

Use `@Image1`, `@Image2`, … in `--ref-source-id` order. The CLI emits one `derived` edge per ref.

Mirror external URLs first with `mirror_url.js --url <URL>`, then pass the returned `node_id` via `--ref-source-id`.

If a note authored the image, pass `--source-node-id <note_id>`.

Do not attempt to invent images via ASCII art or markdown embedding — call the CLI.

## First-use image mode

For the ask-once flow and per-mode prices, see the project `PROJECT_AGENT.md` § "First-use generation choices".

Mode mapping: `Standard 2K` -> `generate_image.js --image-size 2K`; `Pro 2K` -> pro exact 2K; `Max quality` -> pro exact 4K.

## Patterns

Pick the one that fits. For source lookup, follow the project `PROJECT_AGENT.md` § "Choosing context"; this skill only owns image-specific prompt and CLI shape.

**Character pre-flight.** First ask: will this character appear in downstream video (video, clip, promo, 宣传片, 短片, 连续剧, film, scene, 拍片, shot, short film)?

1. Read `workflow.json` for uploaded refs (`subtype:"reference"`, `metadata.source:"user_upload"`, not archived).
2. Video-bound -> Pattern 7, not Pattern 1. Use ≥3 actor refs when available; with 0-2 refs, generate text-only 4-panel sheet.
3. Announce one line before firing; allow redirect to Pattern 1.
4. One-off static art/poster/portrait -> Pattern 1.

**Story/script anchor defaults.** When `script-compose` or `story-to-video-workflow` routes a breakdown here:

- One base 4-panel sheet per material character.
- Extra sheets for material character variants: age, wardrobe/uniform/disguise, injury/dirty/wet/bloodied state, transformation, or continuity-significant looks.
- Detailed location anchors for settings that affect shots.
- Same-location variants for framing/scale/time/weather/light/dressing/story state/close-detail coverage changes.
- Prefer reference-to-clip after anchors. Storyboard only if requested, hard to control, or needed for diagnosis.
- Do not drop material variants for budget/speed; caller should adjust video resolution/runtime first.

### 1. Character portrait (one-off static stills only)

Triggers: character portrait/headshot/hero/villain/lead **only** for one-off static stills. Video-bound -> Pattern 7.

- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio 9:16 --image-size 2K --subtype character --name "Detective Morris" --role "..." --description "..."` — **no refs**. A character is an identity anchor, not a derivative.
- Prompt template:
  > `[style] character portrait of [NAME], [role]. [age, build, wardrobe, distinguishing features]. Front-facing medium close-up, eye-level, looking directly at camera, neutral expression. Plain neutral background, soft even lighting. No dramatic shadows, no stylized lighting, no side profile, no multiple views.`
- Inherit project style or default to realistic. Name unnamed characters.
- No edges — characters are roots, so no `--ref-source-id`.

### 2. Location establishing still

Triggers: establish/design/picture a location, or approval of a `script-compose` location offer.

- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio 16:9 --image-size 2K --subtype location --name "Causeway" --description "..." [--source-node-id <script_or_shot_note_id>]` — **no refs**. A location is a setting anchor, not a derivative.
- Prompt template:
  > `[style] establishing still of [LOCATION NAME]. [visual brief — architecture, lighting, atmosphere]. Wide shot, eye-level, no characters present.`
- Keep frame empty of characters. Include architecture/layout, surfaces, dressing, era, weather, time, light, and story state when relevant.
- Same-location variants preserve place identity while changing wide/close scale, day/night, weather, dressing, damage, or detail coverage.
- No ref edges by default. If the location was derived from a script or shot note, use `--source-node-id` so the authorship edge lands.
- *Follow-on:* after the last scripted location, recommend the next reference-to-clip render. Mention storyboard only if requested/needed.

### 3. Edit / variation / turnaround of an existing image

Triggers: change/edit/swap/replace/add/remove/tweak/what-if/variation on an existing image.

- Identify the source node (usually the most recent `image_result`, or one the user named). Grab `source.id` and `source.metadata.aspect_ratio`.
- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio <source ratio> --image-size <source size or 2K> --subtype edit --source-node-id <source.id> --ref-source-id <source.id>`.
- Prompt as a **transformation**, not a full re-description:
  > `<concrete change>. Preserve everything else.`

- The CLI emits the derived edge from `<source.id>` based on `--ref-source-id`.
- Multi-step chains use one edge/call per step; do not flatten A -> C.

### 4. Scene featuring existing characters

Triggers: put character in setting / shot of X and Y / character action in location.

- Identify each character involved — any `image_result` of that person (up to 16). Collect each one's `id`.
- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio <fit the shot> --image-size 2K --ref-source-id <char1.id> --ref-source-id <char2.id> ...`.
- Prompt: the full scene description. Name each character by their role so the generator binds identity to role. Refer to them in the prompt as `@Image1`, `@Image2`, … in `--ref-source-id` order.
- **No `--subtype`** — a scene is neither a character nor an edit. CLI emits one derived edge per `--ref-source-id`.

### 5. Standalone still

Triggers: a fresh image unrelated to existing canvas content ("generate a mountain at dusk", "a noir alley — just the setting").

- Plain `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..."` with sensible defaults (16:9, 2K unless the user asks otherwise). No subtype, no refs.

### 6. Storyboard mosaic — one composite per clip / shot note

Triggers: storyboard, mosaic, grid, shot list, coverage, keyframe sheet, shot planning, image previs. Output is ONE composite per clip/<=15s shot note, not one image per panel.

- **Tool/call**: one `generate_image_pro.js --size 2560x1440 --subtype storyboard --label "Storyboard — Shot <N>" --source-node-id <shot_note_id>` per mosaic.
- **Size**: default `2560x1440`; grid shape is cell layout, not canvas shape. Override only for explicit portrait/square/vertical/ratio:
  - "2x2 storyboard" → `2560x1440` (default)
  - "2x2 square storyboard" → `1920x1920`
  - "2x2 portrait storyboard" → `1440x2560`
  - "vertical 2x4 mosaic" → `1440x2560`
- **Grid/refs**: default 2×2. Pass relevant character/location refs (≤32). Warn before 3×3+; recommend smaller sheets.

**For the canvas pre-flight, per-shot-note iteration logic, missing-anchor nudge, verbatim prompt template, and default panel coverage when no script slice exists**: see [references/storyboard-mosaic.md](references/storyboard-mosaic.md).

#### Node fields the CLI sets

- ONE `image_result` node PER mosaic.
- Set `data.subtype = "storyboard"` by passing `--subtype storyboard`.

### 7. Character reference sheet *(default for ANY video-bound character work — with or without actor refs)*

Use proactively for any character that will appear in downstream video, regardless of actor refs.

**Mode A — ≥3 uploaded actor refs.** Pass photos as `--ref-source-id`; add `--source-node-id <note_id>` if a script/shot authored the design.

**Mode B — 0-2 refs / from scratch.** Omit actor refs; describe age/build/wardrobe/distinguishing features explicitly. Add `--source-node-id <note_id>` when authored by a note.

Also fires on explicit asks: "design a character sheet / turnaround / reference sheet / character design for [character]", "make a 4-panel character design", "generate a production reference sheet for downstream video work".

Output: one Front-full / Profile-full / Back-full / Closeup-bust sheet, passed directly to video as `--ref-source-id`.

- Pre-flight: identify uploaded reference nodes (`subtype:"reference"`, ideally ≥3 photos). Confirm ref count in one line.
- `node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --prompt "..." --size 2560x1440 --subtype character --name "<character_name>" --role "..." --ref-source-id <ref1> --ref-source-id <ref2> --ref-source-id <ref3> [--source-node-id <script_or_shot_note_id>]` — pro tier is the default for character sheets because panel layout, text suppression, and identity consistency are load-bearing. Do not pass `--aspect-ratio` or `--image-size`. Never fire Mode A with fewer than 3 refs (model overfits to the one angle it has).
- With 0-2 actor refs, use the Mode B text-only command from `references/character-sheet.md`: same pro command, but omit every actor-photo `--ref-source-id`; include `--source-node-id` only when a script or shot note authored the design.
- One call/sheet per base character or material variant. Generate base before variants. For identity-preserving variants, pass base sheet as ref and describe only persistent wardrobe/state change.
- Use the sheet as `--ref-source-id <sheet_id>` for downstream shots; no normal cropping needed.

**For the verbatim 4-panel prompt template, optional per-angle crops, and gotchas (no-text rule, photo-priority, exact panel counts)**: see [references/character-sheet.md](references/character-sheet.md).

#### Node fields the CLI sets

- ONE `image_result` node with `data.subtype = "character"`.
- `data.name`, `data.role`, `data.description` from the CLI flags.
- One `derived` edge per `--ref-source-id` (so the sheet is provenance-linked to each actor photo it triangulated from).

## After the CLI returns

For draft-stage JSON, one sentence with the price/status — see the project `PROJECT_AGENT.md` § "Draft gate". For terminal results, follow the project manual's next-step recommendation rule.
