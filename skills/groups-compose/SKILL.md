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

- Write only `id`, `title`, `node_ids` (and optionally `hue` 0–360).
- Never set `x` / `y` / `width` / `height` / any "collapsed" flag.
- A node may appear in at most one group.
- No nested groups.
- `id` format: `^group_[a-z0-9_]+$`. Titles are free-form (≤ 30 chars recommended).

## Patterns

Pick the one that fits. When unsure, read `./workflow.json` first to see which ids actually exist.

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

Groups go through the canvas mutator — the agent does NOT `Write` /
`Edit` `workflow.json` directly (a PreToolUse hook blocks that path).

1. `read` `./workflow.json` to enumerate existing node ids + existing groups (reads are unrestricted; only writes are blocked).
2. Identify which nodes belong in the proposed group by looking at their ids, labels, prompts, and subtypes. Keep only ids that actually exist in `nodes` AND aren't already in another group (the mutator rejects double-membership with `klass:conflict`).
3. Decide on title + hue (0–360). Default hue 200 if you have no signal.
4. **New group** — call the mutator with `addGroup`:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addGroup \
     --payload-json '{"group":{"title":"Scene 1 — Causeway","node_ids":["image_3","video_1","note_2"],"hue":200}}'
   ```
   Stdout returns `assigned.group_id`. The CLI auto-mints `group_<N>` if you don't pass an explicit id in the payload.
5. **Extend an existing group** — call the mutator with `updateGroup`, passing the full new `node_ids` list (the mutator replaces the list wholesale and dedupes):
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op updateGroup \
     --payload-json '{"id":"group_3","patch":{"node_ids":["image_3","video_1","note_2","image_5"]}}'
   ```
6. Confirm to the user in **one sentence**. Example: "Grouped the three Morris reference shots under their own frame."

## What not to do

- Don't propose groupings proactively when there's no clear semantic tie — wait until grouping earns the frame.
- Don't group as a workaround for layout issues. Groups are for the reader; if the layout needs work, that's a system problem, not a grouping problem.
- Don't write `x` / `y` / `width` / `height` into a group or its members. The system computes all geometry from the `node_ids` list.
- Don't nest (put one group's id inside another group's `node_ids`).
- Don't assign a node to two groups. Pick the most specific one.
