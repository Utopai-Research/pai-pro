---
name: script-compose
description: >-
  Handles explicit screenplay/story work on the filmmaking canvas. Triages
  screenplay (use verbatim), story/concept (iterate then rewrite), or neither
  (defer). Captures the final script note/title; on explicit command, splits
  into <=15s shot notes and extracts characters, variants, locations, and
  speaking/VO needs. Use for writing, adapting, rewriting, splitting, analyzing,
  or breaking down scripts/stories. Preserves dialogue verbatim and returns
  multi-stage planning to story-to-video-workflow before media generation. Does
  not split/analyze on file drop or without explicit intent.
---

Run only on explicit user intent, never on file drop. Dropped text/PDF already exists as a note (`data.body`) and mirror (`./assets/notes/<note_id>.md`).

Defaults: a 30s beat is one moment; match the input language; with characters, prefer meaningful dialogue and let narration support rather than carry the scene.

Stop at script capture, shot notes, and anchor extraction. Route multi-stage work back to `story-to-video-workflow`.

Capture target duration when observable:

- Explicit user duration wins ("30 seconds", "2-minute short").
- Timestamp blocks come next; sum them.
- Otherwise estimate roughly and mark it as an estimate.

Store `target_duration_sec` and `duration_basis` when known. If implied runtime is >~3 minutes, call out scope before shot/video planning.

## 1. Triage → Capture

Classify the input, then capture as in §2. Never skip straight to §3.

- **Screenplay** (INT./EXT. + ALL-CAPS cues + dialogue) → use **verbatim**. For dropped text/PDF, read `workflow.json` `data.body` or `./assets/notes/<note_id>.md`. Pick a 2–5 word title; identify duration basis; do not rewrite to fit.
- **Story / concept** (prose, pitch, logline) → sketch ONE paragraph back (setting, characters, conflict, target duration) and ask if it's the shape. Iterate. On "yes/go", rewrite using the rules below, then capture.
- **Neither** → don't run; defer to `image-compose` / `video-compose`.

Torn between screenplay and story? Prefer screenplay — safer than rewriting.

**Rewrite rules (story → screenplay):**
- Format: `INT./EXT. LOCATION - TIME` slug, present-tense action, ALL-CAPS cue + dialogue. No scene numbering. No camera directions (that's `video-compose`).
- Preserve user-quoted dialogue verbatim.
- With characters, include dialogue that reveals motive/conflict/relationship; avoid narration-only exposition unless VO-driven.
- Pace speech at ~2.2-2.5 words/sec plus reaction/action room.
- Duration: match if stated; default 30–45s. Don't overshoot.
- Short input, longer target? Keep verbatim and ask "reads as ~Ns; extend?" — don't silently pad.

## 2. Capture — canvas note + title

ONE note. No split. Canvas writes go through the mutator, never direct `workflow.json`.

1. `read` `./workflow.json` (read-only inspection — see if `title` is already set).
2. **Append the script note** via the mutator with `subtype: "script"`:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addNode \
     --payload-json '{"node":{"type":"note","data":{"subtype":"script","label":"Script: <title>","body":"<full screenplay verbatim>","metadata":{"author":"agent","timestamp":"<ISO>","target_duration_sec":45,"duration_basis":"estimated from script length"}}}}'
   ```
   Omit `target_duration_sec` / `duration_basis` only when there is no defensible signal.
   Stdout returns `assigned.node_id` — keep it for §3 (shots derive from this id).
3. **Set the workflow title if empty:**
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" --op setTitle --payload-json '{"title":"<title>"}'
   ```
4. Confirm with `Captured.`, then offer the next step as a choice rendered per the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommended option: "Split it into <=15s shots and extract characters/locations/voices." Plus an escape to do something else.

STOP. Do NOT proceed to §3 without an explicit user command.

## 3. Analyze — on explicit user command

**Triggers** (judge intent): "split into shots / clips", "break this up", "pull the characters / locations", "who's in this", "analyze this script", "design the characters from this script".
**Not triggers:** "what's in this", "summarize", "tell me about it" — those are read-and-reply.

When triggered:

1. **Slug** — kebab-case of the working title. Collision → suffix `-2`, `-3`.
2. **Shot splits** (≤15s each): use `metadata.target_duration_sec` or estimate. Split on natural beats (slug/dialogue/location/time/appearance changes). For >15s material, keep resulting shots as close to 15s as natural; split shorter only for hard cuts, dialogue turns, continuity shifts, or strong beats. Pace speech at ~2.2-2.5 words/sec plus reaction/action room; silent action ~3–5s. If dialogue cannot fit naturally, split it; reduce only when the user asked for compression. **Never rewrite** — shot bodies are verbatim slices. Each shot note has `subtype: "shot"`. Build one `addBatch` with N shot notes + N derived edges:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addBatch \
     --payload-json '{
       "nodes": [
         {"type":"note","data":{"subtype":"shot","label":"Shot 1 (0–15s)","body":"<slice>","metadata":{"author":"agent","timestamp":"<ISO>"}}},
         {"type":"note","data":{"subtype":"shot","label":"Shot 2 (15–30s)","body":"<slice>","metadata":{"author":"agent","timestamp":"<ISO>"}}}
       ],
       "edges": [
         {"from":"<script_note_id>","to":"$0","kind":"derived"},
         {"from":"<script_note_id>","to":"$1","kind":"derived"}
       ]
     }'
   ```
   `$N` placeholders are 0-indexed positions in `nodes`; the mutator resolves them to the assigned ids after running. Reply's `assigned.node_ids` is the array of shot ids in the same order.
3. **Anchor extraction** — from the shot bodies, extract only downstream needs:
   - **Characters**: recurring/visually important people/entities. Include one-line base visuals only when given.
   - **Variants**: same character with materially different on-screen look by scene/shot: age jump, costume change, injury, disguise, transformation, wet/dirty/bloodied state if it must persist across shots. Do not create variants for transient expressions or tiny props.
   - **Locations**: distinct settings plus same-setting variants when framing/scale, time, weather, lighting, dressing, story state, or close/detail coverage matters.
   - **Voices**: every speaking character and narration/V.O.; preserve speaker labels and dialogue language.
   - **Missing anchors**: first character, variant, location, or voice that blocks rendering Shot 1.
4. **Parse offer** — ONE compact planning line plus a soft next step:
   > `Plan check: ~<seconds>s, <shots> shots, <N> character(s), <V> variant(s), <M> location(s), <S> voice need(s). Missing: <first blocker>.`
   If N>0, V>0, M>0, or S>0, offer next step with project choice shape. Recommended: "Design the character/location anchors, then voices." Anchors include base/variant character sheets, detailed location/location variants, and speaker/VO voice anchors.
   On approval, route to `image-compose` first (base character sheets, needed character variants, and location stills) with `--source-node-id <script_note_id>` so the new nodes wire back to the script. After image anchors land, route speaking/narration needs to `voice-compose`. Don't generate inside `script-compose`. Skip the offer if every count is 0.

If the user's command was narrower ("just the shots", "only characters"), do only that sub-step and skip the offer.

## 4. Revisions

**Surgical** (title still fits): update script-note body + affected shot bodies in place. Use the mutator's `updateNode` op (one call per node, or batched via `updateBatch`).
**Structural** (title no longer fits): new script note (`addNode`); old→new edge `addEdge` with `kind:"derived"`; new shot family via `addBatch` against the new script note. Leave old shots; delete only if asked (`deleteNode` cascades edges for you).
