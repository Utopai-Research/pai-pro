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
- Own sequencing only. Before execution, load the matching capability skill; do not call `generate_*` here.
- Recommendations are not consent. Stop before paid generation or pipeline changes unless the user explicitly approved an autonomous workflow.

## Default arc

Use this ladder unless the user skips, reorders, supplies refs, or asks for a rough direct render:

1. Clarify only blockers.
2. Raw idea/story -> `script-compose` production script; existing screenplay -> capture/adapt.
3. `script-compose` splits <=15s dialogue-aware shots and extracts characters, material variants, detailed locations/location variants, and speaker/VO needs.
4. `image-compose` creates useful visual anchors: base/variant character sheets and detailed location/detail anchors.
5. `voice-compose` creates reusable anchors for every speaker and VO/narrator.
6. Confirm shot count, durations, continuity needs, and first blocker.
7. Default render path: straight-to-video from refs. Storyboard only if requested, hard to control, or needed for diagnosis.
8. Default dispatch: hybrid. Chain continuous dependent shots; render independent scenes/shots in parallel.
9. Render clips, assign Timeline `shot_id` when sequence order is unambiguous, then hand off to Timeline.

Plan ahead internally, but only ask the next meaningful user-facing choice; the Consent and gates ladder fixes when render path and dispatch become askable.

## Skill routing

| Need | Load next |
|---|---|
| Script capture, rewrite, split, or analysis | `script-compose` |
| Character, location, storyboard, starting frame, or visual anchor | `image-compose` |
| Narration, dialogue read, character voice, or audio node | `voice-compose` |
| Clip render, continuation, audio refs, storyboard animation, or video prompt | `video-compose` |
| Scene/ref grouping or canvas layout frames | `groups-compose` |

Capability skills own CLI flags, node grammar, refs, and recovery hints. `PROJECT_AGENT.md` owns shared failure handling.

## Consent and gates

- Draft-only, failed, and cancelled generations do not advance the pipeline.
- One-off generation outside the story pipeline routes directly to the capability skill.
- Honor explicit rough-direct/skip choices.
- Gate ladder: script -> shot notes -> anchors/user refs/rough-direct -> real clip plan -> render path -> dispatch. Ask each rung only after the prior one is real; stop after render-path unless the user already names dispatch too.

## VO and dialogue invariants

- Script/shot notes carry dialogue/VO until final audio exists.
- `audio_result.data.text` is source of truth only for approved final narration/line reads.
- `video-compose` includes spoken text verbatim and treats voice samples as timbre anchors.

## Recommendation shape

Follow the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommend one concrete next step. Add a second option only when there is a real tradeoff.

## Planning checkpoint

Before recommending refs/video, inspect `workflow.json` when needed and summarize only:

- Target duration from user duration, timestamps, or a rough estimate.
- Planned <=15s shot count.
- Characters, material variants, detailed locations/location variants, close/detail needs, speakers/VO.
- First missing anchor blocking the next clip.

If the story implies more than roughly 3 minutes, recommend narrowing scope before clip planning.

After shot notes, missing video-bound character/location/voice anchors are the default next step; include a rough-direct skip when speed matters. Once anchors/user refs/rough-direct are settled, offer only a short ref review or clip-plan confirmation if ambiguity remains.

## Render path

Ask only after the script/shot plan is settled and anchors, usable refs, rough-direct, or a simple single-clip case make rendering real. If anchors are still missing, return to Planning checkpoint.

Use project choice shape:

- header: `Render`
- question: `Choose render path.`
- options:
  - label: `Straight to video (Recommended)`
    description: `Fastest path to motion.`
  - label: `Storyboard first`
    description: `Generate storyboard images first for composition control.`

For storyboard-first, load `image-compose` Pattern 6: one composite mosaic per clip/<=15s shot note, subtype `storyboard`.

## Dispatch for multiple clips

Ask only after render path is picked and a multi-clip plan exists. Skip for one clip. Use project choice shape:

- header: `Dispatch`
- question: `Choose clip dispatch.`
- options: order these by the observable story signals below; suffix the first label with `(Recommended)`.
  - label: `Hybrid`
    description: `Chain within continuous scenes; render separate scenes independently.`
  - label: `Parallel`
    description: `Render all clips independently.`
  - label: `Sequential`
    description: `Each clip continues from the previous one.`

Signals: continuous scene/action/state -> sequential; separate scenes/time jumps/wardrobe changes/montage -> parallel; continuous clusters separated by hard cuts -> hybrid. Do not chain video refs across location, time, wardrobe/state, dream/reality, or montage breaks.

## After media results

After terminal `generate_*`:

1. If it is only draft-stage JSON, report the price/status and stop.
2. If `ok:false`, follow project failure handling and do not advance the pipeline.
3. If `ok:true`, identify the landed node id from the result or canvas state.
4. Read `workflow.json` if shots, refs, voices, clips, or reel order affect the next decision.
5. Recommend exactly one next useful filmmaking move.

Typical priority:

- Script note landed -> recommend splitting into <=15s shot notes and extracting anchors.
- Shot notes exist but anchors are missing -> recommend the first missing character/location anchor, with a rough-direct skip option. Do not ask render path or dispatch yet.
- Character/location ref landed -> finish remaining anchors; then ref review, clip-plan confirmation, or straight-to-video. Mention storyboard only if requested/useful.
- Voice landed -> recommend using it with the matching visual ref in the next dialogue/narration clip.
- Storyboard landed -> recommend review or animating the matching clip.
- Video clip landed -> recommend the next clip, or Timeline handoff when all planned clips are ready.

## Final handoff

Timeline owns reel order. Numeric `video_result.data.shot_id` means a clip is in the reel. When all planned story clips are ready and order is unambiguous, assign `shot_id = 1..N` with one `updateBatch` before handoff:

```
node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
  --op updateBatch \
  --payload-json '{"updates":[{"id":"<video_1>","patch":{"shot_id":1}},{"id":"<video_2>","patch":{"shot_id":2}}]}'
```

Do not use `generate_video.js --shot-id` for speculative/partial ordering. Assign after clips land. Local export uses `reel_stitch.js` only on explicit request. Then tell the user to open Timeline to inspect and preview.
