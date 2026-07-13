// Chokidar watcher for `projects/`. Fans disk changes to the browser:
//
//   workflow.json         → canvas-state
//   canvas_positions.json → canvas-positions
//   meta.json             → title (+ in-memory meta refresh)
//   .pending/<job>.json   → pending-generations
//   .results/<job>.json   → generation-results
//
// External edits (the agent rewriting workflow.json from inside its
// per-project terminal session) are the primary use case. Viewer-side
// writes ALSO trip the watcher; reloads are funneled through the same
// project queues as in-process mutations so a delayed watcher event cannot
// swap stale disk state over a newer in-memory update.

import path from "node:path";

import chokidar from "chokidar";

import {
  PROJECTS_DIR,
  isValidId,
  projectDir,
} from "../lib/paths.js";
import {
  EMPTY_POSITIONS,
  readCanvas,
  readCanvasPositions,
  readMeta,
  readPendingEntry,
  readResultEntry,
  normalizeResultEntry,
} from "../lib/readers.js";
import { withProjectMutationLock } from "../lib/writers.js";
import { loadProject } from "./projects.js";

function projectIdFromPath(p) {
  const rel = path.relative(PROJECTS_DIR, p);
  const parts = rel.split(path.sep);
  return parts[0] || null;
}

export async function watchProjects({ projects, io, broadcasters }) {
  const {
    broadcastCanvas,
    broadcastPositions,
    broadcastPending,
    broadcastGenerationResults,
  } = broadcasters;

  const watcher = chokidar.watch(PROJECTS_DIR, {
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignoreInitial: true,
    ignored: (p) =>
      p.endsWith(".swp") ||
      p.endsWith(".tmp") ||
      p.endsWith(".lock") ||
      p.endsWith("~") ||
      p.includes(`${path.sep}assets${path.sep}`),
  });

  const reloadCanvas = async (id) => {
    let p = projects.get(id);
    if (!p) {
      p = await loadProject(projects, id);
      if (p) broadcastCanvas(id);
      return;
    }
    if (p.mutationQueue?.add) {
      await p.mutationQueue.add(async () => {
        const canvas = await readCanvas(id);
        if (projects.get(id) === p) {
          p.canvasState = canvas;
          p.version = (p.version || 0) + 1;
        }
      });
    } else {
      p.canvasState = await readCanvas(id);
    }
    if (projects.has(id)) broadcastCanvas(id);
  };

  const reloadPositions = async (id) => {
    await withProjectMutationLock(id, async () => {
      let p = projects.get(id);
      if (!p) {
        await loadProject(projects, id);
        return;
      }
      const state = await readCanvasPositions(id);
      if (projects.get(id) === p) p.canvasPositions = state;
    });
    if (projects.has(id)) broadcastPositions(id);
  };

  const reloadMeta = async (id) => {
    let meta = null;
    await withProjectMutationLock(id, async () => {
      let p = projects.get(id);
      if (!p) {
        p = await loadProject(projects, id);
        meta = p?.meta ?? null;
        return;
      }
      meta = await readMeta(id);
      if (meta && projects.get(id) === p) p.meta = meta;
    });
    if (!meta) return;
    // `title` event now carries the full meta slice the renderer
    // needs — title + bypass flag drive different UI; one broadcast.
    io.to(id).emit("title", {
      projectId: id,
      title: meta.title,
      dangerously_skip_draft_gate: !!meta.dangerously_skip_draft_gate,
    });
  };

  const onFile = async (abs) => {
    const id = projectIdFromPath(abs);
    if (!id || !isValidId(id)) return;
    const rel = path.relative(projectDir(id), abs);

    if (rel === "workflow.json") {
      await reloadCanvas(id);
      return;
    }

    if (rel === "canvas_positions.json") {
      await reloadPositions(id);
      return;
    }

    if (rel === "meta.json") {
      await reloadMeta(id);
      return;
    }

    // .pending/<jobId>.json sidecars dropped by generate_*.js — surface as
    // placeholder nodes on the canvas while a generation is in flight.
    if (rel.startsWith(".pending/") && rel.endsWith(".json")) {
      const jobId = path.basename(rel, ".json");
      const entry = await readPendingEntry(id, jobId);
      let p = projects.get(id);
      if (!p) p = await loadProject(projects, id);
      if (!p) return;
      if (!p.pendingGenerations) p.pendingGenerations = new Map();
      if (entry) p.pendingGenerations.set(jobId, entry);
      else       p.pendingGenerations.delete(jobId);
      broadcastPending(id);
      return;
    }

    if (rel.startsWith(".results/") && rel.endsWith(".json")) {
      const jobId = path.basename(rel, ".json");
      const raw = await readResultEntry(id, jobId);
      const entry = normalizeResultEntry(jobId, raw);
      let p = projects.get(id);
      if (!p) p = await loadProject(projects, id);
      if (!p) return;
      if (!p.generationResults) p.generationResults = new Map();
      if (entry) p.generationResults.set(jobId, entry);
      else       p.generationResults.delete(jobId);
      broadcastGenerationResults(id);
    }
  };

  watcher.on("add", onFile);
  watcher.on("change", onFile);
  watcher.on("unlink", (abs) => {
    const id = projectIdFromPath(abs);
    if (!id || !isValidId(id)) return;
    const rel = path.relative(projectDir(id), abs);

    if (rel === "workflow.json") {
      const p = projects.get(id);
      if (p) {
        p.canvasState = null;
        broadcastCanvas(id);
      }
    } else if (rel === "canvas_positions.json") {
      const p = projects.get(id);
      if (p) {
        p.canvasPositions = EMPTY_POSITIONS();
        broadcastPositions(id);
      }
    } else if (rel === "meta.json") {
      projects.delete(id);
    } else if (rel.startsWith(".pending/") && rel.endsWith(".json")) {
      const jobId = path.basename(rel, ".json");
      const p = projects.get(id);
      if (p?.pendingGenerations?.has(jobId)) {
        p.pendingGenerations.delete(jobId);
        broadcastPending(id);
      }
    } else if (rel.startsWith(".results/") && rel.endsWith(".json")) {
      const jobId = path.basename(rel, ".json");
      const p = projects.get(id);
      if (p?.generationResults?.has(jobId)) {
        p.generationResults.delete(jobId);
        broadcastGenerationResults(id);
      }
    }
  });
}
