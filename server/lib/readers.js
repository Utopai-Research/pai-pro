// Per-project file readers — meta.json, workflow.json, canvas_positions
// sidecar, asset-cache sidecar, and .pending/<job>.json sidecars.
//
// None of these read from in-memory state; they're side-effect-free
// reads that return the parsed shape (or null/empty on miss). Soft
// failures log a warning and fall back so a malformed file doesn't
// kill the loader / watcher.

import fsp from "node:fs/promises";
import path from "node:path";

import {
  metaPath,
  workflowPath,
  canvasPositionsPath,
  pendingDir,
  resultsDir,
  PENDING_STALE_RUNNING_MS,
  PENDING_STALE_DRAFT_MS,
} from "./paths.js";
import { normalizeResultForRead } from "./generation_result_normalize.js";

export const EMPTY_POSITIONS = () => ({ positions: {}, groupFrames: {} });
export const GENERATION_RESULTS_BUNDLE_LIMIT = 50;

export async function readMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(id), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.warn(`[viewer] meta read error (${id}): ${e.message}`);
    return null;
  }
}

export async function readCanvas(id) {
  try {
    const raw = await fsp.readFile(workflowPath(id), "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.warn(`[viewer] canvas read error (${id}): ${e.message}`);
    return null;
  }
}

export async function readCanvasPositions(id) {
  try {
    const raw = await fsp.readFile(canvasPositionsPath(id), "utf8");
    if (!raw.trim()) return EMPTY_POSITIONS();
    const parsed = JSON.parse(raw);
    return {
      positions: parsed.positions ?? {},
      groupFrames: parsed.groupFrames ?? {},
    };
  } catch (e) {
    if (e.code === "ENOENT") return EMPTY_POSITIONS();
    console.warn(`[viewer] canvas_positions read error (${id}): ${e.message}`);
    return EMPTY_POSITIONS();
  }
}

// Pending-generation sidecars: best-effort parse of a single .pending/<id>.json
// file. Returns null on missing / unparsable / wrong-shape so the watcher
// treats it as gone. Stale entries (older than the per-stage threshold)
// are dropped: 15 min for running (crashed-CLI sweep), 24h for draft
// (user-staged calls awaiting approval can live across a working session).
export async function readPendingEntry(id, jobId) {
  try {
    const raw = await fsp.readFile(path.join(pendingDir(id), `${jobId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const stage = parsed.stage === "draft" ? "draft" : "running";
    const createdAt = Date.parse(parsed.created_at || "");
    const staleMs = stage === "draft" ? PENDING_STALE_DRAFT_MS : PENDING_STALE_RUNNING_MS;
    if (Number.isFinite(createdAt) && Date.now() - createdAt > staleMs) return null;
    const out = {
      id: parsed.id || jobId,
      kind:
        parsed.kind === "video" ? "video"
        : parsed.kind === "audio" ? "audio"
        : "image",
      stage,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      aspect_ratio: typeof parsed.aspect_ratio === "string" ? parsed.aspect_ratio : "16:9",
      created_at: parsed.created_at || null,
    };
    if (typeof parsed.model === "string" && parsed.model !== "") out.model = parsed.model;
    if (typeof parsed.size === "string" && parsed.size !== "") out.size = parsed.size;
    if (typeof parsed.image_size === "string" && parsed.image_size !== "") out.image_size = parsed.image_size;
    if (typeof parsed.resolution === "string" && parsed.resolution !== "") out.resolution = parsed.resolution;
    if (typeof parsed.duration === "number" && Number.isFinite(parsed.duration)) out.duration = parsed.duration;
    // Draft-only fields. `script` + `argv` let the viewer's POST
    // /generate route replay the captured call; `cost_usd` is a
    // snapshot for the price chip. `text` carries the spoken line for
    // voice drafts (kind="audio").
    if (typeof parsed.cost_usd === "number" && Number.isFinite(parsed.cost_usd)) out.cost_usd = parsed.cost_usd;
    if (typeof parsed.script === "string" && parsed.script !== "") out.script = parsed.script;
    if (Array.isArray(parsed.argv)) out.argv = parsed.argv.filter((v) => typeof v === "string");
    if (typeof parsed.text === "string" && parsed.text !== "") out.text = parsed.text;
    if (typeof parsed.klass === "string" && parsed.klass !== "") out.klass = parsed.klass;
    if (typeof parsed.message === "string" && parsed.message !== "") out.message = parsed.message;
    if (typeof parsed.completed_at === "string" && parsed.completed_at !== "") out.completed_at = parsed.completed_at;
    if (parsed.sent && typeof parsed.sent === "object") out.sent = parsed.sent;
    // Sidecar-persisted drag position survives refresh and stage
    // transitions (writePending preserves it via read-modify-write).
    if (parsed.position && typeof parsed.position === "object"
        && typeof parsed.position.x === "number" && Number.isFinite(parsed.position.x)
        && typeof parsed.position.y === "number" && Number.isFinite(parsed.position.y)) {
      out.position = { x: parsed.position.x, y: parsed.position.y };
    }
    // Lineage captured at stage time. The projection uses these to
    // draw dashed visual edges from each source canvas node into the
    // pending pad, matching the solid edges the final node will have.
    if (Array.isArray(parsed.reference_source_ids)) {
      out.reference_source_ids = parsed.reference_source_ids.filter((v) => typeof v === "string" && v !== "");
    }
    if (typeof parsed.source_node_id === "string" && parsed.source_node_id !== "") {
      out.source_node_id = parsed.source_node_id;
    }
    return out;
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      console.warn(`[viewer] pending read error (${id}/${jobId}): ${e.message}`);
    }
    return null;
  }
}

export async function readPendingDir(id) {
  const out = new Map();
  const dir = pendingDir(id);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return out;
    console.warn(`[viewer] pending dir scan error (${id}): ${e.message}`);
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const jobId = e.name.slice(0, -".json".length);
    const entry = await readPendingEntry(id, jobId);
    if (entry) out.set(jobId, entry);
  }
  return out;
}

// Terminal generation results. Unlike pending entries, results are durable
// enough for a still-waiting agent to read after the pending pad is gone.
export async function readResultEntry(id, jobId) {
  try {
    const raw = await fsp.readFile(path.join(resultsDir(id), `${jobId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.ok !== "boolean") return null;
    return parsed;
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      console.warn(`[viewer] result read error (${id}/${jobId}): ${e.message}`);
    }
    return null;
  }
}

function resultStatus(raw) {
  if (raw?.ok === true && !raw?.canvas_mutation_error) return "succeeded";
  if (raw?.klass === "aborted" || raw?.klass === "cancelled") return "aborted";
  if (raw?.klass === "timeout") return "timeout";
  return "failed";
}

function resultSortTime(summary, fallbackMtimeMs = 0) {
  const parsed = Date.parse(summary?.completed_at || "");
  return Number.isFinite(parsed) ? parsed : fallbackMtimeMs;
}

export function compareResultSummaries(a, b) {
  return resultSortTime(b) - resultSortTime(a);
}

function canvasMutationNodeId(raw) {
  const id = raw?.canvas_mutation?.node_id ?? raw?.node_id ?? null;
  return typeof id === "string" && id !== "" ? id : null;
}

export function normalizeResultEntry(jobId, raw, { mtimeMs = 0 } = {}) {
  raw = normalizeResultForRead(jobId, raw);
  if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") return null;
  const out = {
    job_id: typeof raw.job_id === "string" && raw.job_id !== "" ? raw.job_id : jobId,
    kind:
      raw.kind === "video" ? "video"
      : raw.kind === "audio" ? "audio"
      : "image",
    status: resultStatus(raw),
    ok: raw.ok,
  };
  if (typeof raw.completed_at === "string" && raw.completed_at !== "") {
    out.completed_at = raw.completed_at;
  } else if (mtimeMs > 0) {
    out.completed_at = new Date(mtimeMs).toISOString();
  }
  if (raw.ok === false) {
    if (typeof raw.klass === "string" && raw.klass !== "") out.klass = raw.klass;
    if (typeof raw.message === "string" && raw.message !== "") out.message = raw.message;
  }
  const nodeId = canvasMutationNodeId(raw);
  if (nodeId) out.node_id = nodeId;
  if (typeof raw.local_path === "string" && raw.local_path !== "") out.local_path = raw.local_path;
  if (typeof raw.output_url === "string" && raw.output_url !== "") out.output_url = raw.output_url;
  if (typeof raw.model === "string" && raw.model !== "") out.model = raw.model;
  if (typeof raw.prompt === "string") out.prompt = raw.prompt;
  if (typeof raw.size === "string" && raw.size !== "") out.size = raw.size;
  if (typeof raw.aspect_ratio === "string" && raw.aspect_ratio !== "") out.aspect_ratio = raw.aspect_ratio;
  if (typeof raw.image_size === "string" && raw.image_size !== "") out.image_size = raw.image_size;
  if (typeof raw.resolution === "string" && raw.resolution !== "") out.resolution = raw.resolution;
  if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) out.duration = raw.duration;
  if (typeof raw.cost_usd === "number" && Number.isFinite(raw.cost_usd)) out.cost_usd = raw.cost_usd;
  if (typeof raw.text === "string" && raw.text !== "") out.text = raw.text;
  if (raw.position && typeof raw.position === "object"
      && typeof raw.position.x === "number" && Number.isFinite(raw.position.x)
      && typeof raw.position.y === "number" && Number.isFinite(raw.position.y)) {
    out.position = { x: raw.position.x, y: raw.position.y };
  }
  if (Array.isArray(raw.reference_source_ids)) {
    out.reference_source_ids = raw.reference_source_ids.filter((v) => typeof v === "string" && v !== "");
  }
  if (typeof raw.source_node_id === "string" && raw.source_node_id !== "") {
    out.source_node_id = raw.source_node_id;
  }
  if (raw.sent && typeof raw.sent === "object") out.sent = raw.sent;
  if (raw.limits && typeof raw.limits === "object") out.limits = raw.limits;
  return out;
}

export async function readResultDir(id, { limit, since, failedOnly = false, jobIds } = {}) {
  const dir = resultsDir(id);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    console.warn(`[viewer] result dir scan error (${id}): ${e.message}`);
    return [];
  }

  const jobIdSet = Array.isArray(jobIds) && jobIds.length > 0
    ? new Set(jobIds.filter((v) => typeof v === "string" && v !== ""))
    : null;
  const sinceMs = since ? Date.parse(since) : null;
  const boundedLimit = Number.isFinite(limit) && limit >= 0 ? limit : null;
  const out = [];

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const jobId = e.name.slice(0, -".json".length);
    if (jobIdSet && !jobIdSet.has(jobId)) continue;
    const abs = path.join(dir, e.name);
    try {
      const [raw, st] = await Promise.all([
        fsp.readFile(abs, "utf8"),
        fsp.stat(abs),
      ]);
      const summary = normalizeResultEntry(jobId, JSON.parse(raw), { mtimeMs: st.mtimeMs });
      if (!summary) continue;
      if (sinceMs !== null && resultSortTime(summary, st.mtimeMs) < sinceMs) continue;
      if (failedOnly && summary.ok !== false) continue;
      out.push({ summary, sortTime: resultSortTime(summary, st.mtimeMs) });
    } catch (err) {
      console.warn(`[viewer] result dir entry skipped (${id}/${jobId}): ${err.message}`);
    }
  }

  out.sort((a, b) => b.sortTime - a.sortTime);
  const limited = boundedLimit === null ? out : out.slice(0, boundedLimit);
  return limited.map((entry) => entry.summary);
}
