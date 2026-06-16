# Video — extension prompt construction

For extending an existing canvas clip (Pattern 4). Owns continuity prefix and dependency check.

## Sub-intent decision tree

- **Forward extension (default)** — continue the action from the source clip's final frame.
- **Backward extension (prequel beat)** — generate the moment that *led into* the source. Prompt-only — no API param. Phrase as *"leading into @Video1 from a moment N seconds earlier"*.
- **Multi-clip chain (≥2 linked clips)** — triggers the sequencing rules below.
- **Script-driven chain** — render shot notes as dependent links when Sequential/Hybrid or dependency check requires continuity. Unrelated scenes can render independently. Shot note body is creative source; dialogue/VO stays verbatim.

## Slot-by-slot construction

Prefix every extension prompt with the continuity anchor:

```
Continue from @Video1 — start AFTER its final frame; do not include any frames from @Video1 in the new clip. Maintain visual continuity (same location, lighting, camera position).
```

Then write what happens next. For script-driven links, copy dialogue/VO exactly. Final audio: *"Use @Audio1 for timing, cadence, and voice. Keep the words unchanged."* Voice sample: bind to speaker as timbre anchor and add once/no-echo/no-repeat guard.

**Anti-pattern: re-describing the world.** The reference video provides composition, location, lighting, character pose; the prompt provides the *new action*.

**Anti-pattern: frame repeats.** The new clip must start after @Video1's final frame and include no frames from @Video1.

✅ "Continue from @Video1 — … . The detective lifts a folder from the desk and steps toward the door."
❌ "A detective in a dim office at night, wearing a trench coat, opens a folder on his desk and looks up." → re-describes; loses the frame anchor.

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Character image ref:** locks identity across links — the source video may drift, the explicit ref reinforces.
- **Spoken audio:** include exact dialogue/VO. Bind each line to the intended character and use `@Audio1` as final read or timbre anchor per `SKILL.md`.
- **Camera-move source:** rare — switch camera grammar mid-chain.

## What to lock vs. what to change

- **Lock at the handoff:** location, lighting, character pose, framing.
- **Change in the new clip:** the action, the camera focus, the time-of-frame.

## Why serialize

Before firing 2+ `generate_video.js` calls in one turn, run this check on each pair. **Any "yes" -> serialize.**

1. **Same location?** If clip A ends in a room and clip B opens in the same room, the geometry must match.
2. **Same subject(s) mid-action?** If a character is holding / walking / reacting at the end of A and still mid-action at the start of B, costume folds and body pose must match.
3. **Same lighting state?** Sunset, lamplight, firelight, sunrise — subtle gradients diverge between two parallel renders even with identical prompts.
4. **Narrative handoff?** Does the last beat of A literally set up the first beat of B?

If all answers are "no", parallel is fine.

Why: prompt text does not pin geometry/lighting/pose; the source video ref does. Chain immediate predecessor only to stay under video-ref aggregate cap. "Same way" after a chain means repeat chain shape, not parallel calls.

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

If scene B opens on the same platform where scene A ends, stage A first. After A lands, stage B with `--ref-source-id <video_A.id>` plus character refs and continuity prefix.

## Troubleshooting

- **Mismatched cut on the screen** — was the source video id actually passed as `--ref-source-id`? Prompt text alone does not pin the frame.
- **Echo / stutter at the start of the new clip** — frames from the reference appeared in the new render. The prompt missed the *"start after @Video1's final frame; no frames from @Video1"* direction. Re-render with the no-frame-repeat phrasing in the prefix.
- **Identity drifts between links** — character image ref needed in addition to the source video ref.
- **Duration cap exceeded** — sum of audio or video reference durations ≥15s. Trim the ref list before retry.

## Fallback branch

Extension that doesn't fit forward / backward / chain — e.g. branching from a middle frame, or generating an alternate "what if" version of the same beat: treat as a new I2V from the chosen frame of the source. Extract the frame via `ffmpeg`, add it as an `image_result` node with `canvas_mutate.js --op addNode` (pass the frame's absolute path as `tmp_path`; the `image-compose` skill's `character-sheet.md` "Upload to canvas" step shows the exact payload shape), then pass the returned `assigned.node_id` via `--ref-source-id`.
