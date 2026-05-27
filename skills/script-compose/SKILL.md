---
name: script-compose
description: Handles screenplay work on the filmmaking canvas, only on explicit user intent (never on a file drop). Triages input as an official screenplay (use verbatim), a story or concept (iterate then rewrite at the target duration), or neither (defer to image/video skills). Captures the finalized script as a canvas note and sets the workflow title. Separately, on an explicit user command, splits the script into shot notes capped at 15 seconds each and offers to design character portraits plus location stills. Use when the user asks to write, adapt, or rewrite a script, story, or screenplay; to split a script into shots or clips; to extract or design characters or locations from a script; or to analyze or break down a canvas script. Preserves dialogue verbatim. Does NOT split or analyze without explicit user intent.
---

Run only on explicit user intent — never on a file drop. If the user just dropped a script, the bridge already wrote a filename-reference note; do nothing more until they ask.

Director defaults: a 30s beat is ONE moment; trust silence; match the user's input language.

## 1. Triage → Capture

Classify the input, then capture as in §2. Never skip straight to §3.

- **Screenplay** (INT./EXT. + ALL-CAPS cues + dialogue) → use **verbatim**. For a dropped file, `read` `./uploads/<filename>` first. Pick a 2–5 word title in the user's language (use the script's own if present).
- **Story / concept** (prose, pitch, logline) → sketch ONE paragraph back (setting, characters, conflict, duration) and ask if it's the shape. Iterate. On "yes/go", rewrite using the rules below, then capture.
- **Neither** → don't run; defer to `image-compose` / `video-compose`.

Torn between screenplay and story? Prefer screenplay — safer than rewriting.

**Rewrite rules (story → screenplay):**
- Format: `INT./EXT. LOCATION - TIME` slug, present-tense action, ALL-CAPS cue + dialogue. No scene numbering. No camera directions (that's `video-compose`).
- Preserve any user-quoted dialogue verbatim.
- Duration: match if stated; default 30–45s. Don't overshoot.
- Short input, longer target? Keep verbatim and ask "reads as ~Ns; extend?" — don't silently pad.

## 2. Capture — canvas note + title

ONE note. No split, no further action. Shared canvas rules live in the
project `AGENTS.md`; all writes go through the mutator, and a PreToolUse hook
blocks direct `Write` / `Edit` on `workflow.json`.

1. `read` `./workflow.json` (read-only inspection — see if `title` is already set).
2. **Append the script note** via the mutator. Stamp `subtype: "script"` so the renderer applies the script-card chrome and `video-compose` can recognise it without label parsing:
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addNode \
     --payload-json '{"node":{"type":"note","data":{"subtype":"script","label":"Script: <title>","body":"<full screenplay verbatim>","metadata":{"author":"agent","timestamp":"<ISO>"}}}}'
   ```
   Stdout returns `assigned.node_id` — keep it for §3 (shots derive from this id).
3. **Set the workflow title if empty:**
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" --op setTitle --payload-json '{"title":"<title>"}'
   ```
4. Close with: `Captured. Want me to split it into ≤15s shots and pull out the characters / locations?`

STOP. Do NOT proceed to §3 without an explicit user command.

## 3. Analyze — on explicit user command

**Triggers** (judge intent): "split into shots / clips", "break this up", "pull the characters / locations", "who's in this", "analyze this script", "design the characters from this script".
**Not triggers:** "what's in this", "summarize", "tell me about it" — those are read-and-reply.

When triggered:

1. **Slug** — kebab-case of the working title. Collision → suffix `-2`, `-3`.
2. **Shot splits** (≤15s each; video model caps there): split on natural beats (slug changes, dialogue turns). Aim for shots **as close to 15s as possible** (default ≈ `ceil(total_seconds / 15)` shots) — not rigid; sub-divide smaller when a hard cut or strong beat genuinely demands it, but don't over-fragment just because the script's own time markers say so. Pacing: ~2.5 dialogue words/sec; silent action ~3–5s. **Never rewrite when splitting** — each shot body is a verbatim slice. Each shot note carries `subtype: "shot"` so `video-compose` can locate them structurally and the canvas renders the shot-card chrome. Build ONE `addBatch` payload with N shot notes + N derived edges from the script note, and apply it in one mutator call:
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
3. **Parse offer** — ONE chat line:
   > `I see <N> character(s) (<names>) and <M> location(s) (<names>). Want me to design them?`
   Skip if N=0 AND M=0. On "yes", route to `image-compose` (one character portrait + one location still per name) with `--source-node-id <script_note_id>` so the new node wires back to the script. Don't generate here.

If the user's command was narrower ("just the shots", "only characters"), do only that sub-step and skip the offer.

## 4. Revisions

**Surgical** (title still fits): update script-note body + affected shot bodies in place. Use the mutator's `updateNode` op (one call per node, or batched via `updateBatch`).
**Structural** (title no longer fits): new script note (`addNode`); old→new edge `addEdge` with `kind:"derived"`; new shot family via `addBatch` against the new script note. Leave old shots; delete only if asked (`deleteNode` cascades the edges + group memberships for you).
