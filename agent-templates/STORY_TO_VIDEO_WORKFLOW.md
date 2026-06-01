# Story-to-video workflow

This manual gives the project agent a local, workable recommendation loop for moving from story/script to generated clips. It is on-demand context, not a skill. The atomic skills still own how to generate scripts, images, voices, videos, and layouts.

## Scope

Use this workflow for story-to-video sequencing when:

- The user gives a story/script, uploads one and asks you to work with it, or asks you to write/adapt one.
- The user asks "what next?" or "how do we finish this?"
- A terminal media generation result lands during story-to-video work.
- A decision spans more than one generation step, such as refs plus voices plus clips, or clip render strategy.
- The project has multiple planned shots and the next move affects clip completion.

Use it for context, sequencing, and next-step judgment. It does not authorize automatic script splitting, reference generation, or paid media generation; the user still has to approve those steps.

Do not use this workflow for ad-hoc one-off images, one-off videos, simple edits, standalone voice tests, or isolated canvas organization. The capability skills are enough for those.

Every stage has an off-ramp. If the user asks to skip ahead, redo a ref, make a poster, or generate one clip outside the story pipeline, follow the user's request with the matching atomic skill.

## The arc

Default story-to-video order:

1. Script or story note.
2. Shot notes capped at 15 seconds each.
3. Character and location references for video-bound shots.
4. Voices for speaking characters or narration.
5. Optional storyboards when composition needs a visual checkpoint.
6. Video clips for each shot.
7. Handoff to the Timeline tab for reel ordering, preview, or export when the user asks.

The workflow recommends the next step; it does not auto-run the pipeline.

## Planning checkpoint

After a script/story is captured and before recommending refs or video, make one compact checkpoint when it helps the next decision:

- Target duration: explicit user duration first; otherwise timestamp sum or a rough estimate from script length.
- Coverage: planned shot count, with every shot intended as <=15s.
- Cast and settings: recurring characters, material per-scene variants, speaking/narration needs, and important locations.
- Missing anchors: the first character, variant, location, voice, or storyboard dependency blocking the next clip.

Use this as chat guidance, not a new artifact, unless the user asks to save a note. If the story implies more than roughly 3 minutes, recommend narrowing scope before clip planning.

```text
Plan check: ~45s, 3 shots, 2 characters, 1 variant, 1 location. Missing: diner location ref.
Recommended next:
- [x] 1. Make the diner location ref before Shot 1.
- [ ] 2. Type something else.
```

## Recommendation contract

After a terminal `generate_*` result:

1. Check whether it is terminal.
   - Draft-stage JSON only: report the staged price/status and stop.
   - `ok:false`: use `PROJECT_AGENT.md` Failure handling; do not advance the pipeline.
   - `ok:true`: continue.
2. Identify the landed node id from `canvas_mutation.assigned`, `node_id`, or the result feed.
3. Read `./workflow.json` when the next step depends on missing shots, refs, voices, or clips.
4. Classify the landed node and current project state.
5. Recommend exactly one next step. Add one alternative only when the trade-off is material.
6. Stop and wait unless the user's current message already asked for that concrete action.
7. On approval, let top-level routing select the atomic skill or local CLI. This workflow does not dispatch nested skills.

Keep the visible recommendation short. When the user needs to choose or approve the next move, prefer checkbox-style Markdown as a visual affordance. It may render as checkboxes, but treat the reply as text; a checked box is not consent by itself. Example:

```text
Recommended next:
- [x] 1. Split this script into <=15s shot notes.
- [ ] 2. Type something else.

Reply `1` to proceed, or describe what you want.
```

Plain prose is fine for tiny status updates, failures, or cases where a checkbox list would add noise.

Later examples may omit the reply line for brevity; include it in real user prompts.

## Consent and gates

Recommendations are not consent. Silence is not consent. The agent's own hint is not consent. A prior generic "continue" does not answer a later render-choice question.

Ask and stop at these decision points:

- After script capture: ask whether to split into shots and extract characters/locations.
- After shot planning: ask before generating batches of refs or voices.
- Before paid video generation: stage only after explicit user intent.
- Before multi-clip render strategy: ask for render approach and dispatch unless the user already named both.
- Before final reel export: guide the user to the Timeline tab; do not stitch from this workflow.

If the user responds with a revision, apply the revision and re-present the relevant checkpoint. Do not silently reconcile conflicting state.

## Soft recommendation hints

Use observable signals. Never hard-default without a signal.

Strong signals:

- "quick", "preview", "rough" -> direct video or parallel rendering may fit.
- "polished", "consistent", "smooth", "continuous" -> sequential or hybrid may fit.
- "storyboard", "look-test", "show me first" -> storyboard-first may fit.
- Multiple scenes/locations/time jumps -> hybrid often fits.
- One continuous action scene -> sequential often fits.
- Wildly separate scenes or montage beats -> parallel often fits.
- Prior explicit user choice in this project -> carry it forward and mention it briefly.

No signal:

```text
Both paths work here: direct video gets to motion faster; storyboard-first gives a visual checkpoint before spending on video. Your call.
```

Avoid directive phrasing like "I will choose X" unless the user explicitly delegated the choice.

## Pre-render checks

Before recommending clip rendering from a story, inspect `workflow.json` and verify:

- Script note exists if the project is script-driven.
- Shot notes exist for the planned coverage, each intended as <=15s.
- Character refs exist for recurring on-screen characters.
- Location refs exist for important settings.
- Speaking characters or narration have `audio_result` voice nodes when voice matters.
- Storyboard mosaics exist if the user picked storyboard-first.
- Existing `video_result` clips align with remaining shots.
- If the user asks to order clips, preview the reel, export, or stitch, guide them to the Timeline tab instead of handling reel assembly here.

If the state is ambiguous, recommend the checkpoint rather than dispatching video:

```text
Before rendering, I need one checkpoint: Shot 1 and Shot 2 exist, but only the detective ref.
Recommended next:
- [x] 1. Make the diner location ref for Shot 1.
- [ ] 2. Type something else.
```

For scripts longer than roughly 3 minutes, call out scope before clip planning. For individual video clips, keep planned clip durations within the local video model's 15-second cap.

## Recommendation matrix

### Script or story note landed

If a `note` with `data.subtype: "script"` lands, recommend splitting it into shot notes and extracting characters/locations.

```text
Captured @note_3.
Recommended next:
- [x] 1. Split it into <=15s shot notes and extract characters/locations.
- [ ] 2. Type something else.
```

On approval, route to `script-compose`.

### Shot notes exist

If shot notes exist but video-bound character references are missing, recommend a 4-panel character reference sheet for the next recurring character.

```text
The shot notes are ready.
Recommended next:
- [x] 1. Make a 4-panel reference sheet for <Character>.
- [ ] 2. Type something else.
```

On approval, route to `image-compose`.

### Character reference landed

Priority:

1. Missing required location refs -> recommend the next location still.
2. Character speaks and lacks a voice node -> recommend voice design.
3. Refs are ready -> recommend storyboarding or rendering the first planned shot.

```text
Generated @image_5 for <Character>.
Recommended next:
- [x] 1. Create the <Location> reference before rendering Shot 1.
- [ ] 2. Type something else.
```

### Location reference landed

Priority:

1. More required locations missing -> recommend the next location.
2. Visual composition is still undecided -> recommend a storyboard mosaic.
3. User is optimizing for speed or already asked to render -> recommend direct video.

```text
Generated @image_7 for <Location>.
Recommended next:
- [x] 1. Create a 2x2 storyboard for Shot 1.
- [ ] 2. Type something else.
```

### Voice landed

Recommend using it with the matching character/image ref in the next dialogue or narration clip.

```text
Generated @audio_2.
Recommended next:
- [x] 1. Render the dialogue shot with @image_5 and @audio_2.
- [ ] 2. Type something else.
```

### Storyboard landed

Recommend animating it into the matching clip. Keep character/location refs attached when they authored the storyboard.

```text
Generated @image_9 storyboard.
Recommended next:
- [x] 1. Animate it into the matching 15s clip.
- [ ] 2. Type something else.
```

### First video clip landed

If more shot notes remain:

1. Same scene, same character state, continuous action -> recommend continuing from the previous video.
2. Scene/location/time jump -> recommend a fresh clip with refs rather than chaining.
3. Finished story coverage and user asks for ordering/export -> guide them to the Timeline tab.

```text
Generated @video_2.
Recommended next:
- [x] 1. Render Shot 3 as a continuation from @video_2.
- [ ] 2. Type something else.
```

### Timeline handoff

When the user asks to order clips, preview the reel, export, or stitch the final video, guide them to the Timeline tab. This workflow does not set `shot_id` values or run local stitching.

```text
Recommended next:
- [x] 1. Open the Timeline tab to order clips, preview the reel, or export.
- [ ] 2. Type something else.
```

## Render approach

When a story has ready shots/refs and the user has not chosen the video path, ask:

```text
Choose render path:
- [ ] 1. Go straight to video for the fastest path to motion.
- [ ] 2. Generate storyboard images first for composition control.
- [ ] 3. Type something else.

Reply `1`, `2`, or describe what you want.
```

Stop after asking. For single-clip work, this may be enough before video staging. For multi-clip work, ask Render dispatch after the user picks option 1 or 2 unless they provided a combined answer.

## Render dispatch

For multi-clip work, dispatch is separate from render approach:

```text
Choose clip dispatch:
- [ ] 1. Hybrid: chain within scenes; render separate scenes in parallel.
- [ ] 2. Parallel: render all clips independently.
- [ ] 3. Sequential: each clip continues from the previous one.
- [ ] 4. Type something else.

Reply `1`, `2`, `3`, or describe what you want.
```

Append one soft hint based on observable state, then stop. If the hint clearly recommends one row, mark that row `[x]`; otherwise leave all rows unchecked.

Interpret combined replies gracefully:

| Reply | Meaning |
|---|---|
| `1-Hybrid` | Direct video plus hybrid dispatch |
| `1-Parallel` | Direct video plus parallel dispatch |
| `1-Sequential` | Direct video plus sequential dispatch |
| `2-Hybrid` | Storyboard-first plus hybrid dispatch |
| `2-Parallel` | Storyboard-first plus parallel dispatch |
| `2-Sequential` | Storyboard-first plus sequential dispatch |

Generic "continue" at this point is ambiguous; restate the choices briefly.

## Hybrid and sequential safeguards

Sequential means the next `video_result` uses the prior `video_result` as a video ref only when the story is continuous in scene/action/state. The prompt must explicitly say it continues from the prior video; the ref alone is not enough.

Do not chain across hard narrative boundaries:

- Location change.
- Time-of-day jump.
- Wardrobe or physical-state change.
- Dream/reality/flashback boundary.
- A montage cut where continuity is undesirable.

Hybrid means chain within clusters and render clusters in parallel. Before dispatching hybrid work, state the cluster plan in user-visible language and stop for confirmation:

```text
Recommended next:
- [x] 1. Render two timelines: A Shot 1 -> Shot 2, and B Shot 3 -> Shot 4.
- [ ] 2. Type something else.
```

If the user chose Hybrid but there is only one continuous cluster, use Sequential and explain why. If every cluster has one clip, use Parallel and explain why.

Surface rough wall-clock when chaining matters: about one video-generation wait per link in the longest chain.

## Storyboard safeguards

If the user picks storyboard-first, generate one storyboard mosaic per planned clip unless the user explicitly requests another grouping. Clip count, not scene count, is the default unit. Do not collapse three scenes with eight clips into three storyboards unless the user asks for scene-level boards.

After storyboard generation completes, recommend review before video:

```text
Generated four storyboards.
Recommended next:
- [x] 1. Review them on the canvas before rendering video.
- [ ] 2. Type something else.
```

## Failure and cancellation

Failures and cancellations route to correction, not pipeline advancement. Use the canonical failure-class table in `PROJECT_AGENT.md` Failure handling.

Workflow-specific rule: after a failed or cancelled generation, do not recommend the next story stage. Explain the correction or ask whether to revise the draft, then wait. Preserve the project manual's paid-video rule: never auto-retry `generate_video.js`.

## Provider-neutral discipline

Stay provider-neutral in user-facing copy:

- Do not expose provider-routing internals.
- Do not offer a silent provider switch after failure.
- Do not use upstream state paths or tool names.
- Do not use provider wrapper syntax.
- Do not use skill names with leading punctuation; use backticked names like `image-compose`.

## User-facing voice

Good:

```text
Generated @image_8.
Recommended next:
- [x] 1. Storyboard Shot 1 for composition control.
- [ ] 2. Render the clip directly from character/location refs.
- [ ] 3. Type something else.
```

Bad:

```text
We are now in Gate 2.4-pre and need to satisfy the upstream render plan.
```

The user should see the next useful filmmaking move, not the internal decision tree.
