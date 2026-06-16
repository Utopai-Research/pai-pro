---
name: story-to-video-workflow
description: >-
  Orchestrates story, script, screenplay, concept, product promo, and
  multi-shot idea work into finished video. Use first when the user asks to
  make a video from a story or script; asks what next in a story video project;
  or needs a decision spanning script splitting, image refs, voices or VO,
  video clips, render strategy, Timeline ordering, or final Timeline handoff.
  Routes execution to script-compose, image-compose, voice-compose, and
  video-compose before those skills' CLIs are used.
---

# Story-to-video workflow

## Contract

- This skill wakes first for story/script/promo-to-video work.
- Sequence the pipeline, but do not call `generate_*` directly from this skill.
- Before any execution step, load the matching capability skill for that domain.
- Recommendations are planning, not consent. Ask and stop when the next step costs money or changes the pipeline.

## Default arc

Use this as the normal story-to-video ladder. It is a guide, not a lock; the user can skip, reorder, supply refs, or ask for a rough direct render.

1. Clarify intent only when it blocks execution.
2. Capture or adapt the story/script. If the user supplied only a raw idea, route to `script-compose` to create a production-ready script before planning shots.
3. Split into <=15s shot notes with dialogue-aware timing and identify production anchors.
4. Extract characters, material character variants, detailed locations, same-location variants, and speaking/narration needs.
5. Create visual anchors for video-bound shots when they improve continuity, unless the user supplied refs or explicitly chose rough direct render.
6. Create reusable voice anchors for every speaking character and for VO/narration when present.
7. Confirm the working clip plan: shot count, durations, continuity needs, and first missing dependency.
8. Prefer straight-to-video from references. Use storyboard only when the user asks for it, the shot is hard to control without it, or storyboard frames are needed to diagnose composition.
9. For multi-clip plans, prefer hybrid dispatch: sequence dependent shots within a continuous scene, and render independent shots/scenes in parallel.
10. Render video clips.
11. Assign Timeline `shot_id` order when producing a sequence, then hand off clip order and preview to the Timeline flow.

Plan ahead internally, but only ask the next meaningful user-facing choice; the Consent and gates ladder fixes when render path and dispatch become askable.

## Skill routing

| Need | Load next |
|---|---|
| Script capture, rewrite, split, or analysis | `script-compose` |
| Character, location, storyboard, starting frame, or visual anchor | `image-compose` |
| Narration, dialogue read, character voice, or audio node | `voice-compose` |
| Clip render, continuation, audio refs, storyboard animation, or video prompt | `video-compose` |
| Scene/ref grouping or canvas layout frames | `groups-compose` |

Capability skills own CLI flags, node grammar, reference flags, and domain-specific recovery hints. `PROJECT_AGENT.md` owns the shared failure taxonomy. This workflow owns sequencing and handoff only.

## Consent and gates

- A recommended option is not consent by itself; wait for the user to answer.
- Paid video generation needs explicit user intent before staging.
- Draft-only, failed, and cancelled generations do not advance the story pipeline.
- Render path and multi-clip dispatch are later choices when the story shape is meaningful enough to decide them.
- If the user asks for a one-off generation outside the story pipeline, route directly to the matching capability skill.
- These are soft gates, not bureaucracy. If the user explicitly asks to skip anchors, storyboards, or planning and make a rough direct render, honor that choice and carry it forward.
- Keep normal collaborative checkpoints unless another explicit feature or approved workflow takes over orchestration.
- Gating ladder. Ask each rung only once the prior one is real, never off a rough beat plan: script captured, then <=15s shot notes -> anchors, user refs, or an explicit rough-direct skip -> a clip plan real enough to discuss (shot count, durations, continuity) -> render path (full askability in the Render path section) -> dispatch (multi-clip plan only). Stop after the render-path question; surface dispatch only in a later turn unless the user's reply already names a combined choice such as "straight to video + parallel".

## VO and dialogue invariants

- Spoken words live on script/shot notes and `audio_result.data.text`.
- `voice-compose` owns generating or preserving the exact spoken text.
- `audio_result.data.text` is the exact speech source of truth after voice generation.
- `video-compose` includes spoken text verbatim; Pattern 6 distinguishes final reads from timbre anchors.

## Recommendation shape

Follow the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommend one concrete next step. Add a second option only when there is a real tradeoff.

## Planning checkpoint

Before recommending refs or video from a story, inspect `workflow.json` when needed and summarize only the decision-relevant state:

- Target duration from user duration, timestamps, or a rough estimate.
- Planned shot count, with each shot intended as <=15s.
- Characters, material character variants, detailed locations, same-location variants, close/detail framing needs, and speaking/narration needs.
- First missing anchor blocking the next clip.

If the story implies more than roughly 3 minutes, recommend narrowing scope before clip planning.

After shot notes exist, if video-bound character/location/voice anchors are missing, recommend anchors as the default next step. Include base character sheets, material character variants, detailed location anchors, same-location variants, and reusable voice anchors for speakers/VO when relevant. Include a rough-direct skip option when speed matters.

After anchors are present, offer a lightweight reference review or clip-plan confirmation before render choices when the next step is still ambiguous. Keep it short. For simple single-clip projects, user-supplied refs, or an explicit rough-direct choice, keep the checkpoint small and move on.

## Render path

Ask this only after the script/shot plan is settled and either:

- video-bound character/location anchors are present,
- the user explicitly chose to skip anchors for a rough direct render,
- the user supplied usable refs, or
- the project is a simple one-off/single-clip render where anchors are not useful.

If shot notes exist but anchors are still missing and the user has not chosen rough direct render, return to the Planning checkpoint instead.

When ready and the user has not picked a path, recommend straight-to-video from references. Do not insert a storyboard step merely because shot notes exist. Ask:

Use the project manual's choice shape with:

- header: `Render`
- question: `Choose render path.`
- options:
  - label: `Straight to video (Recommended)`
    description: `Fastest path to motion.`
  - label: `Storyboard first`
    description: `Generate storyboard images first for composition control.`

For storyboard-first, load `image-compose` Pattern 6. Generate one composite mosaic per clip or <=15s shot note, not one image per panel; each mosaic should be an `image_result` with `subtype: "storyboard"`.

## Dispatch for multiple clips

Last rung of the Consent and gates ladder: render path picked and a multi-clip plan exists. Skip for one clip.

Use the project manual's choice shape with:

- header: `Dispatch`
- question: `Choose clip dispatch.`
- options: order these by the observable story signals below; suffix the first label with `(Recommended)`.
  - label: `Hybrid`
    description: `Chain within continuous scenes; render separate scenes independently.`
  - label: `Parallel`
    description: `Render all clips independently.`
  - label: `Sequential`
    description: `Each clip continues from the previous one.`

Use observable story signals:

- One continuous scene/action/state favors sequential.
- Separate scenes, time jumps, wardrobe/state changes, or montage beats favor parallel.
- Continuous clusters separated by hard cuts favor hybrid.

Do not chain video refs across location changes, time jumps, wardrobe/state changes, dream/reality breaks, or montage cuts where continuity is undesirable.

## After media results

After a terminal `generate_*` result:

1. If it is only draft-stage JSON, report the price/status and stop.
2. If `ok:false`, follow project failure handling and do not advance the pipeline.
3. If `ok:true`, identify the landed node id from the result or canvas state.
4. Read `workflow.json` if missing shots, refs, voices, clips, or reel order affect the next decision.
5. Recommend exactly one next useful filmmaking move.

Typical priority:

- Script note landed -> recommend splitting into <=15s shot notes and extracting anchors.
- Shot notes exist but anchors are missing -> recommend the first missing character/location anchor, with a rough-direct skip option. Do not ask render path or dispatch yet.
- Character/location ref landed -> recommend remaining anchors first; when anchors are ready, recommend reference review, clip-plan confirmation, or straight-to-video render path. Mention storyboard only when requested or clearly useful for control/diagnosis.
- Voice landed -> recommend using it with the matching visual ref in the next dialogue/narration clip.
- Storyboard landed -> recommend review or animating the matching clip.
- Video clip landed -> recommend the next clip, or Timeline handoff when all planned clips are ready.

## Final handoff

Timeline owns reel order. Numeric `video_result.data.shot_id` means a clip is in the reel. When all planned story clips are ready and the intended order is unambiguous, assign `shot_id = 1..N` with one `updateBatch` mutator call before handoff:

```
node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
  --op updateBatch \
  --payload-json '{"updates":[{"id":"<video_1>","patch":{"shot_id":1}},{"id":"<video_2>","patch":{"shot_id":2}}]}'
```

Do not use `generate_video.js --shot-id` for speculative or partial ordering; assign after clips land. Local export uses `reel_stitch.js` only after an explicit user request. After assignment, hand off in chat: tell the user to open the Timeline tab to inspect and preview them together.
