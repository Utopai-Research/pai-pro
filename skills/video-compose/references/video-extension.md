# Video — extension prompt construction

For extending an existing canvas clip (Pattern 4). This file owns the continuity prefix and dependency check. Execution still follows AGENTS.md § "Draft gate" and § "Choosing context".

## Contents

- Sub-intent decision tree
- Slot-by-slot construction
- Adjacent roles
- What to lock vs. what to change
- Why serialize
- How staged serialization runs
- Long sequences — surface cost upfront
- Exception — explicit parallel drafts
- Worked example
- Troubleshooting
- Fallback branch

## Sub-intent decision tree

- **Forward extension (default)** — continue the action from the source clip's final frame.
- **Backward extension (prequel beat)** — generate the moment that *led into* the source. Prompt-only — no API param. Phrase as *"leading into @Video1 from a moment N seconds earlier"*.
- **Multi-clip chain (≥2 linked clips)** — triggers the sequencing rules below.
- **Script-driven chain** — render a script (with shot notes from `script-compose`) whose total duration >15s; each link renders one or more shot notes; sequencing rules below apply. The shot note's body is the creative source; the prompt itself is built from the slot rules below.

## Slot-by-slot construction

Prefix every extension prompt with the continuity anchor:

```
Continue from @Video1 — start AFTER its final frame; do not include any frames from @Video1 in the new clip. Maintain visual continuity (same location, lighting, camera position).
```

Then write what happens next, in plain language.

**Anti-pattern: re-describing the world.** The reference video provides composition, location, lighting, character pose; the prompt provides the *new action*.

**Anti-pattern: frame repeats.** The new clip must not contain any frames from @Video1 — that produces a visible echo / stutter (the same beats play twice across the cut). The continuity prefix anchors the world; the action begins *after* the reference's final frame. If the prompt is missing the "start AFTER its final frame" direction, the model will sometimes ingest tail frames of the reference into the head of the new render — that's the failure mode.

✅ "Continue from @Video1 — … . The detective lifts a folder from the desk and steps toward the door."
❌ "A detective in a dim office at night, wearing a trench coat, opens a folder on his desk and looks up." → re-describes; loses the frame anchor.

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Character image ref:** locks identity across links — the source video may drift, the explicit ref reinforces.
- **Voice timbre:** extend voice from the prior clip with the same `@Audio1`.
- **Camera-move source:** rare — switch camera grammar mid-chain.

## What to lock vs. what to change

- **Lock at the handoff:** location, lighting, character pose, framing.
- **Change in the new clip:** the action, the camera focus, the time-of-frame.

## Why serialize

Before firing two or more `generate_video.js` calls in one turn, run this dependency check on each pair. **Any "yes" → serialize.**

1. **Same location?** If clip A ends in a room and clip B opens in the same room, the geometry must match.
2. **Same subject(s) mid-action?** If a character is holding / walking / reacting at the end of A and still mid-action at the start of B, costume folds and body pose must match.
3. **Same lighting state?** Sunset, lamplight, firelight, sunrise — subtle gradients diverge between two parallel renders even with identical prompts.
4. **Narrative handoff?** Does the last beat of A literally set up the first beat of B?

If every answer is "no" for a given pair (two unrelated scenes), parallel is fine. Most scenes in a story chain — default to serial.

**Why the check exists:**

- **Prompt-independence ≠ creative independence.** B's prompt may be writable without reading A's output, but B's rendered geometry / lighting / subject pose depends on A's actual final frame. If A doesn't exist yet, you can't pin B to it.
- **Prompt text alone does not pin the frame.** The continuity prefix shapes description; the frame-level pin comes from the attached `--ref-source-id` to the source video. Without it, the model renders something that *describes* the same room but doesn't *match* it pixel-wise.
- **<15s reference cap.** Two consecutive 10s clips can't be parallelized via shared refs — combined ref length is 20s, over the cap. Serialize: render A first, then pass A's id to B (10s <15s ✓).
- **"Same way" = chain shape.** When the user says "do the next N scenes the same way" after a chain, the structure being repeated is the chain itself, not the per-call shape. Don't collapse "same way" into firing parallel calls.

## How staged serialization runs

Each fired `generate_video.js` job takes 2–4 min wall-clock. With the draft gate, sequence through user-fired results:

1. Stage clip A and stop. Do not stage clip B in the same turn when B depends on A's actual output.
2. After the user fires A and comes back, resolve A via AGENTS.md § "Choosing context".
3. Stage clip B with `--ref-source-id <video_A.id>`. Repeat for each dependent link.

The user can interrupt with new instructions between links. For long chains, surface the total wall-clock cost upfront (see "Long sequences" below).

## Long sequences — surface cost upfront

For a long chain (≥4 linked clips), serial rendering adds ~3 min wall-clock per clip — that's 15–20 min of real time for a 6-scene sequence. Each clip's render is backgrounded, so the chat stays responsive, but the next clip can't start until its predecessor finishes (the prompt depends on the predecessor's output URL). Surface upfront: *"This is a 6-clip chain — each renders ~3 min in the background, so the whole sequence takes 15–20 min end-to-end. You'll see each scene appear on the canvas as it lands. Ping me if any pair could run as independent drafts."*

## Exception — explicit parallel drafts

"Render two alternate takes of scene 3" or "give me three looks for this shot" — the clips are creatively independent by design. Parallelize. Name the exception; default otherwise is sequential for anything scene-like.

## Worked example — two consecutive scenes

Scene A ends with a traveler stepping off a train onto a platform. Scene B opens on the same platform with a station attendant noticing the new arrival.

**Bad (parallel):**
- Same turn: two `generate_video.js` calls — one for scene A, one for scene B with `--ref-source-id <traveler.id> --ref-source-id <attendant.id>`.
- Scene B's prompt names the platform but has no frame anchor from scene A. Mismatched cut.

**Good (serial):**
- Step 1: stage `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "<scene A prompt>" --ref-source-id <traveler.id>` and wait for the user to fire it.
- Step 2: after A lands, resolve `video_A.id`, then stage `node "$PAI_REPO_ROOT/server/cli/generate_video.js" --prompt "<scene B prompt>" --ref-source-id <traveler.id> --ref-source-id <attendant.id> --ref-source-id <video_A.id>`. Prefix: *"Continue from @Video1 — maintain visual continuity with the final frame (platform at dusk, traveler mid-stride stepping off the train). The character in @Image1 is the traveler; the character in @Image2 is the attendant watching from the booth. …"*.

## Troubleshooting

- **Mismatched cut on the screen** — was the source video id actually passed as `--ref-source-id`? Prompt text alone does not pin the frame.
- **Echo / stutter at the start of the new clip** — frames from the reference appeared in the new render. The prompt missed the *"start after @Video1's final frame; no frames from @Video1"* direction. Re-render with the no-frame-repeat phrasing in the prefix.
- **Identity drifts between links** — character image ref needed in addition to the source video ref.
- **Duration cap exceeded** — sum of audio or video reference durations ≥15s. Trim the ref list before retry.

## Fallback branch

Extension that doesn't fit forward / backward / chain — e.g. branching from a middle frame, or generating an alternate "what if" version of the same beat: treat as a new I2V from the chosen frame of the source. Extract the frame via `ffmpeg`, drag-drop or upload the frame onto the canvas (so it becomes an `image_result` reference node), then pass that node's id via `--ref-source-id`.
