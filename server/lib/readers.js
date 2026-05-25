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
  PENDING_STALE_RUNNING_MS,
  PENDING_STALE_DRAFT_MS,
} from "./paths.js";

export const EMPTY_POSITIONS = () => ({ positions: {}, groupFrames: {} });

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
    const stage =
      parsed.stage === "failed" ? "failed"
      : parsed.stage === "draft" ? "draft"
      : "running";
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
