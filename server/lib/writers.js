// Per-project file writers + the active-project symlink flipper +
// the canvas-positions / asset-cache write helpers + the per-project
// sidecar mutex.
//
// Two locking systems coexist in this codebase. This module owns
// `withProjectMutationLock`, which guards sidecar state such as
// meta.json and canvas_positions.json. The canvas_mutator's PQueue
// guards workflow.json (audit-logged, schema-validated). They protect
// different files and are intentionally separate.

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
import { writeFileAtomic, writeFileOnce } from "./atomic_writes.js";

export async function writeMeta(id, meta) {
  await writeFileAtomic(metaPath(id), JSON.stringify(meta, null, 2) + "\n");
}

export async function writeCanvasPositions(id, state) {
  await writeFileAtomic(
    canvasPositionsPath(id),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function writeResult(id, jobId, result) {
  if (!jobId || !result || typeof result !== "object") {
    throw new Error("writeResult requires a job id and result object");
  }
  const dir = resultsDir(id);
  const target = path.join(dir, `${jobId}.json`);
  const payload = normalizeResultForWrite(jobId, result);
  return writeFileOnce(target, JSON.stringify(payload) + "\n");
}

// --- Per-project async mutex -------------------------------------------
//
// Every route that mutates p.meta / p.canvasPositions and writes the
// corresponding JSON sidecar goes through here. Without it, two
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

// Snapshot of every in-flight sidecar write chain — awaited by the
// viewer's graceful shutdown so meta.json / canvas_positions.json writes
// queued at SIGTERM land before the process exits (workflow.json writes
// are drained separately via each project's mutationQueue).
export function pendingSidecarWrites() {
  return Promise.allSettled(Array.from(projectMutationLocks.values()));
}

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

export function updateProjectMeta(id, project, updater) {
  return withProjectMutationLock(id, async () => {
    if (!project?.meta || typeof project.meta !== "object") {
      throw new Error("project meta is not loaded");
    }
    const next = { ...project.meta };
    const result = updater(next);
    if (result === false) {
      return { changed: false, meta: project.meta, result };
    }
    await writeMeta(id, next);
    project.meta = next;
    return { changed: true, meta: next, result };
  });
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
