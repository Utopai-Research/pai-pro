// Pending-generation sidecar helper.
//
// The viewer renders draft/running generation pads from these sidecars.
// A generate_* CLI writes a draft sidecar before review; the fire route
// rewrites it to running and unlinks it after the durable result lands.
// The viewer chokidar-watches `projects/<id>/.pending/` and re-broadcasts
// to every browser tab.
//
// Draft/running sidecars can live across a review session. The viewer
// hides them after the project-level stale window if no result sidecar
// arrives.
//
// The CLI's cwd is `projects/<active>/` (set by the agent's pty), so we
// resolve the sidecar relative to that. If the CLI is run from elsewhere,
// the sidecar lands wherever and no viewer instance picks it up — harmless.

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  normalizeResultForRead,
  normalizeResultForWrite,
} from "../lib/generation_result_normalize.js";
import { writeFileOnce } from "../lib/atomic_writes.js";

const PENDING_DIR_NAME = ".pending";
const RESULTS_DIR_NAME = ".results";
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_WAIT_TIMEOUT_MS = 35 * 60 * 1000;
const DEFAULT_WAIT_INTERVAL_MS = 1000;
export const REVIEW_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REVIEW_WAIT_INTERVAL_MS = 250;

function pendingDir() {
  return path.join(process.cwd(), PENDING_DIR_NAME);
}

function pendingPath(jobId) {
  return path.join(pendingDir(), `${jobId}.json`);
}

function resultPath(jobId, cwd = process.cwd()) {
  return path.join(cwd, RESULTS_DIR_NAME, `${jobId}.json`);
}

export function newJobId() {
  return "pending_" + crypto.randomUUID().replace(/-/g, "");
}

// Returns true when the active project has opted out of the draft gate
// via the canvas UI. Read fresh per call — the agent may have cached a
// stale decision from earlier in the session. `cwd` is parameterized
// for tests; production callers use the CLI's process.cwd().
export async function isBypassEnabled(cwd = process.cwd()) {
  try {
    const meta = JSON.parse(
      await fsp.readFile(path.join(cwd, "meta.json"), "utf8"),
    );
    return meta.dangerously_skip_draft_gate === true;
  } catch {
    return false;
  }
}

export function defaultWaitTimeoutMsForKind(kind) {
  return kind === "video" ? VIDEO_WAIT_TIMEOUT_MS : DEFAULT_WAIT_TIMEOUT_MS;
}

export async function waitForReviewResult(jobId, { kind } = {}) {
  return waitForResult(jobId, {
    kind,
    timeoutMs: REVIEW_WAIT_TIMEOUT_MS,
    intervalMs: REVIEW_WAIT_INTERVAL_MS,
  });
}

function normalizeJobIds(jobIds) {
  const input = Array.isArray(jobIds) ? jobIds : [jobIds];
  const seen = new Set();
  const out = [];
  for (const id of input) {
    if (typeof id !== "string" || id.trim() === "") continue;
    const value = id.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseWaitTimeout(timeoutMs, kind) {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    return timeoutMs;
  }
  const fromEnv = Number(process.env.PAI_WAIT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : defaultWaitTimeoutMsForKind(kind);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readReadyResult(jobId, cwd) {
  try {
    const raw = await fsp.readFile(resultPath(jobId, cwd), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
      return { ready: true, result: normalizeResultForRead(jobId, parsed) };
    }
    return {
      ready: true,
      result: {
        ok: false,
        job_id: jobId,
        klass: "infra",
        message: `result sidecar ${jobId} has invalid shape`,
      },
    };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { ready: false };
    return {
      ready: true,
      result: {
        ok: false,
        job_id: jobId,
        klass: "infra",
        message: `result sidecar ${jobId} is unreadable: ${e.message}`,
      },
    };
  }
}

export async function waitForResult(jobId, {
  cwd = process.cwd(),
  kind,
  timeoutMs,
  intervalMs = DEFAULT_WAIT_INTERVAL_MS,
} = {}) {
  const waitMs = parseWaitTimeout(timeoutMs, kind);
  const pollMs = Math.max(10, Number(intervalMs) || DEFAULT_WAIT_INTERVAL_MS);
  const deadline = Date.now() + waitMs;
  while (true) {
    const ready = await readReadyResult(jobId, cwd);
    if (ready.ready) return ready.result;
    const now = Date.now();
    if (now >= deadline) {
      return {
        ok: false,
        job_id: jobId,
        klass: "timeout",
        message: `timed out waiting for generation result ${jobId}`,
      };
    }
    await sleep(Math.min(pollMs, deadline - now));
  }
}

function batchPayload(jobIds, completed, { timedOut = false, message } = {}) {
  const results = jobIds
    .filter((id) => completed.has(id))
    .map((id) => completed.get(id));
  const pending = jobIds.filter((id) => !completed.has(id));
  const succeededCount = results.filter((r) => r?.ok === true).length;
  const cancelledCount = results.filter((r) => r?.klass === "cancelled").length;
  const failedCount = results.filter((r) => r?.ok === false && r?.klass !== "cancelled").length;
  return {
    ok: pending.length === 0,
    ...(timedOut ? { klass: "timeout" } : {}),
    count: results.length,
    succeeded_count: succeededCount,
    failed_count: failedCount,
    cancelled_count: cancelledCount,
    pending_count: pending.length,
    batch_complete: pending.length === 0,
    timed_out: timedOut,
    ...(message ? { message } : {}),
    results,
    pending_job_ids: pending,
  };
}

export async function waitForResultBatch(jobIds, {
  cwd = process.cwd(),
  timeoutMs = REVIEW_WAIT_TIMEOUT_MS,
  intervalMs = REVIEW_WAIT_INTERVAL_MS,
  onResult,
} = {}) {
  const ids = normalizeJobIds(jobIds);
  if (ids.length === 0) {
    return {
      ok: false,
      klass: "bad_args",
      message: "waitForResultBatch requires at least one job id",
      results: [],
      pending_job_ids: [],
    };
  }

  const waitMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : REVIEW_WAIT_TIMEOUT_MS;
  const pollMs = Math.max(10, Number(intervalMs) || REVIEW_WAIT_INTERVAL_MS);
  const deadline = Date.now() + waitMs;
  const completed = new Map();

  while (true) {
    const now = Date.now();
    for (const id of ids) {
      if (completed.has(id)) continue;
      const ready = await readReadyResult(id, cwd);
      if (!ready.ready) continue;
      completed.set(id, ready.result);
      if (typeof onResult === "function") onResult(ready.result);
    }
    if (completed.size === ids.length) return batchPayload(ids, completed);

    if (now >= deadline) {
      return batchPayload(ids, completed, {
        timedOut: true,
        message: `timed out waiting for generation results: ${ids.filter((id) => !completed.has(id)).join(", ")}`,
      });
    }

    await sleep(Math.min(pollMs, deadline - now));
  }
}

function viewerBaseUrl() {
  const host = process.env.VIEWER_HOST || "localhost";
  const port = process.env.VIEWER_PORT || "7488";
  return `http://${host}:${port}`;
}

export async function fireDraft({ projectId, jobId } = {}) {
  if (!projectId || !jobId) {
    return {
      ok: false,
      job_id: jobId || null,
      klass: "bad_args",
      message: "fireDraft requires projectId and jobId",
    };
  }
  const url = new URL(
    `/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}/generate`,
    viewerBaseUrl(),
  );
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
    });
  } catch (e) {
    return {
      ok: false,
      job_id: jobId,
      klass: "infra",
      message: `viewer fire request failed: ${e.message}`,
    };
  }
  if (!response.ok) {
    let message = `viewer fire request returned HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = String(body.error);
    } catch {
      try {
        const text = await response.text();
        if (text.trim()) message = text.trim().slice(0, 400);
      } catch {
        /* keep status message */
      }
    }
    return {
      ok: false,
      job_id: jobId,
      klass: response.status === 404 ? "bad_args" : "infra",
      message,
    };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* keep the normalized success below */
  }
  return {
    ok: true,
    job_id: jobId,
    ...(body && typeof body === "object" ? body : {}),
  };
}

export async function reserveAutoBudget({
  projectId,
  runId,
  jobId,
  kind,
  model,
  prompt,
  costUsd,
} = {}) {
  if (!projectId || !runId || !jobId) {
    return {
      ok: false,
      job_id: jobId || null,
      klass: "bad_args",
      message: "reserveAutoBudget requires projectId, runId, and jobId",
    };
  }
  const url = new URL(
    `/projects/${encodeURIComponent(projectId)}/auto-runs/${encodeURIComponent(runId)}/reserve`,
    viewerBaseUrl(),
  );
  let response;
  let body = null;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        kind,
        model,
        prompt,
        cost_usd: costUsd,
      }),
    });
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } catch (e) {
    return {
      ok: false,
      job_id: jobId,
      klass: "infra",
      message: `viewer auto budget request failed: ${e.message}`,
    };
  }
  if (!response.ok || body?.ok === false) {
    return {
      ok: false,
      job_id: jobId,
      klass: body?.klass || (response.status === 402 ? "budget_exceeded" : "infra"),
      message: body?.error || `viewer auto budget request returned HTTP ${response.status}`,
      ...(body && typeof body === "object" ? body : {}),
    };
  }
  // A 2xx whose body didn't parse as JSON is not proof of a reservation —
  // fail closed rather than spend against an unconfirmed ledger entry.
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      job_id: jobId,
      klass: "infra",
      message: "viewer auto budget response was not valid JSON",
    };
  }
  return {
    ok: true,
    job_id: jobId,
    ...body,
  };
}

export async function fireAndWait({ projectId, jobId, kind, timeoutMs } = {}) {
  const fired = await fireDraft({ projectId, jobId });
  if (!fired.ok) return fired;
  return waitForResult(jobId, { kind, timeoutMs });
}

async function pendingContextForResult(jobId, cwd) {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(path.join(cwd, PENDING_DIR_NAME, `${jobId}.json`), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const key of [
      "prompt",
      "aspect_ratio",
      "model",
      "size",
      "image_size",
      "resolution",
      "duration",
      "cost_usd",
      "mode",
      "source_resolution",
      "target_resolution",
      "text",
      "position",
      "reference_source_ids",
      "source_node_id",
      "auto_run_id",
    ]) {
      if (parsed[key] !== undefined) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}

// Write the durable terminal record for a CLI-owned generation to
// `<cwd>/.results/<jobId>.json`. The viewer's chokidar watcher picks it up
// and broadcasts `generation-results`; `list_generation_results.js` and
// `wait_for_generation.js` read it back. Write-once and best-effort:
// an existing result means boot recovery or another waiter beat us to it,
// so we never clobber and never throw into the CLI's finally.
export async function writeResultSidecar(jobId, result, { cwd = process.cwd() } = {}) {
  if (!jobId || !result || typeof result !== "object") return false;
  const dir = path.join(cwd, RESULTS_DIR_NAME);
  const target = path.join(dir, `${jobId}.json`);
  const payload = normalizeResultForWrite(jobId, {
    ...(await pendingContextForResult(jobId, cwd)),
    ...result,
  });
  try {
    return await writeFileOnce(target, JSON.stringify(payload) + "\n");
  } catch {
    return false;
  }
}

// Write `<cwd>/.pending/<jobId>.json` describing the in-flight or staged
// job. Best-effort: mkdir + write, return false on failure, but never throw.
// `stage` defaults to "running"; pass "draft" for a captured call awaiting
// user approval, in which case `argv` + `script` + `costUsd` carry the replay
// context.
//
// Some sidecar context is sticky: when a CLI calls writePending against
// an existing sidecar (e.g. draft → running on fire), prior position,
// lineage, and display details survive if the caller doesn't pass them.
export async function writePending({
  jobId, kind, prompt, aspectRatio,
  model, size, imageSize, resolution, duration,
  stage = "running",
  costUsd,
  mode,
  sourceResolution,
  targetResolution,
  script,
  argv,
  text,
  position,
  referenceSourceIds,
  sourceNodeId,
  autoRunId,
}) {
  if (!jobId || !kind || !prompt) return false;
  const payload = {
    id: jobId,
    kind,                          // "image" | "video" | "audio"
    stage,                         // "running" | "draft"
    prompt: String(prompt),
    aspect_ratio: aspectRatio || "16:9",
    created_at: new Date().toISOString(),
  };
  if (typeof model === "string" && model !== "") payload.model = model;
  if (typeof size === "string" && size !== "") payload.size = size;
  if (typeof imageSize === "string" && imageSize !== "") payload.image_size = imageSize;
  if (typeof resolution === "string" && resolution !== "") payload.resolution = resolution;
  if (typeof duration === "number" && Number.isFinite(duration)) payload.duration = duration;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) payload.cost_usd = costUsd;
  if (typeof mode === "string" && mode !== "") payload.mode = mode;
  if (typeof sourceResolution === "string" && sourceResolution !== "") payload.source_resolution = sourceResolution;
  if (typeof targetResolution === "string" && targetResolution !== "") payload.target_resolution = targetResolution;
  if (typeof script === "string" && script !== "") payload.script = script;
  if (Array.isArray(argv)) payload.argv = argv;
  if (typeof text === "string" && text !== "") payload.text = text;
  if (position && typeof position.x === "number" && typeof position.y === "number") {
    payload.position = { x: position.x, y: position.y };
  }
  if (Array.isArray(referenceSourceIds)) {
    payload.reference_source_ids = referenceSourceIds.filter((s) => typeof s === "string" && s !== "");
  }
  if (typeof sourceNodeId === "string" && sourceNodeId !== "") {
    payload.source_node_id = sourceNodeId;
  }
  if (typeof autoRunId === "string" && autoRunId !== "") {
    payload.auto_run_id = autoRunId;
  }
  const dir = pendingDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Preserve sticky fields not explicitly passed by reading the prior
    // sidecar (if any). Lets draft→running transitions keep the
    // user-dragged position and the staged lineage without each CLI's
    // fire path having to thread them through.
    if (payload.position === undefined
        || payload.reference_source_ids === undefined
        || payload.source_node_id === undefined
        || payload.mode === undefined
        || payload.source_resolution === undefined
        || payload.target_resolution === undefined
        || payload.auto_run_id === undefined) {
      try {
        const prev = JSON.parse(await fsp.readFile(pendingPath(jobId), "utf8"));
        if (payload.position === undefined && prev?.position &&
            typeof prev.position.x === "number" && typeof prev.position.y === "number") {
          payload.position = { x: prev.position.x, y: prev.position.y };
        }
        if (payload.reference_source_ids === undefined && Array.isArray(prev?.reference_source_ids)) {
          payload.reference_source_ids = prev.reference_source_ids.filter((s) => typeof s === "string" && s !== "");
        }
        if (payload.source_node_id === undefined && typeof prev?.source_node_id === "string" && prev.source_node_id !== "") {
          payload.source_node_id = prev.source_node_id;
        }
        if (payload.mode === undefined && typeof prev?.mode === "string" && prev.mode !== "") {
          payload.mode = prev.mode;
        }
        if (payload.source_resolution === undefined && typeof prev?.source_resolution === "string" && prev.source_resolution !== "") {
          payload.source_resolution = prev.source_resolution;
        }
        if (payload.target_resolution === undefined && typeof prev?.target_resolution === "string" && prev.target_resolution !== "") {
          payload.target_resolution = prev.target_resolution;
        }
        if (payload.auto_run_id === undefined && typeof prev?.auto_run_id === "string" && prev.auto_run_id !== "") {
          payload.auto_run_id = prev.auto_run_id;
        }
      } catch { /* no prior sidecar, or unreadable — fresh write */ }
    }
    // Write atomically so chokidar never sees a half-formed JSON file.
    const tmp = pendingPath(jobId) + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(payload) + "\n");
    await fsp.rename(tmp, pendingPath(jobId));
    return true;
  } catch {
    /* swallow — the generator's primary work matters more */
    return false;
  }
}

export async function removePending(jobId) {
  if (!jobId) return;
  try {
    await fsp.unlink(pendingPath(jobId));
  } catch {
    /* already gone or never existed */
  }
}

// Best-effort sync remover for process-exit handlers. fs.unlinkSync swallows
// ENOENT so this is safe to call even if the async remove already ran.
export function removePendingSync(jobId) {
  if (!jobId) return;
  try {
    fs.unlinkSync(pendingPath(jobId));
  } catch {
    /* already gone, dir gone, etc. */
  }
}
