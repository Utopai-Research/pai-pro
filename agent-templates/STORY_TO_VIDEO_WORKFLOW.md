# Story-to-video workflow

This manual gives the project agent a local, workable recommendation loop for moving from story/script to final reel. It is on-demand context, not a skill. The atomic skills still own how to generate scripts, images, voices, videos, and layouts.

## Scope

Use this workflow for story-to-video sequencing when:

- The user gives a story/script, uploads one and asks you to work with it, or asks you to write/adapt one.
- The user asks "what next?" or "how do we finish this?"
- A terminal media generation result lands during story-to-video work.
- A decision spans more than one generation step, such as refs plus voices plus clips, or clip render strategy.
- The project has multiple planned shots and the next move affects reel completion.

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
7. Timeline reel order through numeric `video_result.data.shot_id`.
8. Local reel stitch/export with `reel_stitch.js`.

The workflow recommends the next step; it does not auto-run the pipeline.

## Recommendation contract

After a terminal `generate_*` result:

1. Check whether it is terminal.
   - Draft-stage JSON only: report the staged price/status and stop.
   - `ok:false`: use `PROJECT_AGENT.md` Failure handling; do not advance the pipeline.
   - `ok:true`: continue.
2. Identify the landed node id from `canvas_mutation.assigned`, `node_id`, or the result feed.
3. Read `./workflow.json` when the next step depends on missing shots, refs, voices, clips, or reel order.
4. Classify the landed node and current project state.
5. Recommend exactly one next step. Add one alternative only when the trade-off is material.
6. Stop and wait unless the user's current message already asked for that concrete action.
7. On approval, let top-level routing select the atomic skill or local CLI. This workflow does not dispatch nested skills.

Keep the visible recommendation short:

```text
Generated @image_5. Recommended next: make the diner location ref before Shot 1, so the clip has both character and setting anchors.
```

## Consent and gates

Recommendations are not consent. Silence is not consent. The agent's own hint is not consent. A prior generic "continue" does not answer a later render-choice question.

Ask and stop at these decision points:

- After script capture: ask whether to split into shots and extract characters/locations.
- After shot planning: ask before generating batches of refs or voices.
- Before paid video generation: stage only after explicit user intent.
- Before multi-clip render strategy: ask for render approach and dispatch unless the user already named both.
- Before final reel export: ask before stitching if reel order is unclear.

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

## Planning checkpoints

Before recommending clip rendering from a story, inspect `workflow.json` and verify:

- Script note exists if the project is script-driven.
- Shot notes exist for the planned coverage, each intended as <=15s.
- Character refs exist for recurring on-screen characters.
- Location refs exist for important settings.
- Speaking characters or narration have `audio_result` voice nodes when voice matters.
- Storyboard mosaics exist if the user picked storyboard-first.
- Existing `video_result` clips align with remaining shots.
- Timeline `shot_id` values are present only for clips the user wants in the reel.

If the state is ambiguous, recommend the checkpoint rather than dispatching video:

```text
Before rendering, I need one checkpoint: we have Shot 1 and Shot 2, but only the detective ref. Recommended next: make the diner location ref so the first clip has a setting anchor.
```

For scripts longer than roughly 3 minutes, call out scope before clip planning. For individual video clips, keep planned clip durations within the local video model's 15-second cap.

## Recommendation matrix

### Script or story note landed

If a `note` with `data.subtype: "script"` lands, recommend splitting it into shot notes and extracting characters/locations.

```text
Captured @note_3. Recommended next: split it into <=15s shot notes and pull the character/location list, because those become the anchors for references and clips.
```

On approval, route to `script-compose`.

### Shot notes exist

If shot notes exist but video-bound character references are missing, recommend a 4-panel character reference sheet for the next recurring character.

```text
The shot notes are ready. Recommended next: make a 4-panel reference sheet for <Character>, so the video model has front/profile/back/closeup identity before we render clips.
```

On approval, route to `image-compose`.

### Character reference landed

Priority:

1. Missing required location refs -> recommend the next location still.
2. Character speaks and lacks a voice node -> recommend voice design.
3. Refs are ready -> recommend storyboarding or rendering the first planned shot.

```text
Generated @image_5 for <Character>. Recommended next: create the <Location> reference before rendering Shot 1, so the first video has both identity and setting anchors.
```

### Location reference landed

Priority:

1. More required locations missing -> recommend the next location.
2. Visual composition is still undecided -> recommend a storyboard mosaic.
3. User is optimizing for speed or already asked to render -> recommend direct video.

```text
Generated @image_7 for <Location>. Recommended next: create a 2x2 storyboard for Shot 1, because the composition is still being decided before we spend on video.
```

### Voice landed

Recommend using it with the matching character/image ref in the next dialogue or narration clip.

```text
Generated @audio_2. Recommended next: render the dialogue shot with @image_5 as the character anchor and @audio_2 as the voice reference.
```

### Storyboard landed

Recommend animating it into the matching clip. Keep character/location refs attached when they authored the storyboard.

```text
Generated @image_9 storyboard. Recommended next: animate it into the matching 15s clip, keeping the character/location references attached for continuity.
```

### First video clip landed

If more shot notes remain:

1. Same scene, same character state, continuous action -> recommend continuing from the previous video.
2. Scene/location/time jump -> recommend a fresh clip with refs rather than chaining.
3. Usable final shot -> recommend adding it to the Timeline reel.

```text
Generated @video_2. Recommended next: render Shot 3 as a continuation from @video_2, because it is the same scene and the character action should carry through.
```

### Multiple clips exist

If several clips exist but few have numeric `shot_id`, recommend ordering the best clips in the Timeline before spending more.

```text
You have three rendered clips now. Recommended next: put them on the Timeline in story order and preview the reel before generating alternates.
```

### Reel is ordered

If planned clips have numeric `shot_id` values and the user wants a final file, recommend local stitching.

```text
The planned clips are on the reel. Recommended next: stitch the reel and review the exported MP4 for pacing before generating alternates.
```

On approval, run:

```bash
node "$PAI_REPO_ROOT/server/cli/reel_stitch.js"
```

## Render approach

When a story has ready shots/refs and the user has not chosen the video path, ask:

```text
How would you like to render the clips?

A. Go straight to video. Fastest path to motion; iterate through video generations.
B. Generate storyboard images first. More visual control; iterate composition before video.
Other: describe your own approach.

Reply A, B, or describe what you want.
```

Stop after asking. For single-clip work, this may be enough before video staging. For multi-clip work, ask Render dispatch after the user picks A or B unless they provided a combined answer.

## Render dispatch

For multi-clip work, dispatch is separate from render approach:

```text
How should the clips be rendered?

Hybrid - chain within scenes for continuity, render separate scenes in parallel for speed.
Parallel - render all clips independently; fastest when clips do not depend on each other.
Sequential - each clip continues from the previous one; slowest, strongest continuity.
Other - describe your own approach.

Reply Hybrid, Parallel, Sequential, or describe what you want.
```

Append one soft hint based on observable state, then stop.

Interpret combined replies gracefully:

| Reply | Meaning |
|---|---|
| `A-Hybrid` | Direct video plus hybrid dispatch |
| `A-Parallel` | Direct video plus parallel dispatch |
| `A-Sequential` | Direct video plus sequential dispatch |
| `B-Hybrid` | Storyboard-first plus hybrid dispatch |
| `B-Parallel` | Storyboard-first plus parallel dispatch |
| `B-Sequential` | Storyboard-first plus sequential dispatch |

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
I would render this as two timelines: A (diner confrontation) Shot 1 -> Shot 2, and B (alley escape) Shot 3 -> Shot 4. The two timelines render in parallel; shots within each timeline chain for continuity. OK to proceed?
```

If the user chose Hybrid but there is only one continuous cluster, use Sequential and explain why. If every cluster has one clip, use Parallel and explain why.

Surface rough wall-clock when chaining matters: about one video-generation wait per link in the longest chain.

## Storyboard safeguards

If the user picks storyboard-first, generate one storyboard mosaic per planned clip unless the user explicitly requests another grouping. Clip count, not scene count, is the default unit. Do not collapse three scenes with eight clips into three storyboards unless the user asks for scene-level boards.

After storyboard generation completes, recommend review before video:

```text
Generated four storyboards. Recommended next: review them on the canvas, then render the approved boards into videos.
```

## Reel assembly

The Timeline owns final reel membership and order through numeric `video_result.data.shot_id`.

Rules:

- Do not set `shot_id` unless the user explicitly asks for reel positions or Timeline ordering.
- If there are good clips without `shot_id`, recommend ordering them before stitching.
- If order is ambiguous, ask for the order rather than guessing.
- `reel_stitch.js` is local ffmpeg work, not paid generation.

Stitch command:

```bash
node "$PAI_REPO_ROOT/server/cli/reel_stitch.js"
```

It reads `workflow.json`, selects `video_result` nodes with numeric `shot_id`, orders by `shot_id`, and writes `reel.mp4` by default.

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
Generated @image_8. Recommended next: storyboard Shot 1 before video if you want composition control. Faster alternative: render the clip directly from the character and location refs.
```

Bad:

```text
We are now in Gate 2.4-pre and need to satisfy the upstream render plan.
```

The user should see the next useful filmmaking move, not the internal decision tree.
