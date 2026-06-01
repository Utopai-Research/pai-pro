---
name: script-compose
description: >-
  Handles screenplay work on the filmmaking canvas, only on explicit user intent
  (never on a file drop). Triages input as an official screenplay (use
  verbatim), a story or concept (iterate then rewrite at the target duration),
  or neither (defer to image/video skills). Captures the finalized script as a
  canvas note and sets the workflow title. Separately, on an explicit user
  command, splits the script into shot notes capped at 15 seconds each and
  extracts the production anchors needed before generation: characters,
  per-scene variants, locations, and speaking/narration needs. Use when the
  user asks to write, adapt, or rewrite a script, story, or screenplay; to
  split a script into shots or clips; to extract or design characters or
  locations from a script; or to analyze or break down a canvas script.
  Preserves dialogue verbatim and hands multi-stage story-to-video planning
  back to story-to-video-workflow before image, voice, or video generation. Does NOT
  split or analyze without explicit user intent.
---

Run only on explicit user intent — never on a file drop. If the user just dropped a script, the bridge already wrote a filename-reference note; do nothing more until they ask.

Director defaults: a 30s beat is ONE moment; trust silence; match the user's input language.

For multi-stage story-to-video work, this skill stops at script capture, shot notes, and production anchor extraction. After that, route back to `story-to-video-workflow` for sequencing recommendations; then load `image-compose`, `voice-compose`, or `video-compose` for execution.

Script intake should leave the next agent with enough planning context, not a full production plan. Capture the target duration when it is observable:

- Explicit user duration wins ("30 seconds", "2-minute short").
- Timestamp blocks come next; sum them.
- Otherwise estimate roughly and mark it as an estimate.

Store the result on the script note metadata as `target_duration_sec` and `duration_basis` when known. If the script/story implies more than roughly 3 minutes, call out scope before shot/video planning.

## 1. Triage → Capture

Classify the input, then capture as in §2. Never skip straight to §3.

- **Screenplay** (INT./EXT. + ALL-CAPS cues + dialogue) → use **verbatim**. For a dropped file, `read` `./uploads/<filename>` first. Pick a 2–5 word title in the user's language (use the script's own if present). Identify duration basis before capture; do not rewrite to fit it.
- **Story / concept** (prose, pitch, logline) → sketch ONE paragraph back (setting, characters, conflict, target duration) and ask if it's the shape. Iterate. On "yes/go", rewrite using the rules below, then capture.
- **Neither** → don't run; defer to `image-compose` / `video-compose`.

Torn between screenplay and story? Prefer screenplay — safer than rewriting.

**Rewrite rules (story → screenplay):**
- Format: `INT./EXT. LOCATION - TIME` slug, present-tense action, ALL-CAPS cue + dialogue. No scene numbering. No camera directions (that's `video-compose`).
- Preserve any user-quoted dialogue verbatim.
- Duration: match if stated; default 30–45s. Don't overshoot.
- Short input, longer target? Keep verbatim and ask "reads as ~Ns; extend?" — don't silently pad.

## 2. Capture — canvas note + title

ONE note. No split, no further action. Shared canvas rules live in the
project `PROJECT_AGENT.md`; all writes go through the mutator, and a PreToolUse hook
blocks direct `Write` / `Edit` on `workflow.json`.

1. `read` `./workflow.json` (read-only inspection — see if `title` is already set).
2. **Append the script note** via the mutator. Stamp `subtype: "script"` so the renderer applies the script-card chrome and `video-compose` can recognise it without label parsing:
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
4. Close with:
   ```
   Captured.
   Recommended next:
   - [x] 1. Split it into <=15s shots and extract characters/locations/voices.
   - [ ] 2. Type something else.
   ```

STOP. Do NOT proceed to §3 without an explicit user command.

## 3. Analyze — on explicit user command

**Triggers** (judge intent): "split into shots / clips", "break this up", "pull the characters / locations", "who's in this", "analyze this script", "design the characters from this script".
**Not triggers:** "what's in this", "summarize", "tell me about it" — those are read-and-reply.

When triggered:

1. **Slug** — kebab-case of the working title. Collision → suffix `-2`, `-3`.
2. **Shot splits** (≤15s each; video model caps there): read the script note's `metadata.target_duration_sec` if present; otherwise estimate before splitting. Split on natural beats (slug changes, dialogue turns, location/time changes, meaningful appearance changes). Aim for shots **as close to 15s as possible** (default ≈ `ceil(total_seconds / 15)` shots) — not rigid; sub-divide smaller when a hard cut or strong beat genuinely demands it, but don't over-fragment just because the script's own time markers say so. Pacing: ~2.5 dialogue words/sec; silent action ~3–5s. **Never rewrite when splitting** — each shot body is a verbatim slice. Each shot note carries `subtype: "shot"` so `video-compose` can locate them structurally and the canvas renders the shot-card chrome. Build ONE `addBatch` payload with N shot notes + N derived edges from the script note, and apply it in one mutator call:
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
3. **Anchor extraction** — read the shot bodies you just wrote and extract only what downstream generation needs:
   - **Characters**: recurring or visually important people/entities. Include a one-line base visual when the script gives it; otherwise list only role/name and let `image-compose` design the visual.
   - **Variants**: same character with materially different on-screen look by scene/shot: age jump, costume change, injury, disguise, transformation, wet/dirty/bloodied state if it must persist across shots. Do not create variants for transient expressions or tiny props.
   - **Locations**: distinct settings or the same setting under materially different time/weather/light when it needs a separate anchor.
   - **Voices**: speaking characters and narration/V.O.; preserve dialogue language.
   - **Missing anchors**: first character, variant, location, or voice that blocks rendering Shot 1.
4. **Parse offer** — ONE compact planning line plus a soft next step:
   > `Plan check: ~<seconds>s, <shots> shots, <N> character(s), <V> variant(s), <M> location(s), <S> voice need(s). Missing: <first blocker>.`
   If N>0, V>0, M>0, or S>0, ask with the story workflow's checkbox recommendation format:
   ```
   Recommended next:
   - [x] 1. Design the character/location anchors, then voices.
   - [ ] 2. Type something else.
   ```
   On approval, route to `image-compose` first (base character sheets, needed character variants, and location stills) with `--source-node-id <script_note_id>` so the new nodes wire back to the script. After image anchors land, route speaking/narration needs to `voice-compose`. Don't generate inside `script-compose`. Skip the offer if every count is 0.

If the user's command was narrower ("just the shots", "only characters"), do only that sub-step and skip the offer.

## 4. Revisions

**Surgical** (title still fits): update script-note body + affected shot bodies in place. Use the mutator's `updateNode` op (one call per node, or batched via `updateBatch`).
**Structural** (title no longer fits): new script note (`addNode`); old→new edge `addEdge` with `kind:"derived"`; new shot family via `addBatch` against the new script note. Leave old shots; delete only if asked (`deleteNode` cascades edges for you).
