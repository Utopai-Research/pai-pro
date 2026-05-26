// Pending-generation sidecar helper.
//
// While a long-running generate_* CLI is in flight, the viewer renders a
// placeholder pad on the canvas so the user sees what's coming. The sidecar
// is the cheapest possible signal — a single JSON file written at job start
// and unlinked on settle (success OR failure). The viewer chokidar-watches
// `projects/<id>/.pending/` and re-broadcasts to every browser tab.
//
// Lifetime is exactly the wall-clock of the CLI. The viewer also runs a
// 15-minute safety prune for crashed CLIs that never reached the finally.
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

const PENDING_DIR_NAME = ".pending";
const RESULTS_DIR_NAME = ".results";
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_WAIT_TIMEOUT_MS = 35 * 60 * 1000;
const DEFAULT_WAIT_INTERVAL_MS = 1000;

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

export async function isServerOwnedGenerationEnabled(cwd = process.cwd()) {
  if (process.env.PAI_SERVER_OWNED_GENERATION === "0") return false;
  try {
    const meta = JSON.parse(
      await fsp.readFile(path.join(cwd, "meta.json"), "utf8"),
    );
    return meta.use_server_owned_generation === true;
  } catch {
    return false;
  }
}

export function defaultWaitTimeoutMsForKind(kind) {
  return kind === "video" ? VIDEO_WAIT_TIMEOUT_MS : DEFAULT_WAIT_TIMEOUT_MS;
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
    try {
      const raw = await fsp.readFile(resultPath(jobId, cwd), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        return normalizeResultForRead(jobId, parsed);
      }
      return {
        ok: false,
        job_id: jobId,
        klass: "infra",
        message: `result sidecar ${jobId} has invalid shape`,
      };
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
        return {
          ok: false,
          job_id: jobId,
          klass: "infra",
          message: `result sidecar ${jobId} is unreadable: ${e.message}`,
        };
      }
    }
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

function viewerBaseUrl() {
  const host = process.env.VIEWER_HOST || "localhost";
  const port = process.env.VIEWER_PORT || "7488";
  return `http://${host}:${port}`;
}

export async function fireAndWait({ projectId, jobId, kind, timeoutMs } = {}) {
  if (!projectId || !jobId) {
    return {
      ok: false,
      job_id: jobId || null,
      klass: "bad_args",
      message: "fireAndWait requires projectId and jobId",
    };
  }
  const url = new URL(
    `/projects/${encodeURIComponent(projectId)}/pending/${encodeURIComponent(jobId)}/generate`,
    viewerBaseUrl(),
  );
  url.searchParams.set("source", "bypass");
  let response;
  try {
    response = await fetch(url, { method: "POST" });
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
      "image_size",
      "resolution",
      "duration",
      "cost_usd",
      "text",
      "position",
      "reference_source_ids",
      "source_node_id",
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
// `wait_for_generation.js` read it back. Write-once and best-effort: the
// link fails EEXIST if a result already exists (e.g. boot recovery beat us
// to it), so we never clobber and never throw into the CLI's finally.
export async function writeResultSidecar(jobId, result, { cwd = process.cwd() } = {}) {
  if (!jobId || !result || typeof result !== "object") return false;
  const dir = path.join(cwd, RESULTS_DIR_NAME);
  const target = path.join(dir, `${jobId}.json`);
  const payload = normalizeResultForWrite(jobId, {
    ...(await pendingContextForResult(jobId, cwd)),
    ...result,
  });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(payload) + "\n");
    await fsp.link(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

// Write `<cwd>/.pending/<jobId>.json` describing the in-flight or staged
// job. Best-effort: mkdir + write, but never throw. `stage` defaults to
// "running"; pass "draft" for a captured call awaiting user approval,
// in which case `argv` + `script` + `costUsd` carry the replay context.
//
// `position`, `referenceSourceIds`, and `sourceNodeId` are sticky —
// when a CLI calls writePending against an existing sidecar (e.g.,
// draft → running on fire), the previous values survive even if the
// caller didn't pass them. That lets the browser-side drag position
// persist across the stage transition and lets the lineage captured at
// stage time carry through to the running phase.
export async function writePending({
  jobId, kind, prompt, aspectRatio,
  model, imageSize, resolution, duration,
  stage = "running",
  costUsd,
  script,
  argv,
  text,
  position,
  referenceSourceIds,
  sourceNodeId,
}) {
  if (!jobId || !kind || !prompt) return;
  const payload = {
    id: jobId,
    kind,                          // "image" | "video" | "audio"
    stage,                         // "running" | "draft" | "failed"
    prompt: String(prompt),
    aspect_ratio: aspectRatio || "16:9",
    created_at: new Date().toISOString(),
  };
  if (typeof model === "string" && model !== "") payload.model = model;
  if (typeof imageSize === "string" && imageSize !== "") payload.image_size = imageSize;
  if (typeof resolution === "string" && resolution !== "") payload.resolution = resolution;
  if (typeof duration === "number" && Number.isFinite(duration)) payload.duration = duration;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) payload.cost_usd = costUsd;
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
  const dir = pendingDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Preserve sticky fields not explicitly passed by reading the prior
    // sidecar (if any). Lets draft→running transitions keep the
    // user-dragged position and the staged lineage without each CLI's
    // fire path having to thread them through.
    if (payload.position === undefined
        || payload.reference_source_ids === undefined
        || payload.source_node_id === undefined) {
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
      } catch { /* no prior sidecar, or unreadable — fresh write */ }
    }
    // Write atomically so chokidar never sees a half-formed JSON file.
    const tmp = pendingPath(jobId) + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(payload) + "\n");
    await fsp.rename(tmp, pendingPath(jobId));
  } catch {
    /* swallow — the generator's primary work matters more */
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
