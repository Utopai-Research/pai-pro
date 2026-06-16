# Character reference sheet for video-bound characters — prompt template

For `node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js"` with exact `--size 2560x1440` by default and optional multiple `--ref-source-id` flags. Produces ONE composite 16:9 character reference sheet with FOUR panels (Front-full / Profile-full / Back-full / Closeup-bust) per character. The sheet is consumable directly as a `--ref-source-id` for downstream video gen — no cropping required for typical use.

Default fire command shape for Mode A with actor refs:

```
node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" \
  --prompt "<filled 4-panel prompt>" \
  --size 2560x1440 \
  --subtype character \
  --name "<character_name>" \
  --role "<role>" \
  --ref-source-id <ref1> \
  --ref-source-id <ref2> \
  --ref-source-id <ref3>
```

Pro tier accepts exact `--size` only. Do not pass `--aspect-ratio` or `--image-size` for this flow.

If a script or shot note authored the character design, add `--source-node-id <note_id>`. For Mode B with no actor refs, use the same command but omit all actor-photo `--ref-source-id` flags; still add `--source-node-id <note_id>` when a note authored the design.

## Contents

- Pre-flight: choose Mode A or Mode B
- The 4-panel sheet prompt (verbatim — fill `{{...}}` placeholders)
- After firing: how the sheet plugs into video gen
- Optional: per-angle anchor crops for stress-test fidelity
- Gotchas (read before iterating)

## Pre-flight: choose Mode A or Mode B

This flow needs current uploaded refs, so per the project `PROJECT_AGENT.md` § "Choosing context", read `./workflow.json` and identify the reference image nodes for this character:

- `image_result` nodes with `data.subtype = "reference"` and `data.metadata.source = "user_upload"` (the user uploaded these — not AI-generated)
- Ideally **≥3 photos** of the same actor from different angles or lighting; this is the multi-ref triangulation the prompt depends on
- Skip archived nodes (`data.archived === true`)
- Skip AI-generated images even if they share the `reference` subtype — only true uploaded photos belong in the ref set

Confirm in one short line to the user before firing: *"Using image_X, image_Y, image_Z as reference photos for the sheet."* If only 1-2 refs are available, do not pass them by default; ask with the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommend `Upload more refs`; offer `Continue text-only` as the alternative.

## The 4-panel sheet prompt — Mode A (with ≥3 actor reference photos)

Three placeholders to fill per character: `{{PRODUCTION_TITLE}}`, `{{CHARACTER_NAME_AND_ROLE}}` (e.g. `"Detective Morris — middle-aged narcotics detective"`), and `{{N}}` (the count of reference photos you're passing). **Do NOT add a textbook costume description** — let the refs drive the costume entirely. The "REFERENCE-PHOTO PRIORITY" clause depends on that.

```
Professional character reference sheet for the live-action TV drama {{PRODUCTION_TITLE}}. Subject: {{CHARACTER_NAME_AND_ROLE}} — the SAME real human actor shown in all {{N}} reference photographs (different angles, lighting). 16:9 horizontal layout with EXACTLY FOUR EQUAL-WIDTH PANELS side-by-side, in this order from left to right:

[PANEL 1] FULL BODY FRONT VIEW — full height head to feet, facing camera directly, arms slightly away from body in neutral A-pose.
[PANEL 2] FULL BODY PROFILE VIEW — same height, perfect 90-degree side view, same pose.
[PANEL 3] FULL BODY BACK VIEW — same height, facing completely away from camera, showing the back of the costume, hair, and any headpiece clearly.
[PANEL 4] CLOSE-UP HEAD AND SHOULDERS — bust shot only (NOT full body), face occupies roughly 50-60% of the panel area, looking directly at camera, neutral expression. This panel is the face-identity anchor for downstream video work.

[REFERENCE-PHOTO PRIORITY — HARD RULE]
Where any detail in this prompt conflicts with what the reference photos show, the PHOTOGRAPHS WIN. Render exactly the costume, hair, beard, accessories shown in the refs — no textbook substitution.

[PHOTOGRAPHIC AESTHETIC]
Documentary photography style, RAW 35mm Kodak Portra 400 color, visible skin pores and beard hairs, available-light soft studio lighting, real fabric texture and weight. ABSOLUTELY NOT a 3D render, video-game CG, Pixar, smoothed-skin filter, anime, or digital painting. Render each panel as if it were a separate on-set wardrobe-test photograph.

[HARD CONSISTENCY]
EXACT same face in all 4 panels. EXACT same costume. EXACT same hair. Identical lighting across all 4 panels. Same neutral mid-grey seamless backdrop. The 3 full-body panels are the SAME scale (head and feet aligned across panels 1-3).

[NO TEXT — HARD RULE, REPEATED AT END OF PROMPT]
No captions, no labels, no English words, no Chinese characters, no numbers, no headers, no gibberish text, no annotations, no logos. The image is purely visual.

[OUTPUT]
High-resolution 16:9 production sheet, clean editorial layout, no decorative borders between panels.
```

For an elderly character, add to the `[PHOTOGRAPHIC AESTHETIC]` block: `actor's age signs preserved (deep wrinkles around eyes and mouth, age spots, white/silver beard hairs); do NOT youthify.`

## The 4-panel sheet prompt — Mode B (no actor refs — generate from text)

Use this when the character is being designed from scratch (no uploaded reference photos) but will still appear in downstream video work. The 4-panel layout is preserved; the photo-priority clause is dropped (no photos to prioritize); the prompt explicitly describes the character so all 4 panels render the same person.

Five placeholders to fill: `{{PRODUCTION_TITLE}}`, `{{CHARACTER_NAME_AND_ROLE}}`, `{{CHARACTER_PHYSICAL_DESCRIPTION}}` (age, build, ethnicity, hair, distinguishing features), `{{COSTUME_DESCRIPTION}}` (what they wear in the scene — be specific: fabric, color, period accessories), `{{STYLE_HINT}}` (photoreal / illustrated / animation — match what the user implied).

```
Character reference sheet for {{PRODUCTION_TITLE}}. Subject: {{CHARACTER_NAME_AND_ROLE}}.

[CHARACTER IDENTITY — locked across all 4 panels]
{{CHARACTER_PHYSICAL_DESCRIPTION}}.
Wearing: {{COSTUME_DESCRIPTION}}.
The SAME person appears in every panel — same face, same body, same costume, same lighting.

[GRID LAYOUT — 16:9 horizontal, EXACTLY FOUR EQUAL-WIDTH PANELS side-by-side]
[PANEL 1] FULL BODY FRONT VIEW — head to feet, facing camera directly, neutral A-pose, arms slightly away from body.
[PANEL 2] FULL BODY PROFILE VIEW — head to feet, perfect 90-degree side view, same pose, same scale.
[PANEL 3] FULL BODY BACK VIEW — head to feet, facing completely away from camera, showing back of costume and hair/headpiece clearly.
[PANEL 4] CLOSE-UP HEAD AND SHOULDERS — bust shot, face occupies roughly 50-60% of the panel area, looking directly at camera, neutral expression. This panel is the face-identity anchor for downstream video work.

[STYLE]
{{STYLE_HINT}} — applied uniformly across all 4 panels. Same neutral mid-grey seamless backdrop. Identical lighting across all panels (soft studio key + ambient fill, no dramatic shadows).

[HARD CONSISTENCY]
EXACT same face in all 4 panels. EXACT same costume. EXACT same hair / accessories. The 3 full-body panels are the SAME scale (head and feet aligned across panels 1-3).

[NO TEXT — HARD RULE, REPEATED AT END OF PROMPT]
No captions, no labels, no English words, no Chinese characters, no numbers, no headers, no gibberish text, no annotations, no logos. The image is purely visual.

[OUTPUT]
High-resolution 16:9 production sheet, clean editorial layout, no decorative borders between panels.
```

Mode B is less robust than Mode A — identity has to come from words alone, so the model has more freedom to drift between panels. Mitigations:
- Pick a `{{STYLE_HINT}}` that's specific ("photoreal 35mm cinema, Kodak Portra 400, available light" beats "realistic")
- Make `{{CHARACTER_PHYSICAL_DESCRIPTION}}` concrete (3-5 distinguishing visual anchors the model can lock onto across panels)
- Be explicit about `{{COSTUME_DESCRIPTION}}` — fabric, color, period, accessories. Vague costume → wardrobe drift between panels.

After it lands, mention that uploaded refs would improve future iterations.

## After firing: how the sheet plugs into video gen

The sheet's node id (returned in `canvas_mutation.node_id` on the success JSON) is the single ref you pass to `generate_video.js` for any shot of this character:

```
node "$PAI_REPO_ROOT/server/cli/generate_video.js" \
  --prompt "<shot brief>" \
  --ref-source-id <sheet_node_id> \
  [...other shot flags...]
```

The sheet is a byte ref, so it goes in `--ref-source-id`; reserve `--source-node-id` for a shot note that authored the clip, if one exists.

Front close-ups, back-walking shots, 3/4 profile pauses — all use the same `--ref-source-id`. The closeup panel anchors face identity; the 3 turnaround panels supply costume / silhouette / back-of-head detail.

## Optional: per-angle anchor crops (stress-test polish only)

Use only for difficult angles or long repeated-angle sequences.

Workflow:

1. **Crop** the relevant panel with `sips`:
   ```
   sips --cropToHeightWidth <H> <W> --cropOffset <Y> <X> \
     ./assets/images/<sheet>.jpg \
     --out ./assets/.tmp/back_crop_$(date +%s).jpg
   ```
   For `2560x1440`, panels are ~640×1440. Offsets: front `0 0`, profile `0 640`, back `0 1280`, closeup `0 1920`.

2. **Upload to canvas** as a new reference node via `canvas_mutate`:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addNode \
     --payload-json '{"node":{"type":"image_result","data":{"subtype":"reference","label":"<char> back-view crop","source_filename":"<char>_back.jpg","attachment_id":"agent_crop_back_v1","metadata":{"source":"agent_crop","task_type":"image_crop_from_sheet","source_url":"<sheet_node_id>"}},"tmp_path":"<absolute path to the cropped jpg>"}}'
   ```

3. Use the returned `assigned.node_id` as the `--ref-source-id` for the stress-test shots.

This sub-flow is unnecessary for normal production work; the 4-panel sheet is the default.

## Gotchas (read before iterating)

1. **Don't write a textbook costume description in the prompt.** If you describe what the costume "should" look like and that disagrees with the refs, the model renders YOUR text instead of what the refs show. The "REFERENCE-PHOTO PRIORITY" clause neutralizes this — keep it in place and let the refs drive. Validated cost when violated: −20 points on a worst-case mismatch.

2. **Use `EXACTLY THREE / SIX / FOUR` panel counts** if you ever add expression or pose modules. Without exact counts, the model may substitute module types, such as dropping an expression panel and adding texture swatches instead.

3. **The "no text" rule has to be repeated 3×** in the prompt to be reliable — once at the top, once in the layout section, once at the end. Even then the model can sneak in panel labels at the bottom of the sheet ("FRONT VIEW" / "PROFILE VIEW" / etc.). Cosmetic only; doesn't affect downstream video performance. Crop them off post-hoc if they bother you.

4. **Only include `--source-node-id` when a real canvas note authored the design.** Actor photos and base sheets belong in `--ref-source-id`; those flags already create provenance edges.

5. **One sheet per character or material variant.** Don't try to put two characters in the same 4-panel sheet. Identity drift between halves of the canvas is a real failure mode; the 4-panel layout assumes a single subject. For a persistent variant of an existing character, pass the base sheet as a `--ref-source-id` and describe only the wardrobe/state change.
