# API Service

PAI-Pro uses one `PAI_KEY` for every media capability. Image, image pro,
video, voice, and video reference uploads all route through PAI Lite; generated
assets are mirrored back into the local project folder.

Prices below are the estimates used by the stage gate in
`server/model_registry.js`. The live PAI billing balance is the source of truth.

## Model Choices

| Capability | Generation quality | Estimated price | Best for |
|---|---|---|---|
| [`generate_image`](../server/cli/generate_image.js) | Great | $0.07 at 1K, $0.10 at 2K, $0.15 at 4K | Fast concept frames, drafts, style exploration, and lower-cost image iteration. |
| [`generate_image_pro`](../server/cli/generate_image_pro.js) | Best | $0.26 at 1K, $0.45 at 2K, $0.77 at 4K | Key art, final stills, image edits, multi-reference work, and shots that need stronger detail or rendered text. |
| [`generate_video`](../server/cli/generate_video.js) | Best | $0.08/sec at 480p, $0.20/sec at 720p, $0.44/sec at 1080p | Shot animation, image-to-video, video-to-video, and generated audio clips. |
| [`generate_voice`](../server/cli/generate_voice.js) | Great | $0.01 per 500 input characters, rounded up | Dialogue, narration, temp voice tracks, and character voice tests. |

Video calls that use reference images or clips may also preupload those assets
through `video-generation-assets`, estimated at $0.01 per reference.

## Routes

- Synchronous calls use PAI Lite `POST /api/v1/generate`.
- Video generation uses `POST /api/v1/submit`, then polls
  `GET /api/v1/task/status/:job_id`.
- The local viewer exposes `GET /models` and `POST /cost` so the UI and staged
  drafts can show the same model labels and price estimates as the CLIs.

## Credit Safety

Generation CLIs stage paid work first. A staged draft records the prompt,
options, selected model, and estimated price without contacting the provider.
The provider call happens only when the user explicitly fires the draft from the
canvas.
