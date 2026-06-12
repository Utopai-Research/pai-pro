// PAI raw passthrough → video upscaling.
//
// Flow:
//   upscale-create   (sync /generate) → requestId + USD estimate
//   upscale-accept   (sync /generate) → presigned upload URL
//   PUT source bytes directly to that URL   → ETag
//   upscale-complete (async /submit)  → job_id, then poll for MP4

import fs from "node:fs";
import { callGenerate, callSubmit, pollStatus, err } from "./pai_client.js";

export const UPSCALE_CREATE_MODEL = "upscale-create";
export const UPSCALE_ACCEPT_MODEL = "upscale-accept";
export const UPSCALE_COMPLETE_MODEL = "upscale-complete";

const SYNC_TIMEOUT_MS = 120_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 45 * 60_000;

export async function createUpscale(payload) {
  const body = await callGenerate({
    model: UPSCALE_CREATE_MODEL,
    payload,
    timeoutMs: SYNC_TIMEOUT_MS,
    logTag: "pai-upscale:create",
  });
  const requestId = body?.requestId;
  if (typeof requestId !== "string" || !requestId) {
    throw err("infra", `upscale-create returned no requestId: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { requestId, estimates: body?.estimates ?? {}, raw: body };
}

export async function acceptUpscale(requestId) {
  if (typeof requestId !== "string" || !requestId) {
    throw err("bad_args", "acceptUpscale: requestId required");
  }
  const body = await callGenerate({
    model: UPSCALE_ACCEPT_MODEL,
    payload: { request_id: requestId },
    timeoutMs: SYNC_TIMEOUT_MS,
    logTag: "pai-upscale:accept",
  });
  const urls = Array.isArray(body?.urls) ? body.urls.filter((u) => typeof u === "string" && u !== "") : [];
  if (!urls[0]) {
    throw err("infra", `upscale-accept returned no upload URL: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { uploadUrl: urls[0], raw: body };
}

export async function uploadUpscaleSource({ uploadUrl, filePath, contentType = "video/mp4" }) {
  if (typeof uploadUrl !== "string" || !uploadUrl) throw err("bad_args", "uploadUpscaleSource: uploadUrl required");
  if (typeof filePath !== "string" || !filePath) throw err("bad_args", "uploadUpscaleSource: filePath required");

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    throw err("bad_args", `uploadUpscaleSource: cannot read source file: ${e.message}`);
  }

  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
      },
      body: fs.createReadStream(filePath),
      duplex: "half",
    });
  } catch (e) {
    throw err("transient", `upscale upload failed: ${e.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const klass = res.status >= 400 && res.status < 500 ? "bad_args" : "transient";
    throw err(klass, `upscale upload failed (${res.status} ${res.statusText}): ${body.slice(0, 200)}`);
  }

  const eTag = res.headers.get("etag")?.replace(/^"|"$/g, "") || "";
  if (!eTag) throw err("infra", "upscale upload succeeded but returned no ETag");
  return { partNum: 1, eTag };
}

export async function completeUpscale({ requestId, uploadResult }) {
  if (typeof requestId !== "string" || !requestId) {
    throw err("bad_args", "completeUpscale: requestId required");
  }
  if (!uploadResult || typeof uploadResult !== "object") {
    throw err("bad_args", "completeUpscale: uploadResult required");
  }
  const env = await callSubmit({
    model: UPSCALE_COMPLETE_MODEL,
    payload: {
      request_id: requestId,
      payload: { uploadResults: [uploadResult] },
    },
    timeoutMs: SUBMIT_TIMEOUT_MS,
    logTag: "pai-upscale:complete",
  });
  return { taskId: env.job_id, raw: env };
}

function findVideoUrl(resp) {
  if (typeof resp?.output_url === "string" && resp.output_url) return resp.output_url;
  if (typeof resp?.raw_response?.download?.url === "string" && resp.raw_response.download.url) {
    return resp.raw_response.download.url;
  }
  return "";
}

export async function pollUpscale(taskId, { onProgress } = {}) {
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
      `PAI upscale task ${taskId} reached SUCCESS but response carried no video URL: ${JSON.stringify(resp).slice(0, 300)}`,
    );
  }
  return {
    videoUrl,
    raw: resp,
    durationSeconds: (Date.now() - started) / 1000,
  };
}
