---
name: groups-compose
description: Designs and maintains semantic groupings and readable layouts on the filmmaking canvas — scenes, character-reference sets, act beats, and other titled visual frames. Use when nodes on the canvas cluster around a shared meaning and would read more clearly if arranged together and wrapped in a frame. Don't force it — groups are a view concern, not an organizing tax.
---

## When to propose a group

A good grouping earns its frame. Rule of thumb:

- **3+ nodes** share a clear semantic tie (same scene, same character, same beat)
- The relationship would be obvious to a reader within 2 seconds of scanning the canvas
- You can write a ≤ 30-character title that names the tie

If fewer than 3 members resolve, or the tie is just "these happened to be generated in a row", skip the group. A too-eager grouping is worse than none — it adds a frame the reader has to parse without carrying real meaning.

## Contract recap (enforced)

A group is a **visual frame** that wraps member nodes on the canvas. The frame and the member node positions are view state in `canvas_positions.json`; they are not workflow content.

- Use `canvas_layout.js` to write member `positions` and `groupFrames` in one atomic sidecar update.
- Never write or edit `workflow.json`; never put `x` / `y` into node data.
- A layout change may move member nodes when that makes the canvas clearer.
- The frame's geometry (`x`, `y`, `width`, `height`) is a bounding box computed from the final member positions.
- A node may appear in at most one frame. If a proposed member is already in an existing frame, evict it in the same layout update (upsert the old frame with reduced `memberIds`, or delete the old frame if fewer than 2 members would remain).
- No nested frames.
- `frameId`: any unique string of the form `frame_<suffix>`. Mint a fresh random suffix like the frontend does (e.g. `frame_a1b2c3d4`); never reuse an existing frame's id. Titles are free-form (≤ 30 chars recommended).

## Patterns

Pick the one that fits. Grouping is current canvas state; read `workflow.json` per the project `PROJECT_AGENT.md` § "Choosing context" to verify ids.

### 1. Scene grouping

Most common. Group the prompt, generated imagery, and any notes that all belong to the same scripted scene.

- Triggers: the user framed a sequence of generations around a single scene (location, beat, or plot point). Look for 3+ nodes that share a scene tag in prompts / labels.
- Title format: `Scene <N> — <location or beat>`. Examples:
  - `Scene 1 — Causeway`
  - `Scene 3 — Kitchen, 2 AM`
  - `Scene 5 — Rooftop chase`
- Typical size: 3–8 members.
- Members: the scene's prompt / shot / image_result / video_result cards, plus any notes that scope to that scene.
- Layout: place the script/shot note on the left, then images/videos in reading order to the right. Put attached voice/audio below the source card.

### 2. Character-reference set

A character card + its reference images.

- Triggers: ≥ 2 images of the same person / character.
- Title format: `<Character name> — references`. Examples:
  - `Morris — references`
  - `Riya — references`
- Typical size: 2–6 images.
- Members: any `image_result` nodes depicting the same character.
- Layout: hero/reference card first, variations in a compact grid, attached voice node below.

### 3. Act / beat grouping

Coarser than scene — groups a whole Act or story beat.

- Triggers: the user framed the session at act/beat granularity ("everything for act 2", "the whole chase sequence", "opening titles").
- Title format: `Act <N>` or a beat name. Examples:
  - `Act 1`
  - `Opening titles`
  - `Chase sequence`
- Typical size: 8–15 members. If larger, prefer splitting into scene subgroups instead.
- Members: all nodes that belong to that act/beat, spanning multiple scenes.
- Layout: arrange scene clusters left-to-right in story order, with enough gutter that frames do not overlap.

### 4. Production-state grouping (opt-in)

Less common; use only when the user explicitly sorts by quality / status.

- Triggers: "approved shots", "draft", "rejected", "WIP", "final".
- Title format: a single status word. Examples: `Approved`, `In progress`, `Rejected`.
- Typical size: open-ended.

## Recipe

Frames and positions go through the layout CLI. The workflow mutator has no group ops; grouping is visible canvas layout.

1. **Read `./workflow.json` + `./canvas_positions.json`.** workflow.json gives you node ids + labels + subtypes; canvas_positions.json gives you each node's `x` / `y` AND the existing `groupFrames` map. Reads are unrestricted; writes go through `canvas_layout.js`.
2. **Pick members.** Identify which nodes belong in the proposed frame by looking at their ids, labels, prompts, and subtypes. Keep only ids that actually exist in `nodes`.
3. **Plan positions.** Preserve existing positions when they already read well. Otherwise move the selected nodes into a compact layout for the chosen pattern. Use these default gaps:
   - horizontal card gap: 40 px
   - vertical row gap: 36 px
   - frame padding: 24 px
4. **Evict any member already in another frame.** For each id in your proposed `memberIds`, scan existing `groupFrames`. If you find a frame that contains it, include that old frame in the same layout JSON:
   - If the old frame would still have ≥ 2 members after eviction: include it under `groupFrames.upsert` with `memberIds` minus the evictee.
   - If the old frame would have < 2 members: include its id under `groupFrames.delete`.
5. **Compute frame bboxes** from final member positions. Use 24px padding. The frontend computes card sizes from aspect-ratio metadata; when you only have ids, use these per-type fallbacks:
   - `note`: **280 × 420**  (width fixed; 420 is the max first-paint height)
   - `image_result`: **290 × 220**  (16:9 default; if `data.metadata.aspect_ratio` is present, scale accordingly)
   - `video_result`: **290 × 220**  (same caveat; check `data.aspect` or `data.metadata.aspect_ratio`)
   - `audio_result`: **240 × 64**
   - `pending`: **200 × 140**; `pending_generation` / `pending_attachment`: **260 × 200**

   *Heads-up on dynamic heights*: the renderer measures each card's real height after first paint, so a `note` shorter than 420 px ends up with a frame taller than needed (harmless — user can drag-resize).
   ```
   minX = min(node.x for each member)
   minY = min(node.y for each member)
   maxX = max(node.x + node.w for each member)
   maxY = max(node.y + node.h for each member)
   x = minX - 24
   y = minY - 24
   width  = (maxX - minX) + 48
   height = (maxY - minY) + 48
   ```
6. **Decide title + hue.** Default hue 200 if you have no signal.
7. **Apply one layout update.** Mint a fresh `frameId` (`frame_<random-suffix>`). Include every node move and frame change in one JSON body:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_layout.js" \
     --layout-json '{"positions":{"note_2":{"x":120,"y":80},"image_3":{"x":440,"y":80},"video_1":{"x":760,"y":80}},"groupFrames":{"upsert":{"frame_a1b2c3d4":{"memberIds":["note_2","image_3","video_1"],"x":96,"y":56,"width":978,"height":468,"hue":200,"title":"Scene 1 — Causeway"}},"delete":[]}}'
   ```
   The command prints one JSON line. On `ok:true`, the viewer fans the update out via Socket.IO; the canvas updates within a frame.
8. **Extending an existing frame** — same layout CLI, same frameId, full new `memberIds` list, recomputed bbox, and any member position changes.
9. **Confirm to the user in one sentence.** Example: *"Grouped the three Morris reference shots under their own frame."*

## What not to do

- Don't propose groupings proactively when there's no clear semantic tie — wait until grouping earns the frame.
- Don't use grouping as a generic tidy operation when there is no semantic tie.
- Don't write `canvas_positions.json` directly. Use `canvas_layout.js` so positions and frames apply together.
- Don't call removed workflow group ops (`addGroup`, `updateGroup`, `deleteGroup`).
- Don't nest (put one frame's id inside another frame's `memberIds`).
- Don't assign a node to two frames. Include any eviction in the same layout update.
