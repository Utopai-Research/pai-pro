# Video — extension prompt construction

For extending an existing canvas clip (Pattern 4). Owns continuity prefix and dependency check.

## Sub-intent decision tree

- **Forward extension (default)** — the next beat after the source clip; the boundary defaults to a hard cut to a new angle (see Slot-by-slot construction).
- **Backward extension (prequel beat)** — generate the moment that *led into* the source. Prompt-only — no API param. Phrase as *"leading into @Video1 from a moment N seconds earlier"*.
- **Multi-clip chain (≥2 linked clips)** — triggers the sequencing rules below.
- **Script-driven chain** — render shot notes as dependent links when Sequential/Hybrid or dependency check requires continuity. Unrelated scenes can render independently. Shot note body is creative source; dialogue/VO stays verbatim.

## Slot-by-slot construction

**First, check total length.** If the whole sequence fits within the 15s single-render convention, do NOT chain two clips — render it as ONE multi-shot clip (Pattern 7 / [`video-multi-shot.md`](video-multi-shot.md)) with the cuts inside one render. No two-clip handoff means no boundary to morph. Chain (below) only when the total exceeds 15s.

**Default boundary between chained clips = HARD CUT.** Open clip 2 on a NEW camera angle of the same scene and character. Prefix:

```
Hard cut from @Video1: open on a NEW camera angle of the same scene and character. Do NOT match or continue @Video1's final frame; begin cleanly on the new shot. Keep world continuity (location, lighting, wardrobe) and identity via the character image ref — not by matching the previous frame.
```

**Why hard cut is the default (stated once here; other files refer back):** a same-shot continuation forces the model to reconstruct @Video1's exact final frame and roll forward on the same lens. It can't reproduce that frame pixel-perfectly, so the first ~0.3s morphs/warps — the seam. A hard cut owes nothing to the previous frame: nothing to match, no seam, even under heavy motion. Tradeoff — the cut discards the frame that was anchoring identity, so the **character image ref is mandatory** (see Adjacent roles). Note: seam-clean ≠ reads-as-continuous, which is why a true oner stays same-shot (exception ii below).

**Same-shot continuation (continue on the SAME camera) is the exception** — use it only when one holds, each judged from intent you control, not from guessing how clip 1 will render:
- **(i) authored held beat** — you deliberately wrote clip 1 to END on a pause/settle/freeze, and clip 2 opens from that held pose;
- **(ii) story-required oner** — script/user wants one unbroken motion (a continuous push-in, a strike read as ONE move) that an edit cut would break; prefer one ≤15s clip, same-shot chain only if >15s;
- **(iii) explicit user request** for a continuous / same-shot / single-take handoff — honor it directly; warn once that a mid-motion same-shot may seam, then proceed.

Same-shot prefix (legacy): *"Continue from @Video1 — start AFTER its final frame; no frames from @Video1. Maintain visual continuity (same location, lighting, camera position)."*

Then write what happens next. For script-driven links, copy dialogue/VO exactly. Final audio: *"Use @Audio1 for timing, cadence, and voice. Keep the words unchanged."* Voice sample: bind to speaker as timbre anchor and add once/no-echo/no-repeat guard.

**Anti-pattern: re-describing the world.** The reference video provides composition, location, lighting, character pose; the prompt provides the *new action*.

**Anti-pattern: frame repeats.** The new clip must start after @Video1's final frame and include no frames from @Video1.

✅ "Hard cut from @Video1 — new low angle of the same office. The detective (the character in @Image1) lifts a folder from the desk and steps toward the door."
❌ "A detective in a dim office at night, wearing a trench coat, opens a folder on his desk and looks up." → re-describes the world from scratch; leans on neither the source clip nor the char ref.

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Character image ref:** **mandatory under the hard-cut default** — the cut discards the previous frame that anchored identity, so identity rides entirely on this ref. For high-motion / high-emotion beats (where identity drifts most — e.g. a shout scored 26/40 in testing), anchor with a strong 4-panel character sheet: see image-compose's [`character-sheet.md`](../../image-compose/references/character-sheet.md).
- **Spoken audio:** include exact dialogue/VO. Bind each line to the intended character and use `@Audio1` as final read or timbre anchor per `SKILL.md`.
- **Camera-move source:** rare — switch camera grammar mid-chain.

## What to lock vs. what to change

- **Hard cut (default):** lock location, lighting, wardrobe, and identity (via the char ref); CHANGE the camera angle/framing and the action. Do not try to match the previous camera or pose.
- **Same-shot (exception):** lock location, lighting, character pose, framing; change only the action and time-of-frame.

## Why serialize

Before firing 2+ `generate_video.js` calls in one turn, run this check on each pair. **Any "yes" -> serialize.**

1. **Same location?** If clip A ends in a room and clip B opens in the same room, the geometry must match.
2. **Same subject(s) mid-action?** If a character is holding / walking / reacting at the end of A and still mid-action at the start of B, costume folds and body pose must match.
3. **Same lighting state?** Sunset, lamplight, firelight, sunrise — subtle gradients diverge between two parallel renders even with identical prompts.
4. **Narrative handoff?** Does the last beat of A literally set up the first beat of B?

If all answers are "no" for a given pair (two unrelated scenes), parallel is fine. Most scenes in a story chain — default to serial.

**Why the check exists:**

- **Prompt-independence ≠ creative independence.** B's prompt may be writable without reading A's output, but B's rendered geometry / lighting / subject pose depends on A's actual final frame. If A doesn't exist yet, you can't pin B to it.
- **Prompt text alone does not pin the frame.** The continuity prefix shapes description; the frame-level pin comes from the attached `--ref-source-id` to the source video. Without it, the model renders something that *describes* the same room but doesn't *match* it pixel-wise.
- **15s aggregate video-ref cap.** A clip can't reference two 10s predecessors at once — their combined 20s breaches the cap. Chain instead: each link references only its immediate predecessor (one 10s ref, under the cap).
- **"Same way" = chain shape.** When the user says "do the next N scenes the same way" after a chain, the structure being repeated is the chain itself, not the per-call shape. Don't collapse "same way" into firing parallel calls.

## How staged serialization runs

With the draft gate, sequence through user-fired results:

1. Stage clip A and stop. Do not stage clip B in the same turn when B depends on A's actual output.
2. After the user fires A and comes back, resolve A via the project `PROJECT_AGENT.md` § "Choosing context".
3. Stage clip B with `--ref-source-id <video_A.id>`. Repeat for each dependent link.

User can interrupt between links. For long chains, surface total wall-clock/cost upfront.

## Long sequences — surface cost upfront

For ≥4 linked clips, serial rendering adds roughly one render wait per clip. Surface total wall-clock/cost before starting.

## Exception — explicit parallel drafts

"Alternate takes" / "three looks for this shot" are independent by design. Parallelize and name the exception.

## Worked example — two consecutive scenes

Scene A ends with a traveler stepping off a train onto a platform. Scene B opens on the same platform with a station attendant noticing the new arrival.

**Bad (parallel):**
- Same turn: two `generate_video.js` calls — one for scene A, one for scene B with `--ref-source-id <traveler.id> --ref-source-id <attendant.id>`.
- Scene B's prompt names the platform but has no frame anchor from scene A. Mismatched cut.

**Good (serial):**
- Step 1: stage `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "<scene A prompt>" --ref-source-id <traveler.id>` and wait for the user to fire it.
- Step 2: after A lands, resolve `video_A.id`, then stage `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "<scene B prompt>" --ref-source-id <traveler.id> --ref-source-id <attendant.id> --ref-source-id <video_A.id>`. Prefix (hard-cut handoff to a new subject's angle): *"Hard cut from @Video1: cut to the station attendant's angle on the same platform at dusk. The character in @Image1 is the traveler (just off the train); the character in @Image2 is the attendant noticing the new arrival from the booth. Keep location/lighting continuity via the refs, not by matching @Video1's final frame. …"*.

## Troubleshooting

- **A clean angle change at the boundary is the intended hard-cut default** (see Slot-by-slot construction), not a defect. What needs fixing is a morph/warp/settle at a *same-shot* boundary — switch that boundary to a hard cut.
- **Mismatched cut on the screen** (same-shot links) — was the source video id actually passed as `--ref-source-id`? Prompt text alone does not pin the frame.
- **Echo / stutter at the start of the new clip** — frames from the reference appeared in the new render. The prompt missed the *"start after @Video1's final frame; no frames from @Video1"* direction. Re-render with the no-frame-repeat phrasing in the prefix.
- **Identity drifts between links** — under the hard-cut default the cut discards the frame that anchored identity, so the character image ref is mandatory; for high-motion / high-emotion beats use a 4-panel character sheet (see Adjacent roles).
- **Duration cap exceeded** — sum of audio or video reference durations ≥15s. Trim the ref list before retry.

## Fallback branch

Extension that doesn't fit forward / backward / chain — e.g. branching from a middle frame, or generating an alternate "what if" version of the same beat: treat as a new I2V from the chosen frame of the source. Extract the frame via `ffmpeg`, add it as an `image_result` node with `canvas_mutate.js --op addNode` (pass the frame's absolute path as `tmp_path`; the `image-compose` skill's `character-sheet.md` "Upload to canvas" step shows the exact payload shape), then pass the returned `assigned.node_id` via `--ref-source-id`.
