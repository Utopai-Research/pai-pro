// Per-project file writers + the active-project symlink flipper +
// the canvas-positions / asset-cache write helpers + the per-project
// sidecar mutex.
//
// Two locking systems coexist in this codebase. This module owns
// `withProjectMutationLock`, which guards the canvas_positions.json
// sidecar (high-volume drag positions; not audit-logged). The
// canvas_mutator's PQueue guards workflow.json (audit-logged,
// schema-validated). They protect different files and are
// intentionally separate.

import fsp from "node:fs/promises";
import path from "node:path";

import {
  ACTIVE_FILE,
  ROOT_LINK,
  canvasPositionsPath,
  isValidId,
  metaPath,
  resultsDir,
} from "./paths.js";
import { normalizeResultForWrite } from "./generation_result_normalize.js";

export async function writeMeta(id, meta) {
  await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2) + "\n");
}

export async function writeCanvasPositions(id, state) {
  await fsp.writeFile(
    canvasPositionsPath(id),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function writeResult(id, jobId, result) {
  if (!jobId || !result || typeof result !== "object") {
    throw new Error("writeResult requires a job id and result object");
  }
  const dir = resultsDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${jobId}.json`);
  const payload = normalizeResultForWrite(jobId, result);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload) + "\n");
    await fsp.link(tmp, target);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

// --- Per-project async mutex -------------------------------------------
//
// Every route that mutates p.canvasState / p.canvasPositions and writes
// the corresponding JSON file goes through here. Without it, two
// concurrent handlers JSON.stringify their own snapshots and then
// await writeFile — completion order is non-deterministic, so a later
// snapshot can overwrite a fuller one (silent node loss) or two writes
// can interleave at the byte level and corrupt the file. With this,
// the mutate + writeFile span is FIFO-serialized per project.
//
// Thrown errors inside `fn` propagate to the caller but do NOT poison
// the queue (the chain hops past via .catch). The map slot is dropped
// once nothing else has chained on top of it.
const projectMutationLocks = new Map(); // projectId -> tail Promise

export function withProjectMutationLock(id, fn) {
  const prev = projectMutationLocks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  projectMutationLocks.set(id, next);
  const cleanup = () => {
    if (projectMutationLocks.get(id) === next) {
      projectMutationLocks.delete(id);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

// --- Active-project pointer + symlink ----------------------------------

export async function readActive() {
  try {
    const raw = await fsp.readFile(ACTIVE_FILE, "utf8");
    const id = raw.trim();
    return isValidId(id) ? id : null;
  } catch {
    return null;
  }
}

async function flipSymlink(linkPath, targetRel) {
  const tmp = linkPath + ".tmp";
  try { await fsp.unlink(tmp); } catch {}
  await fsp.symlink(targetRel, tmp);
  await fsp.rename(tmp, linkPath);
}

export async function writeActive(id) {
  await fsp.writeFile(ACTIVE_FILE, id + "\n");
  await flipSymlink(ROOT_LINK, path.join("projects", id, "workflow.json"));
}
