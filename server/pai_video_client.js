// PAI raw passthrough → video-generation.
//
// The wire payload is forwarded byte-for-byte to the upstream model, so
// the `content[]` parts (with role: reference_image / reference_audio /
// reference_video) and the top-level keys (`ratio`, `duration`,
// `resolution`, `watermark`, `generate_audio`) read as the upstream
// model expects them.
//
// Reference: raw-models.md § "video-generation".
//
// Three exported functions split the submit / poll / download flow:
//
//   submitVideo({ ... })       → POST /api/v1/submit, returns { taskId, raw }
//   pollVideo(taskId, opts)    → polls /api/v1/task/status/{id} to terminal,
//                                returns { videoUrl, raw, durationSeconds }
//   downloadVideo(url)         → fetch the MP4 bytes from the signed CDN URL

import { callSubmit, pollStatus, downloadUrlToBuffer, err } from "./pai_client.js";

const MODEL = "video-generation";
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60_000; // 30 min per PAI docs recommendation

// Video model endpoint id forwarded inside payload.model. PAI never
// remaps this. Endpoint rotations are rare; a code edit + one-line PR
// is the right cadence.
const PAI_VIDEO_ENDPOINT_ID = "pai-pro-video-endpoint-01";

function buildContent({ prompt, imageAssetIds, audioAssetIds, videoAssetIds }) {
  const content = [{ type: "text", text: String(prompt) }];
  for (const id of imageAssetIds) {
    content.push({
      type: "image_url",
      image_url: { url: `asset://${id}` },
      role: "reference_image",
    });
  }
  for (const id of audioAssetIds) {
    content.push({
      type: "audio_url",
      audio_url: { url: `asset://${id}` },
      role: "reference_audio",
    });
  }
  for (const id of videoAssetIds) {
    content.push({
      type: "video_url",
      video_url: { url: `asset://${id}` },
      role: "reference_video",
    });
  }
  return content;
}

/**
 * Submit a video generation task. Returns immediately with a job id.
 *
 * @param {Object}    opts
 * @param {string}    opts.prompt
 * @param {number}    [opts.duration=15]
 * @param {string}    [opts.aspectRatio="16:9"]
 * @param {string}    [opts.resolution="1080p"]
 * @param {boolean}   [opts.generateAudio=true]
 * @param {string[]}  [opts.imageAssetIds=[]]   from prior uploadReferences()
 * @param {string[]}  [opts.audioAssetIds=[]]
 * @param {string[]}  [opts.videoAssetIds=[]]
 *
 * @returns {Promise<{ taskId: string, raw: object }>}
 *
 * @throws  classified Error (.klass): bad_args / rate_limited / infra /
 *          transient / transient_exhausted
 */
export async function submitVideo({
  prompt,
  duration = 15,
  aspectRatio = "16:9",
  resolution = "1080p",
  generateAudio = true,
  imageAssetIds = [],
  audioAssetIds = [],
  videoAssetIds = [],
  projectId,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "submitVideo: empty prompt");
  }
  const payload = {
    model: PAI_VIDEO_ENDPOINT_ID,
    content: buildContent({ prompt, imageAssetIds, audioAssetIds, videoAssetIds }),
    generate_audio: !!generateAudio,
    ratio: aspectRatio,
    duration: Number(duration),
    resolution,
    watermark: false,
  };

  const refsTotal = imageAssetIds.length + audioAssetIds.length + videoAssetIds.length;
  const env = await callSubmit({
    model: MODEL,
    payload,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "pai-video",
    projectId,
    note: `dur=${Number(duration)}s res=${resolution} refs=${refsTotal}`,
    describeResp: (r) => (r?.job_id ? `→ job=${r.job_id}` : ""),
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
export async function pollVideo(taskId, { onProgress, projectId } = {}) {
  const started = Date.now();
  const resp = await pollStatus(taskId, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    onProgress,
    projectId,
    logTag: "pai-video",
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

/**
 * Pull the MP4 bytes from a signed CDN URL. PAI rehosts to GCS with a
 * publicly-fetchable signed URL (24h TTL).
 *
 * @param {string} videoUrl
 * @returns {Promise<Buffer>}
 */
export async function downloadVideo(videoUrl, { projectId } = {}) {
  return downloadUrlToBuffer(videoUrl, { timeoutMs: 120_000, projectId, logTag: "pai-video-dl" });
}
