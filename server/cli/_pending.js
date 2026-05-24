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

const PENDING_DIR_NAME = ".pending";

function pendingDir() {
  return path.join(process.cwd(), PENDING_DIR_NAME);
}

function pendingPath(jobId) {
  return path.join(pendingDir(), `${jobId}.json`);
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
