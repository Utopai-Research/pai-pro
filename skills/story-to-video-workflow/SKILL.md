---
name: story-to-video-workflow
description: >-
  Orchestrates story, script, screenplay, concept, product promo, and
  multi-shot idea work into finished video. Use first when the user asks to
  make a video from a story or script; asks what next in a story video project;
  or needs a decision spanning script splitting, image refs, voices or VO,
  video clips, render strategy, Timeline ordering, or final reel handoff.
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

1. Capture or adapt the story/script.
2. Split into shot notes, each intended to fit the local video duration cap.
3. Create character and location anchors for video-bound shots.
4. Create voices for speaking characters or narration when voice matters.
5. Optionally create storyboard mosaics when the user wants a visual checkpoint.
6. Render video clips.
7. Hand off clip order, preview, and local export to the Timeline/reel flow.

## Skill routing

| Need | Load next |
|---|---|
| Script capture, rewrite, split, or analysis | `script-compose` |
| Character, location, storyboard, starting frame, or visual anchor | `image-compose` |
| Narration, dialogue read, character voice, or audio node | `voice-compose` |
| Clip render, continuation, audio refs, storyboard animation, or video prompt | `video-compose` |
| Scene/ref grouping or canvas layout frames | `groups-compose` |

Capability skills own CLI flags, node grammar, reference flags, and failure recovery. This workflow owns sequencing and handoff only.

## Consent and gates

- A recommended option is not consent by itself; wait for the user to answer.
- Paid video generation needs explicit user intent before staging.
- Draft-only, failed, and cancelled generations do not advance the story pipeline.
- Render path and multi-clip dispatch are separate choices when multiple clips are planned.
- If the user asks for a one-off generation outside the story pipeline, route directly to the matching capability skill.

## VO and dialogue invariants

- Spoken words live on script/shot notes and `audio_result.data.text`.
- `voice-compose` owns generating or preserving the exact spoken text.
- `audio_result.data.text` is the exact speech source of truth after voice generation.
- `video-compose` should include spoken text verbatim in the video prompt and use audio nodes for timing, cadence, and voice. It should not rewrite, paraphrase, or invent dialogue when an audio node already carries the speech.
- For off-screen narration, use wording like: `V.O. says exactly: "...". Use @Audio1 for narration timing, cadence, and voice. Visuals should pace to the narration. Do not render captions or on-screen transcript text.`
- For on-screen dialogue with a character image, use wording like: `The character in @Image1 says exactly: "...". Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`

## Recommendation shape

Follow the project `PROJECT_AGENT.md` § "Recommendation and choice shape". Recommend one concrete next step. Add a second option only when there is a real tradeoff.

## Planning checkpoint

Before recommending refs or video from a story, inspect `workflow.json` when needed and summarize only the decision-relevant state:

- Target duration from user duration, timestamps, or a rough estimate.
- Planned shot count, with each shot intended as <=15s.
- Characters, material variants, locations, and speaking/narration needs.
- First missing anchor blocking the next clip.

If the story implies more than roughly 3 minutes, recommend narrowing scope before clip planning.

## Render path

When shots/refs are ready and the user has not picked a path, ask:

Use the project manual's choice shape with:

- header: `Render`
- question: `Choose render path.`
- options:
  - label: `Straight to video (Recommended)`
    description: `Fastest path to motion.`
  - label: `Storyboard first`
    description: `Generate storyboard images first for composition control.`

Fallback text if native UI is unavailable:

```text
Choose render path:
1. Go straight to video for the fastest path to motion. (recommended)
2. Generate storyboard images first for composition control.
3. Type something else.

Reply `1`, `2`, or describe what you want.
```

For storyboard-first, load `image-compose` Pattern 6. Generate one composite mosaic per clip or <=15s shot note, not one image per panel; each mosaic should be an `image_result` with `subtype: "storyboard"`.

## Dispatch for multiple clips

Ask dispatch separately from render path unless the user already chose both.

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

Fallback text if native UI is unavailable, after ordering the recommended option first:

```text
Choose clip dispatch:
1. Hybrid: chain within continuous scenes; render separate scenes independently. (recommended)
2. Parallel: render all clips independently.
3. Sequential: each clip continues from the previous one.
4. Type something else.

Reply `1`, `2`, `3`, or describe what you want.
```

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
- Shot notes exist but anchors are missing -> recommend the first missing character/location anchor.
- Character/location ref landed -> recommend remaining anchors, voice, storyboard, or first clip.
- Voice landed -> recommend using it with the matching visual ref in the next dialogue/narration clip.
- Storyboard landed -> recommend review or animating the matching clip.
- Video clip landed -> recommend the next clip or Timeline handoff if story coverage is complete.

## Final handoff

Timeline owns reel order. Numeric `video_result.data.shot_id` means a clip is in the reel. Use `reel_stitch.js` only after explicit user request for local export; otherwise guide the user to the Timeline tab for ordering, preview, and export.
