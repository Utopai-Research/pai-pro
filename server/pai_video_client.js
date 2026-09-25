// PAI raw passthrough → video-generation (2.0) / video-generation-25
// (2.5, dispatched asynchronously by the backend).
//
// Which of the two a call submits against is decided by ONE thing: the
// `modelId` the caller hands in, which generate_video.js resolves from its
// --version flag through the model registry. There is no second string in
// this file to keep in sync — that split is what used to make it possible to
// price one version and render the other.
//
// The wire payload is forwarded byte-for-byte to the upstream model, so
// the `content[]` parts (with role: reference_image / reference_audio /
// reference_video) and the top-level keys (`ratio`, `duration`,
// `resolution`, `watermark`, `generate_audio`) read as the upstream
// model expects them.
//
// Reference: raw-models.md § "video-generation".
//
// Two exported functions split the submit / poll flow:
//
//   submitVideo({ ... })       → POST /api/v1/submit, returns { taskId, raw }
//   pollVideo(taskId, opts)    → polls /api/v1/task/status/{id} to terminal,
//                                returns { videoUrl, raw, durationSeconds }
//
// The resolved MP4 is fetched by the caller (generate_video.js) via
// local_mirror.js's streamUrlToTmp, which streams the body straight to
// disk instead of buffering tens of MB per clip in RAM.

import { callSubmit, pollStatus, err } from "./pai_client.js";
import { getDefault, getModel } from "./model_registry.js";

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60_000; // 30 min per PAI docs recommendation

// Video model endpoint alias forwarded inside payload.model — 2.0 only.
//
// 2.5 must NOT carry it. That route reaches the provider through a dispatcher whose adapter
// rejects a payload.model outright ("payload.model is not accepted; the
// dispatcher
// selects the vendor model") — and rejects it AFTER every reference has been
// uploaded and the credits frozen, arriving as an async FAILED minutes later
// rather than as a submit error.
//
// The comment that used to sit here said "PAI never remaps this". That was
// already untrue for 2.0: the backend rewrites this alias to a vendor endpoint
// id in its preprocess hook, so it is not carried forward.
const PAI_VIDEO_ENDPOINT_ID = "pai-pro-video-endpoint-01";

// A reference reaches the upstream as either an `asset://<id>` — an id minted
// by a PRE-UPLOAD this client did — or as a plain public URL the upstream
// fetches itself.
//
// 🔴 WHICH ONE IS NOT COSMETIC: AN ASSET ID BELONGS TO ONE VENDOR.
//
// A pre-uploaded id is minted in one vendor's asset namespace and is
// meaningless in any other. The upstream routes a render across more than one
// vendor, and it forwards an `asset://` through untouched — it only uploads
// references that arrive as public URLs, and only then to the vendor it
// actually picked. So a pre-uploaded id is correct exactly when the render
// happens to land on the vendor that minted it, and is an unresolvable
// reference otherwise. That failure is classified as bad caller input, which
// does not rotate vendors: it is terminal, not retried elsewhere.
//
// Passing the public URL hands the vendor choice back to the side that makes
// it, which is the only arrangement where references and render cannot
// disagree. So: 2.5 ships URLs, and 2.0 still ships ids because its route
// does not upload for us — see the call site in cli/generate_video.js.
function buildContent({ prompt, imageRefs, audioRefs, videoRefs }) {
  const content = [{ type: "text", text: String(prompt) }];
  const push = (refs, type, role) => {
    for (const ref of refs) {
      const url = typeof ref === "string" && ref.startsWith("http") ? ref : `asset://${ref}`;
      content.push({ type, [type]: { url }, role });
    }
  };
  push(imageRefs, "image_url", "reference_image");
  push(audioRefs, "audio_url", "reference_audio");
  push(videoRefs, "video_url", "reference_video");
  return content;
}

/**
 * Submit a video generation task. Returns immediately with a job id.
 *
 * @param {Object}    opts
 * @param {string}    opts.prompt
 * @param {string}    [opts.modelId]           registry id; decides the wire
 *                                             model AND the payload shape.
 *                                             Defaults to the 2.0 entry.
 * @param {number}    [opts.duration=15]
 * @param {string}    [opts.aspectRatio="16:9"]
 * @param {string}    [opts.resolution="720p"]
 * @param {boolean}   [opts.generateAudio=true]
 * @param {number}    [opts.billedDurationSec] required on 2.5: output seconds
 *                                             + reference-video seconds, the
 *                                             dimension its price is keyed on
 * @param {string[]}  [opts.imageRefs=[]]       asset ids from a prior
 *                                             uploadReferences(), or public
 *                                             URLs for the upstream to fetch
 *                                             itself — see buildContent
 * @param {string[]}  [opts.audioRefs=[]]
 * @param {string[]}  [opts.videoRefs=[]]
 *
 * @returns {Promise<{ taskId: string, raw: object }>}
 *
 * @throws  classified Error (.klass): bad_args / rate_limited / infra /
 *          transient / transient_exhausted
 */
export async function submitVideo({
  prompt,
  modelId = getDefault("video").id,
  duration = 15,
  aspectRatio = "16:9",
  resolution = "720p",
  generateAudio = true,
  billedDurationSec = null,
  imageRefs = [],
  audioRefs = [],
  videoRefs = [],
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "submitVideo: empty prompt");
  }
  const model = getModel(modelId);
  if (!model) throw err("bad_args", `submitVideo: unknown model "${modelId}"`);
  const isV25 = model.api_version === "2.5";

  // 2.5 has SIX pricing rows and no fallback row, by design: a submit with no
  // billed duration has no price at all and 400s server-side. Refusing here
  // makes that a local failure instead of a round trip, and it is also the
  // only guard against sending 2.5 a number nobody measured.
  if (isV25 && !Number.isInteger(billedDurationSec)) {
    throw err(
      "bad_args",
      "submitVideo: 2.5 requires an integer billedDurationSec (output seconds + reference-video seconds)",
    );
  }

  const payload = {
    // 2.0 only — see PAI_VIDEO_ENDPOINT_ID above.
    ...(isV25 ? {} : { model: PAI_VIDEO_ENDPOINT_ID }),
    content: buildContent({ prompt, imageRefs, audioRefs, videoRefs }),
    generate_audio: !!generateAudio,
    ratio: aspectRatio,
    duration: Number(duration),
    resolution,
    watermark: false,
    // Read by the backend's preprocess hook, which lifts it OUT of the
    // payload and onto the dispatch params wrapper before submit, so it never
    // reaches the vendor. It stays on the stored task for audit either way.
    ...(isV25 ? { billed_duration_sec: billedDurationSec } : {}),
  };

  const env = await callSubmit({
    model: model.id,
    payload,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: isV25 ? "pai-video-25" : "pai-video",
  });
  return { taskId: env.job_id, raw: env };
}

// Prefer PAI's long-lived rehosted URL (`output_url`); fall back to the
// upstream signed URL inside `raw_response`. If neither path resolves,
// pollVideo throws `infra`.
function findVideoUrl(resp) {
  if (typeof resp?.output_url === "string" && resp.output_url) return resp.output_url;
  const inner = resp?.raw_response;
  if (typeof inner?.video_url === "string" && inner.video_url) return inner.video_url;
  if (typeof inner?.content?.video_url === "string" && inner.content.video_url) return inner.content.video_url;
  return "";
}

/**
 * Poll PAI for the task's terminal status. On SUCCESS, returns the
 * resolved video URL + the raw response + wall-clock seconds. On
 * FAILED, throws a classified error.
 *
 * @param {string}   taskId
 * @param {Object}   [opts]
 * @param {function} [opts.onProgress]  invoked with { status, elapsedSec }
 *
 * @returns {Promise<{ videoUrl: string, raw: object, durationSeconds: number }>}
 */
export async function pollVideo(taskId, { onProgress } = {}) {
  const started = Date.now();
  const resp = await pollStatus(taskId, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    onProgress,
  });
  const videoUrl = findVideoUrl(resp);
  if (!videoUrl) {
    throw err(
      "infra",
      `PAI task ${taskId} reached SUCCESS but response carried no video URL: ${JSON.stringify(resp).slice(0, 300)}`,
    );
  }
  return {
    videoUrl,
    raw: resp,
    durationSeconds: (Date.now() - started) / 1000,
  };
}
