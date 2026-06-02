---
name: image-compose
description: >-
  Generates or edits images on the filmmaking canvas with generate_image.js and
  generate_image_pro.js, including subtype stamping, reference wiring,
  provenance edges, source selection, starting frames, storyboards, and visual
  anchors for downstream video. Use before calling generate_image.js or
  generate_image_pro.js; for character design, portraits, actor/character
  reference sheets, locations, hero stills, scene shots, edits, variations,
  standalone images, and storyboard or previs mosaics. For characters that may
  appear in downstream video, clip, promo, film, scene, or shot, default to
  Pattern 7, a 4-panel front/profile/back/closeup reference sheet. Use Pattern
  1 only for one-off static portraits, posters, print art, or illustrations.
  Storyboard routing: use Pattern 6 with generate_image_pro.js, one composite
  mosaic per clip or <=15s shot note, not one CLI call per panel.
---

## CLI shape

Most patterns below use the standard image tier:

```
node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." [--aspect-ratio 16:9] [--image-size 2K] [--label "..."] [--subtype <character|location|edit|reference|split|storyboard>] [--name "..."] [--role "..."] [--description "..."] [--source-node-id <id>] [--ref-source-id <id> ...]
```

Storyboard mosaics and video-bound character sheets use the pro image tier:

```
node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --prompt "..." --size 2560x1440 [--label "..."] [--subtype <character|location|edit|reference|split|storyboard>] [--name "..."] [--role "..."] [--description "..."] [--source-node-id <id>] [--ref-source-id <id> ...]
```

Pro tier accepts `--size` only. Do not pass `--aspect-ratio` or `--image-size` to `generate_image_pro.js`. Common exact sizes: `1024x1024`, `1280x720`, `720x1280`, `1920x1920`, `2560x1440`, `1440x2560`, `3840x2160`, `2160x3840`.

`$PAI_REPO_ROOT` is exported by the viewer — see the project `PROJECT_AGENT.md` § "Media CLIs (server/cli/)".

Calls go via `--stage` — see the project `PROJECT_AGENT.md` § "Draft gate". The command writes a draft job id, then waits for the user's Generate/Cancel decision and prints the terminal result as its final JSON line.

`--label` defaults to the truncated prompt (≤30 chars) if omitted; pass an explicit one when you have a better caption.

When references are passed, refer to them in the prompt positionally as `@Image1`, `@Image2`, … in `--ref-source-id` order. The CLI emits one `derived` edge per `--ref-source-id`.

External URLs (a pasted CDN link, a moodboard image) must be mirrored onto the canvas first via `mirror_url.js --url <URL>` — the returned `node_id` then plugs into `--ref-source-id` like any other canvas source. There is no separate URL-passthrough flag.

If a canvas note authored this image (a shot note rendered as a still, a script note designing a character / location), pass `--source-node-id <note_id>` — see the project `PROJECT_AGENT.md` § "Asset, ref, and edge rules".

Do not attempt to invent images via ASCII art or markdown embedding — call the CLI.

## First-use image mode

Before the first image generation in a project/session, ask once if no image mode is known: `Standard 2K ~$0.10` recommended, `Pro 2K ~$0.45`, or `Max quality ~$0.77`. Put the price in each option label. If the user skips, use `Standard 2K`.

Mapping: `Standard 2K` -> `generate_image.js --image-size 2K`; `Pro 2K` -> `generate_image_pro.js --size <2K exact>`; `Max quality` -> pro 4K exact size. Common pro sizes: 16:9 `2560x1440` / `3840x2160`, 9:16 `1440x2560` / `2160x3840`, 1:1 `1920x1920` / `2880x2880`. Pattern-required pro still wins.

## Patterns

Pick the one that fits. For source lookup, follow the project `PROJECT_AGENT.md` § "Choosing context"; this skill only owns image-specific prompt and CLI shape.

**Character-design pre-flight — ALWAYS run this check first when the user mentions characters.** The pivotal question is *will this character appear in downstream video work?* — anything the user calls a video, clip, promo, 宣传片, 短片, 连续剧, film, scene, 拍片, shot, or short film.

1. Read `./workflow.json` to see whether uploaded reference image nodes (`data.subtype = "reference"`, `data.metadata.source = "user_upload"`, not archived) exist for each character the user named.
2. If the character WILL appear in downstream video work (regardless of ref count) → **use Pattern 7 (4-panel character reference sheet)**, NOT Pattern 1. With ≥3 actor refs, Pattern 7 triangulates from the photos; with 0-2 refs, Pattern 7 still emits the 4-panel layout from a text description alone. Either way, the video model needs multi-view anchor data to keep the character recognizable across non-front shots.
3. Briefly announce the choice in chat before firing: *"Starting with a 4-panel reference sheet for [character] — locks identity across the video shots. Tell me if you want simple single portraits via Pattern 1 instead."* Give the user one beat to redirect.
4. If the character is one-off and will NOT feed video gen (a poster, print art, a standalone illustration), use Pattern 1.

This pre-flight is non-negotiable. Pattern 1's single front portrait gives the video model an anchor that's too narrow; identity drifts shot-to-shot. Skipping straight to Pattern 1 for video work is the single most-common mistake.

### 1. Character portrait (one-off static stills only)

Triggers: "design / create / introduce / cast a character / protagonist / antagonist / hero / villain / lead / portrait / headshot" **AND** the output is a one-off static still (poster, print art, single illustration) — NOT character work that will feed video gen.

If the character will appear in downstream video work, **use Pattern 7 instead** — see the pre-flight above. Do not fall through to Pattern 1 for video-bound character work, even when starting from scratch without reference photos.

- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio 9:16 --image-size 2K --subtype character --name "Detective Morris" --role "..." --description "..."` — **no refs**. A character is an identity anchor, not a derivative.
- Prompt template:
  > `[style] character portrait of [NAME], [role]. [age, build, wardrobe, distinguishing features]. Front-facing medium close-up, eye-level, looking directly at camera, neutral expression. Plain neutral background, soft even lighting. No dramatic shadows, no stylized lighting, no side profile, no multiple views.`
- Inherit the project's style if one is already established on the canvas; otherwise default to realistic. Name the character if the user didn't ("Detective Morris", "The Prospector").
- No edges — characters are roots, so no `--ref-source-id`.

### 2. Location establishing still

Triggers: "establish / design / picture [LOCATION]", or "yes" to a `script-compose` parse offer listing locations.

- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio 16:9 --image-size 2K --subtype location --name "Causeway" --description "..." [--source-node-id <script_or_shot_note_id>]` — **no refs**. A location is a setting anchor, not a derivative.
- Prompt template:
  > `[style] establishing still of [LOCATION NAME]. [visual brief — architecture, lighting, atmosphere]. Wide shot, eye-level, no characters present.`
- Keep the frame empty of characters — locations are reusable references for later scenes. Inherit project style if one exists.
- No ref edges by default. If the location was derived from a script or shot note, use `--source-node-id` so the authorship edge lands.
- *Follow-on:* once you've designed **every** location identified by a `script-compose` parse offer (i.e. the last location in the run), offer the user one short line: "Locations are up — want me to storyboard the next shot?" Bridges into Pattern 6. Skip if locations were designed ad-hoc, not from a script offer.

### 3. Edit / variation / turnaround of an existing image

Triggers: "change / edit / swap / replace / add / remove / tweak / what-if", OR "make a turnaround / 3D version / alternate style / variation" — applied to an image already on the canvas.

- Identify the source node (usually the most recent `image_result`, or one the user named). Grab `source.id` and `source.metadata.aspect_ratio`.
- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio <source ratio> --image-size <source size or 2K> --subtype edit --source-node-id <source.id> --ref-source-id <source.id>`.
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
- `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..." --aspect-ratio <fit the shot> --image-size 2K --ref-source-id <char1.id> --ref-source-id <char2.id> ...`.
- Prompt: the full scene description. Name each character by their role so the generator binds identity to role. Refer to them in the prompt as `@Image1`, `@Image2`, … in `--ref-source-id` order.
- **No `--subtype`** — a scene is neither a character nor an edit. CLI emits one derived edge per `--ref-source-id`.

### 5. Standalone still

Triggers: a fresh image unrelated to existing canvas content ("generate a mountain at dusk", "a noir alley — just the setting").

- Plain `node "$PAI_REPO_ROOT/server/cli/generate_image.js" --prompt "..."` with sensible defaults (16:9, 2K unless the user asks otherwise). No subtype, no refs.

### 6. Storyboard mosaic — one composite per clip / shot note

Triggers: user asks for a storyboard, mosaic, NxN / N×M grid, shot list, coverage, keyframe sheet, shot planning, or image previs. The intent is **ONE composite image with N×M panels per clip or <=15s shot note**, NOT one image per panel and NOT a video.

- **Tool**: `generate_image_pro.js` (pro tier). Use it for better rendered text, panel boundaries, and multi-cell layout fidelity.
- **Single call per mosaic**: ONE `node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --prompt "..." --size 2560x1440 --subtype storyboard --label "Storyboard — Shot <N>" --source-node-id <shot_note_id>` per shot-note mosaic. The pattern's point is one composite image per clip/shot note, not N×M small generations.
- **Exact size**: default to **`2560x1440`** — this is filmmaking. Each panel inside the mosaic is a 16:9 cinematic frame, and the overall sheet should also feel cinematic landscape. The grid shape (3×3, 4×2, etc.) describes cell layout, NOT canvas shape. Only override if the user explicitly says "portrait", "square", "vertical", or names a different ratio:
  - "3x3 storyboard" → `2560x1440` (default)
  - "3x3 square storyboard" → `1920x1920`
  - "3x3 portrait storyboard" → `1440x2560`
  - "vertical 2x4 mosaic" → `1440x2560`
- **Default grid**: 2×2 unless the user specified another. Announce in chat one short line before each call ("Generating a 2×2 mosaic for Shot <N>" or "Generating a 2×2 mosaic.") — don't paste the prompt.
- **Optional refs**: if a character / location reference is on the canvas, pass it via `--ref-source-id` (≤32 for pro) so identity stays locked across cells and the provenance edges land. The script-analyzed case triggers one mosaic per shot note, with per-shot refs and `--source-node-id <shot_note_id>` — see `references/storyboard-mosaic.md`.
- **Grid size limit**: default to 2×2. Larger grids are allowed, but if the user asks for `3×3` or larger, warn first using the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommend `Split into smaller sheets`; offer `Run one pro mosaic` as the alternative.

**For the canvas pre-flight, per-shot-note iteration logic, missing-anchor nudge, verbatim prompt template, and default panel coverage when no script slice exists**: see [references/storyboard-mosaic.md](references/storyboard-mosaic.md).

#### Node fields the CLI sets

- ONE `image_result` node PER mosaic.
- Set `data.subtype = "storyboard"` by passing `--subtype storyboard`.
- The CLI uses your `--label` ("Storyboard — Shot <N>" if shot-specific; "Storyboard" if standalone) and stores the full prompt. Use `subtype: "storyboard"` first, with the label, prompt sections, `source_id`, and incoming derived edges as legacy fallback signals for older projects.

### 7. Character reference sheet *(default for ANY video-bound character work — with or without actor refs)*

**PROACTIVE TRIGGER — use this pattern WITHOUT being asked** whenever the user names one or more characters that will appear in downstream video work (script, scene brief, promo, 宣传片, 短片, 连续剧, "make a short film with X", "拍一段戏 with characters A and B"). This applies regardless of whether the canvas has uploaded actor photos — see the two modes below.

**Mode A — with ≥3 uploaded actor reference photos.** Use the photos as `--ref-source-id` inputs; the model triangulates identity from the refs and the prompt's REFERENCE-PHOTO PRIORITY clause locks costume to what the refs show. If a script or shot note authored the design, add `--source-node-id <note_id>`. Announce: *"You have [N] refs for [character] — generating a 4-panel reference sheet (front / profile / back / closeup) so the actor stays identity-consistent across video shots."*

**Mode B — 0-2 refs, designing from scratch.** No actor refs to pass. Use a text-only variant of the 4-panel prompt that describes the character (age, build, wardrobe, distinguishing features) explicitly inside each panel block. If a script or shot note authored the design, add `--source-node-id <note_id>`. The output is still a 4-panel sheet engineered for video-gen consumption — just generated from words instead of photos. Announce: *"Starting with a 4-panel reference sheet for [character] so the identity locks across video shots. Tell me if you'd rather have simple single portraits via Pattern 1."*

Also fires on explicit asks: "design a character sheet / turnaround / reference sheet / character design for [character]", "make a 4-panel character design", "generate a production reference sheet for downstream video work".

The output is a single 4-panel sheet (Front-full / Profile-full / Back-full / Closeup-bust) that downstream video gen consumes directly as `--ref-source-id` without further cropping — validated to outperform single portraits by 11+ points on Gemini-judged video identity consistency.

Distinct from Pattern 1: Pattern 1 produces a single static portrait (poster, print art, illustration) that will NOT be passed to video gen. Pattern 7 produces a multi-view sheet engineered for video-gen consumption. **For any character that will be referenced by a video gen call later, choose Pattern 7 — even without refs.** The 4-panel layout's value is the multi-angle data, not just the multi-ref triangulation; both modes deliver it.

- Pre-flight: for current uploaded refs, follow the project `PROJECT_AGENT.md` § "Choosing context" and identify reference image nodes (`subtype: "reference"`, ideally ≥3 photos of the same actor from different angles or lighting). Confirm the ref count to the user in one short line before firing.
- `node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --prompt "..." --size 2560x1440 --subtype character --name "<character_name>" --role "..." --ref-source-id <ref1> --ref-source-id <ref2> --ref-source-id <ref3> [--source-node-id <script_or_shot_note_id>]` — pro tier is the default for character sheets because panel layout, text suppression, and identity consistency are load-bearing. Do not pass `--aspect-ratio` or `--image-size`. Never fire Mode A with fewer than 3 refs (model overfits to the one angle it has).
- With 0-2 actor refs, use the Mode B text-only command from `references/character-sheet.md`: same pro command, but omit every actor-photo `--ref-source-id`; include `--source-node-id` only when a script or shot note authored the design.
- ONE call. ONE sheet per base character or material variant. For a variant that must preserve the same identity, pass the base character sheet as a `--ref-source-id` and describe only the persistent wardrobe/state change.
- The sheet plugs into `generate_video.js` as `--ref-source-id <sheet_id>` for any downstream shot (front / back / profile) — no cropping needed for typical use.

**For the verbatim 4-panel prompt template, the optional per-angle anchor crop sub-flow, cross-character validation evidence, and the gotchas (no-text rule, photo-priority, exact panel counts)**: see [references/character-sheet.md](references/character-sheet.md).

#### Node fields the CLI sets

- ONE `image_result` node with `data.subtype = "character"`.
- `data.name`, `data.role`, `data.description` from the CLI flags.
- One `derived` edge per `--ref-source-id` (so the sheet is provenance-linked to each actor photo it triangulated from).

## After the CLI returns

For draft-stage JSON, one sentence with the price/status — see the project `PROJECT_AGENT.md` § "Draft gate". For terminal results, follow the project manual's next-step recommendation rule.
