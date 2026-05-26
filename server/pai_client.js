// Shared HTTP plumbing for the PAI Lite developer platform.
//
// PAI Lite exposes three relevant endpoints, all gated by a single
// Authorization: Bearer PAI_<key> header:
//
//   POST /api/v1/generate            sync raw passthrough
//                                    (image, voice, asset upload)
//   POST /api/v1/submit              async raw passthrough
//                                    (video gen — returns job_id)
//   GET  /api/v1/task/status/{id}    polled until terminal status
//
// Used by:
//   pai_image_client.js   — image-generation
//   pai_voice_client.js   — tts
//   pai_assets_client.js  — video-generation-assets (CreateAsset, etc.)
//   pai_video_client.js   — video-generation
//
// The error model carries `.klass` so _cli.js can tag failure banners.
// Class mapping is consistent across all PAI capabilities:
//
//   bad_args            HTTP 400, 422 (validation)
//   infra               HTTP 401 (auth) / 402 (insufficient balance) /
//                       body code 2001 / 2002 / error_category in
//                       {provider, timeout, auth}
//   content_filtered    status=FAILED with error_category=content
//                       (also surfaces from upstream provider safety
//                       blocks once PAI extracts the upstream error)
//   rate_limited        HTTP 429 (Retry-After parsed) / body code 1004
//                       (queue full) / 1006 (duplicate submit; retry_after)
//   transient           HTTP 408 (timeout), 502, 503, network blips
//   transient_exhausted re-tagged after the single retry also failed;
//                       also: HTTP 504 (sync poll timeout), body code 1003
//                       (all upstream models failed terminal)
//
// One transient retry (2 attempts total) with 5s backoff. Non-transient
// classes fail fast; the agent knows what to do per the class tag in
// the banner.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

// Load .env defensively. CLIs that import us from server/cli/ already
// loaded dotenv via _cli.js → lib/paths.js, but library callers may not
// have. dotenv.config() does not overwrite already-set vars.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

const DEFAULT_BASE_URL = "https://api.pai-pro.utopaistudios.com";
const TRANSIENT_RETRY_BACKOFF_MS = 5_000;

export function paiBaseUrl() {
  const fromEnv = String(process.env.PAI_API_BASE ?? "").trim().replace(/\/+$/, "");
  return fromEnv || DEFAULT_BASE_URL;
}

export function paiToken() {
  const t = process.env.PAI_KEY;
  if (!t) throw err("infra", "PAI_KEY not set in env");
  return t;
}

export function err(klass, message, extra = {}) {
  const e = new Error(message);
  e.klass = klass;
  Object.assign(e, extra);
  return e;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${paiToken()}`,
    "Content-Type": "application/json",
  };
}

// PAI errors come in two shapes on non-2xx:
//   FastAPI 4xx/5xx: { detail: "..." } (raw passthrough)
//   PAI envelope:    { code: <2xxx|1xxx>, message: "..." } (rarely; mostly /api/submit on business errors)
// Classify off HTTP status first; let callers handle body-level codes when needed.
function classifyHttpFailure(status, errMsg, retryAfterSec) {
  if (status === 400 || status === 422) return err("bad_args", `PAI ${status}: ${errMsg}`);
  if (status === 401) return err("infra", `PAI 401 (auth): ${errMsg}`);
  if (status === 402) return err("infra", `PAI 402 (insufficient balance): ${errMsg}`);
  if (status === 408) return err("transient", `PAI 408 (timeout): ${errMsg}`);
  if (status === 429) {
    return err("rate_limited", `PAI 429: ${errMsg}`, {
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
    });
  }
  if (status === 502 || status === 503) return err("transient", `PAI ${status}: ${errMsg}`);
  if (status === 504) return err("transient_exhausted", `PAI 504 (sync poll timeout): ${errMsg}`);
  if (status >= 400 && status < 500) return err("bad_args", `PAI ${status}: ${errMsg}`);
  return err("transient", `PAI ${status}: ${errMsg}`);
}

// Body-code mapping for /api/v1/submit (async path). PAI mirrors Cue's
// business codes on the submit envelope: code 0 = success, non-zero =
// rejected. Status endpoint uses error_category instead — see
// classifyTerminalStatus.
function classifySubmitBodyFailure(body) {
  const code = body?.code;
  const msg = body?.message || body?.error_message || `PAI submit failed (code=${code})`;
  if (code === 2001) return err("infra", `PAI 2001 (insufficient balance): ${msg}`);
  if (code === 2002) return err("infra", `PAI 2002 (key invalid/revoked): ${msg}`);
  if (code === 2003) return err("rate_limited", `PAI 2003 (rate limited): ${msg}`, {
    retryAfterSec: body?.retry_after ?? null,
  });
  if (code === 2004) return err("bad_args", `PAI 2004 (pricing dimension missing): ${msg}`);
  if (code === 1001) return err("bad_args", `PAI 1001 (bad params): ${msg}`);
  if (code === 1002) return err("rate_limited", `PAI 1002 (all models busy): ${msg}`, {
    retryAfterSec: body?.retry_after ?? null,
  });
  if (code === 1003) return err("transient_exhausted", `PAI 1003 (all model calls failed): ${msg}`);
  if (code === 1004) return err("rate_limited", `PAI 1004 (queue full): ${msg}`, {
    retryAfterSec: body?.retry_after ?? null,
  });
  if (code === 1006) return err("rate_limited", `PAI 1006 (duplicate submit in flight): ${msg}`, {
    retryAfterSec: body?.retry_after ?? null,
  });
  return err("infra", `PAI submit failed (code=${code}): ${msg}`);
}

// Map terminal status response (status=FAILED) to a class via error_category.
// Used by pai_video_client.js when poll status returns FAILED.
export function classifyTerminalStatus(statusResp) {
  const cat = String(statusResp?.error_category || "").toLowerCase();
  const msg = statusResp?.error_message || "PAI task failed with no error_message";
  if (cat === "content") return err("content_filtered", `PAI task failed (content moderation): ${msg}`);
  if (cat === "provider" || cat === "timeout") return err("infra", `PAI task failed (${cat}): ${msg}`);
  if (cat === "auth") return err("infra", `PAI task failed (auth): ${msg}`);
  return err("infra", `PAI task failed: ${msg}`);
}

// Run a single POST attempt against /api/v1/<path>. Throws classified
// errors on HTTP failure. Returns the parsed JSON body on success.
async function postOnce({ path, body, timeoutMs }) {
  const url = `${paiBaseUrl()}/api/v1/${String(path).replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw err("transient", `PAI ${path} aborted after ${timeoutMs}ms`);
    }
    throw err("transient", `Network error calling PAI ${path}: ${e.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const rawBody = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const errMsg = parsed?.detail
      || parsed?.message
      || parsed?.error?.message
      || rawBody.slice(0, 300)
      || `HTTP ${res.status}`;
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    throw classifyHttpFailure(res.status, errMsg, ra);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw err("transient", `PAI ${path} returned non-JSON 200: ${rawBody.slice(0, 200)}`);
  }
  return parsed;
}

async function getOnce({ path, timeoutMs }) {
  const url = `${paiBaseUrl()}/api/v1/${String(path).replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${paiToken()}` },
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw err("transient", `PAI ${path} aborted after ${timeoutMs}ms`);
    }
    throw err("transient", `Network error calling PAI ${path}: ${e.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const rawBody = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const errMsg = parsed?.detail
      || parsed?.message
      || rawBody.slice(0, 300)
      || `HTTP ${res.status}`;
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    throw classifyHttpFailure(res.status, errMsg, ra);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw err("transient", `PAI ${path} returned non-JSON 200: ${rawBody.slice(0, 200)}`);
  }
  return parsed;
}

// Wrap a call in the canonical one-shot transient retry. `attempt()` is
// the async fn (closure capturing args). Second failure → re-tagged
// transient_exhausted.
async function withTransientRetry({ logTag, attempt }) {
  try {
    return await attempt();
  } catch (e) {
    if (e.klass !== "transient") throw e;
    console.error(`[${logTag}] transient retry in ${TRANSIENT_RETRY_BACKOFF_MS / 1000}s: ${e.message.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_BACKOFF_MS));
    try {
      return await attempt();
    } catch (e2) {
      if (e2.klass === "transient") {
        throw err("transient_exhausted", `${e2.message} (after 2 attempts)`);
      }
      throw e2;
    }
  }
}

/**
 * POST /api/v1/generate — synchronous raw passthrough.
 *
 * Body shape (strict): { model, payload, query_params? }
 *
 * Returns the upstream provider's response body verbatim (caller knows
 * the shape per model). Throws classified errors on any failure.
 *
 * @param {Object}  opts
 * @param {string}  opts.model         e.g. "image-generation" / "tts" / "video-generation-assets"
 * @param {object}  opts.payload       provider-native request body
 * @param {object}  [opts.queryParams] only used by video-generation-assets (Action)
 * @param {number}  [opts.timeoutMs=120_000] upper bound — PAI sync timeout is 120s
 * @param {string}  [opts.logTag="pai"] for retry log lines
 */
export async function callGenerate({
  model,
  payload,
  queryParams,
  timeoutMs = 120_000,
  logTag = "pai",
}) {
  if (typeof model !== "string" || !model) throw err("bad_args", "callGenerate: model required");
  if (!payload || typeof payload !== "object") throw err("bad_args", "callGenerate: payload object required");
  const body = { model, payload };
  if (queryParams && typeof queryParams === "object") body.query_params = queryParams;
  return withTransientRetry({
    logTag,
    attempt: () => postOnce({ path: "generate", body, timeoutMs }),
  });
}

/**
 * POST /api/v1/submit — asynchronous raw passthrough.
 *
 * Same body shape as callGenerate. Returns the submit envelope:
 *   { code, message, job_id, model, status, queued, queue_position, ... }
 * Caller polls via pollStatus(job_id, ...) for the terminal state.
 *
 * Submit-time business errors surface via `body.code !== 0`; we classify
 * those here so the caller can treat the envelope uniformly with sync calls.
 */
export async function callSubmit({
  model,
  payload,
  queryParams,
  timeoutMs = 30_000,
  logTag = "pai",
}) {
  if (typeof model !== "string" || !model) throw err("bad_args", "callSubmit: model required");
  if (!payload || typeof payload !== "object") throw err("bad_args", "callSubmit: payload object required");
  const body = { model, payload };
  if (queryParams && typeof queryParams === "object") body.query_params = queryParams;
  const env = await withTransientRetry({
    logTag,
    attempt: () => postOnce({ path: "submit", body, timeoutMs }),
  });
  if (env?.code !== 0 || !env?.job_id) {
    throw classifySubmitBodyFailure(env);
  }
  return env;
}

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "FAILED_REJECTED"]);

/**
 * GET /api/v1/task/status/{job_id} — poll until terminal.
 *
 * On SUCCESS, resolves with the full status response (output_url,
 * output_type, raw_response, ...). On FAILED, throws via
 * classifyTerminalStatus (content_filtered / infra).
 *
 * @param {string}   jobId
 * @param {Object}   [opts]
 * @param {number}   [opts.intervalMs=5_000]    PAI doc recommended cadence
 * @param {number}   [opts.timeoutMs=30 * 60_000]  30-minute hard cap
 * @param {number}   [opts.requestTimeoutMs=30_000] per-poll request timeout
 * @param {function} [opts.onProgress]          called with { status, elapsedSec } per non-terminal poll
 */
export async function pollStatus(jobId, {
  intervalMs = 5_000,
  timeoutMs = 30 * 60_000,
  requestTimeoutMs = 30_000,
  onProgress,
} = {}) {
  if (typeof jobId !== "string" || !jobId) throw err("bad_args", "pollStatus: jobId required");
  const started = Date.now();
  let consecutiveTransient = 0;

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let resp;
    try {
      resp = await getOnce({
        path: `task/status/${encodeURIComponent(jobId)}`,
        timeoutMs: requestTimeoutMs,
      });
      consecutiveTransient = 0;
    } catch (e) {
      // rate_limited / bad_args / explicit infra → fail fast
      if (e.klass === "rate_limited" || e.klass === "bad_args") throw e;
      // 401/402 mid-poll → also fail fast (caller can't recover)
      if (e.klass === "infra") throw e;
      // transient → bounded retry within the timeout
      consecutiveTransient++;
      if (consecutiveTransient >= 5) throw e;
      continue;
    }

    const status = String(resp?.status || "").toUpperCase();
    if (onProgress) {
      onProgress({ status, elapsedSec: (Date.now() - started) / 1000 });
    }

    if (status === "SUCCESS") return resp;
    if (status === "FAILED" || status === "FAILED_REJECTED") {
      throw classifyTerminalStatus(resp);
    }
    if (!TERMINAL_STATUSES.has(status)
        && status !== "QUEUED"
        && status !== "DISPATCHING"
        && status !== "PROCESSING"
        && status !== "TRANSFERRING") {
      // Unknown status — log but keep polling. PAI may add new states.
      console.warn(`[pai] pollStatus: unknown status="${status}" for job ${jobId} (continuing)`);
    }
  }
  throw err("transient_exhausted", `PAI pollStatus timed out after ${timeoutMs / 1000}s (job_id=${jobId})`);
}

/**
 * Download a public URL to a Buffer. Used by pai_video_client.js to pull
 * the MP4 from output_url. PAI's signed GCS URLs are publicly fetchable
 * within their TTL — no auth needed.
 */
export async function downloadUrlToBuffer(url, { timeoutMs = 120_000 } = {}) {
  if (typeof url !== "string" || !url) throw err("bad_args", "downloadUrlToBuffer: url required");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw err("transient", `download ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}
