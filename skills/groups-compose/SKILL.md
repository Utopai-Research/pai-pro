---
name: groups-compose
description: Designs and maintains semantic groupings of nodes on the filmmaking canvas — scenes, character-reference sets, act beats, and other reading-clarity frames. Use when nodes on the canvas cluster around a shared meaning (same scene, same character, same act, same production state) and would read more clearly with a titled frame around them. Don't force it — groups are a view concern, not an organizing tax.
---

## When to propose a group

A good grouping earns its frame. Rule of thumb:

- **3+ nodes** share a clear semantic tie (same scene, same character, same beat)
- The relationship would be obvious to a reader within 2 seconds of scanning the canvas
- You can write a ≤ 30-character title that names the tie

If fewer than 3 members resolve, or the tie is just "these happened to be generated in a row", skip the group. A too-eager grouping is worse than none — it adds a frame the reader has to parse without carrying real meaning.

## Contract recap (enforced)

A group is a **visual frame** that wraps its member nodes on the canvas. The frame's geometry (x, y, width, height) is a bounding box computed from the members' current positions.

- Write `memberIds`, `title`, `hue` (0–360), AND `x` / `y` / `width` / `height` for the frame itself.
- Never touch the **member nodes'** `x` / `y` — the renderer positions them; the frame just wraps wherever they currently sit.
- A node may appear in at most one frame. If a proposed member is already in an existing frame, evict it first (re-PUT the old frame with the reduced `memberIds`, or `DELETE` the old frame if fewer than 2 members would remain).
- No nested frames.
- `frameId` format: `frame_<unix_ms>` (e.g. `frame_1716579123456`). Matches the frontend's convention. Titles are free-form (≤ 30 chars recommended).

## Patterns

Pick the one that fits. Grouping is current canvas state; read `workflow.json` per AGENTS.md § "Choosing context" to verify ids.

### 1. Scene grouping

Most common. Group the prompt, generated imagery, and any notes that all belong to the same scripted scene.

- Triggers: the user framed a sequence of generations around a single scene (location, beat, or plot point). Look for 3+ nodes that share a scene tag in prompts / labels.
- Title format: `Scene <N> — <location or beat>`. Examples:
  - `Scene 1 — Causeway`
  - `Scene 3 — Kitchen, 2 AM`
  - `Scene 5 — Rooftop chase`
- Typical size: 3–8 members.
- Members: the scene's prompt / shot / image_result / video_result cards, plus any notes that scope to that scene.

### 2. Character-reference set

A character card + its reference images.

- Triggers: ≥ 2 images of the same person / character.
- Title format: `<Character name> — references`. Examples:
  - `Morris — references`
  - `Riya — references`
- Typical size: 2–6 images.
- Members: any `image_result` nodes depicting the same character.

### 3. Act / beat grouping

Coarser than scene — groups a whole Act or story beat.

- Triggers: the user framed the session at act/beat granularity ("everything for act 2", "the whole chase sequence", "opening titles").
- Title format: `Act <N>` or a beat name. Examples:
  - `Act 1`
  - `Opening titles`
  - `Chase sequence`
- Typical size: 8–15 members. If larger, prefer splitting into scene subgroups instead.
- Members: all nodes that belong to that act/beat, spanning multiple scenes.

### 4. Production-state grouping (opt-in)

Less common; use only when the user explicitly sorts by quality / status.

- Triggers: "approved shots", "draft", "rejected", "WIP", "final".
- Title format: a single status word. Examples: `Approved`, `In progress`, `Rejected`.
- Typical size: open-ended.

## Recipe

Frames go through the HTTP API (`PUT /projects/:id/group-frames/:frameId`) — the same path the frontend's own "+ Group" button uses. The mutator's `addGroup` op writes to a metadata-only store nothing visualizes; don't use it.

1. **Read `./workflow.json` + `./canvas_positions.json`.** workflow.json gives you node ids + labels + subtypes; canvas_positions.json gives you each node's `x` / `y` AND the existing `groupFrames` map. Reads are unrestricted; only writes are blocked.
2. **Pick members.** Identify which nodes belong in the proposed frame by looking at their ids, labels, prompts, and subtypes. Keep only ids that actually exist in `nodes`.
3. **Evict any member already in another frame.** For each id in your proposed `memberIds`, scan existing `groupFrames`. If you find a frame that contains it:
   - If the old frame would still have ≥ 2 members after eviction: re-PUT the old frame with `memberIds` minus the evictee (recompute bbox).
   - If the old frame would have < 2 members: `DELETE /projects/<id>/group-frames/<oldFrameId>` (the frame loses meaning at 0–1 members).
4. **Compute the bbox** from your members' positions. Use 24px padding (matches the frontend's `FRAME_BBOX_PADDING`). Member widths/heights are determined by `pickSize` in `web/src/pages/CanvasPage/placement.ts:176`. Use these fallbacks per type:
   - `note`: **280 × 420**  (width hardcoded; height = `NOTE_CARD_FALLBACK_HEIGHT` for first paint)
   - `image_result`: **290 × 220**  (16:9 default; if `data.metadata.aspect_ratio` is present, scale accordingly)
   - `video_result`: **290 × 220**  (same caveat; check `data.aspect` or `data.metadata.aspect_ratio`)
   - `audio_result`: **240 × 64**
   - `pending` / `pending_generation` / `pending_attachment`: **260 × 200**

   *Heads-up on dynamic heights*: React Flow measures each card's real rendered height after first paint and stores it in `measuredHeights` (see `useCanvasPositions.ts`). The 420 px fallback for `note` is the **maximum** initial height; short notes will measure smaller and the frame may end up taller than needed (harmless — user can drag-resize). If `measured_heights` ever surfaces in `canvas_positions.json`, prefer those values over the fallback.
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
5. **Decide title + hue.** Default hue 200 if you have no signal.
6. **PUT the new frame.** Read project id from `./meta.json`'s `id` field. Pick `frameId = frame_<unix_ms>`:
   ```
   curl -X PUT \
     -H "Content-Type: application/json" \
     -d '{"memberIds":["image_3","video_1","note_2"],"x":120,"y":80,"width":540,"height":380,"hue":200,"title":"Scene 1 — Causeway"}' \
     "http://localhost:7488/projects/<projectId>/group-frames/frame_<unix_ms>"
   ```
   On success the server fans the update out via Socket.IO; the canvas updates within a frame.
7. **Extending an existing frame** — same PUT, same frameId, full new `memberIds` list, recomputed bbox. PUT is idempotent overwrite.
8. **Confirm to the user in one sentence.** Example: *"Grouped the three Morris reference shots under their own frame."*

## What not to do

- Don't propose groupings proactively when there's no clear semantic tie — wait until grouping earns the frame.
- Don't group as a workaround for layout issues. Groups are for the reader; if the layout needs work, that's a system problem, not a grouping problem.
- Don't modify the **member nodes'** `x` / `y` — the renderer positions them. The frame's own `x` / `y` / `width` / `height` is computed from the members' bounding box (recipe step 4).
- Don't call `canvas_mutate.js --op addGroup` / `updateGroup` / `deleteGroup`. Those write to `workflow.json` → `groups[]`, which no frontend code reads. Use the HTTP `PUT /projects/:id/group-frames/:frameId` route instead (recipe step 6).
- Don't nest (put one frame's id inside another frame's `memberIds`).
- Don't assign a node to two frames. Evict from the old frame first (recipe step 3).
