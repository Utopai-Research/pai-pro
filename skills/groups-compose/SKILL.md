---
name: groups-compose
description: Designs and maintains semantic groupings and readable layouts on the filmmaking canvas — scenes, character-reference sets, act beats, and other titled visual frames. Use when nodes on the canvas cluster around a shared meaning and would read more clearly if arranged together and wrapped in a frame. Don't force it — groups are a view concern, not an organizing tax.
---

## When to propose

- **3+ nodes** share a clear semantic tie (same scene, same character, same beat)
- The relationship would be obvious to a reader within 2 seconds of scanning the canvas
- You can write a ≤ 30-character title that names the tie

Skip if fewer than 3 members or the tie is just generation order.

## Contract

- Use `canvas_layout.js` to write member `positions` and `groupFrames` in one atomic sidecar update.
- Never write or edit `workflow.json`; never put `x` / `y` into node data.
- A layout change may move member nodes when that makes the canvas clearer.
- The frame's geometry (`x`, `y`, `width`, `height`) is a bounding box computed from the final member positions.
- A node may appear in at most one frame; evict it from old frames in the same update.
- No nested frames.
- `frameId`: `frame_<unix_ms>`. Titles ≤30 chars recommended.

## Patterns

Pick the one that fits. Grouping is current canvas state; read `workflow.json` per the project `PROJECT_AGENT.md` § "Choosing context" to verify ids.

### 1. Scene grouping

- Triggers: 3+ prompt/note/image/video nodes around one location, beat, or plot point.
- Title: `Scene <N> — <location or beat>`.
- Typical size: 3–8 members.
- Members: prompt/shot/image_result/video_result plus scene-scoped notes.
- Layout: place the script/shot note on the left, then images/videos in reading order to the right. Put attached voice/audio below the source card.

### 2. Character-reference set

A character card + its reference images.

- Triggers: ≥2 images of the same character.
- Title: `<Character name> — references`.
- Typical size: 2–6 images.
- Members: any `image_result` nodes depicting the same character.
- Layout: hero/reference card first, variations in a compact grid, attached voice node below.

### 3. Act / beat grouping

- Triggers: the user framed the session at act/beat granularity ("everything for act 2", "the whole chase sequence", "opening titles").
- Title: `Act <N>` or beat name.
- Typical size: 8–15 members. If larger, prefer splitting into scene subgroups instead.
- Members: all nodes that belong to that act/beat, spanning multiple scenes.
- Layout: arrange scene clusters left-to-right in story order, with enough gutter that frames do not overlap.

### 4. Production-state grouping (opt-in)

- Use only when user explicitly sorts by quality/status: approved, draft, rejected, WIP, final.
- Title: one status word.
- Typical size: open-ended.

## Recipe

1. **Read `./workflow.json` + `./canvas_positions.json`.** workflow.json gives you node ids + labels + subtypes; canvas_positions.json gives you each node's `x` / `y` AND the existing `groupFrames` map. Reads are unrestricted; writes go through `canvas_layout.js`.
2. **Pick members.** Identify which nodes belong in the proposed frame by looking at their ids, labels, prompts, and subtypes. Keep only ids that actually exist in `nodes`.
3. **Plan positions.** Preserve existing positions when they already read well. Otherwise move the selected nodes into a compact layout for the chosen pattern. Use these default gaps:
   - horizontal card gap: 40 px
   - vertical row gap: 36 px
   - frame padding: 24 px
4. **Evict existing frame members** in the same layout JSON:
   - If the old frame would still have ≥ 2 members after eviction: include it under `groupFrames.upsert` with `memberIds` minus the evictee.
   - If the old frame would have < 2 members: include its id under `groupFrames.delete`.
5. **Compute frame bboxes** from final member positions with 24px padding. Fallback sizes:
   - `note`: **280 × 420**  (width hardcoded; height = `NOTE_CARD_FALLBACK_HEIGHT` for first paint)
   - `image_result`: **290 × 220**  (16:9 default; if `data.metadata.aspect_ratio` is present, scale accordingly)
   - `video_result`: **290 × 220**  (same caveat; check `data.aspect` or `data.metadata.aspect_ratio`)
   - `audio_result`: **240 × 64**
   - `pending` / `pending_generation` / `pending_attachment`: **260 × 200**

   If measured heights appear in `canvas_positions.json`, prefer them.
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
7. **Apply one layout update** with all node moves and frame changes:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_layout.js" \
     --layout-json '{"positions":{"note_2":{"x":120,"y":80},"image_3":{"x":440,"y":80},"video_1":{"x":760,"y":80}},"groupFrames":{"upsert":{"frame_1716579123456":{"memberIds":["note_2","image_3","video_1"],"x":96,"y":56,"width":978,"height":468,"hue":200,"title":"Scene 1 — Causeway"}},"delete":[]}}'
   ```
8. **Extending an existing frame** — same CLI/frameId, full new `memberIds`, recomputed bbox.
9. **Confirm to the user in one sentence.** Example: *"Grouped the three Morris reference shots under their own frame."*

## What not to do

- Don't propose groupings proactively when there's no clear semantic tie — wait until grouping earns the frame.
- Don't use grouping as a generic tidy operation when there is no semantic tie.
- Don't write `canvas_positions.json` directly. Use `canvas_layout.js` so positions and frames apply together.
- Don't call removed workflow group ops (`addGroup`, `updateGroup`, `deleteGroup`).
- Don't nest (put one frame's id inside another frame's `memberIds`).
- Don't assign a node to two frames. Include any eviction in the same layout update.
