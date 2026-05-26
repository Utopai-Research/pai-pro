// Socket.IO broadcast helpers + the mutator's onApply hook + the
// klass→HTTP-status mapper. Factory shape so the io instance + projects
// Map are closed-over once and re-used across routes and the watcher.

import {
  compareResultSummaries,
  EMPTY_POSITIONS,
  GENERATION_RESULTS_BUNDLE_LIMIT,
} from "./readers.js";
import { kickReelPrebuild } from "./reel_cache.js";
import { withProjectMutationLock, writeCanvasPositions } from "./writers.js";

// Coalesce burst pending-sidecar writes (N parallel CLIs → N chokidar
// add events) into one broadcast so the client's placement effect sees
// all pads in a single pass and routes them through gridPackBatch.
export const PENDING_BROADCAST_DEBOUNCE_MS = 100;
export function statusForKlass(klass) {
  if (klass === "validation" || klass === "bad_args") return 400;
  if (klass === "not_found") return 404;
  if (klass === "conflict") return 409;
  return 500;
}

export function createBroadcasters({ io, projects }) {
  const pendingBroadcastTimers = new Map();

  function broadcastCanvas(id) {
    const p = projects.get(id);
    io.to(id).emit("canvas-state", { projectId: id, state: p?.canvasState ?? null });
    // Whenever the canvas changes, the reel composition might have
    // changed too — schedule a debounced background ffmpeg concat so
    // smooth playback is ready by the time the user hits Play. No-op
    // for compositions that are already cached or that have no reel.
    kickReelPrebuild({ projects, id });
  }

  function broadcastPositions(id) {
    const p = projects.get(id);
    io.to(id).emit("canvas-positions", {
      projectId: id,
      state: p?.canvasPositions ?? EMPTY_POSITIONS(),
    });
  }

  // Leading-delay debounce: first call schedules the timer, subsequent
  // calls within the window no-op; the emit on fire reads current state.
  function broadcastPending(id) {
    if (pendingBroadcastTimers.has(id)) return;
    const timer = setTimeout(() => {
      pendingBroadcastTimers.delete(id);
      const p = projects.get(id);
      io.to(id).emit("pending-generations", {
        projectId: id,
        state: Array.from(p?.pendingGenerations?.values() ?? []),
      });
    }, PENDING_BROADCAST_DEBOUNCE_MS);
    pendingBroadcastTimers.set(id, timer);
  }

  function broadcastGenerationResults(id) {
    const p = projects.get(id);
    io.to(id).emit("generation-results", {
      projectId: id,
      state: Array.from(p?.generationResults?.values() ?? [])
        .sort(compareResultSummaries)
        .slice(0, GENERATION_RESULTS_BUNDLE_LIMIT),
    });
  }

  // Copy the dragged pending position onto the freshly-minted node.
  // Emits canvas-positions BEFORE canvas-state so the browser merges
  // both in one React batch — no spiral-placement flash. Disk write is
  // fire-and-forget under the positions lock; in-memory is authoritative
  // and the broadcast already carries it.
  function handoffPendingPosition(proj, envelope, reply) {
    const jobId = envelope?.pending_job_id;
    if (typeof jobId !== "string" || jobId === "") return;
    if (envelope.op !== "addBatch") return;
    const newNodeId = reply?.assigned?.node_ids?.[0];
    if (typeof newNodeId !== "string") return;
    const pendingEntry = proj.pendingGenerations?.get(jobId);
    const pos = pendingEntry?.position;
    if (
      pos === undefined ||
      pos === null ||
      typeof pos.x !== "number" ||
      typeof pos.y !== "number"
    ) {
      return;
    }
    if (!proj.canvasPositions) proj.canvasPositions = EMPTY_POSITIONS();
    proj.canvasPositions.positions[newNodeId] = { x: pos.x, y: pos.y };
    broadcastPositions(proj.id);
    withProjectMutationLock(proj.id, () =>
      writeCanvasPositions(proj.id, proj.canvasPositions),
    ).catch((err) => {
      console.warn(
        `[viewer] handoff write failed for ${proj.id}/${newNodeId}: ${err.message}`,
      );
    });
  }

  const mutatorHooks = {
    onApply: (proj, envelope, reply) => {
      handoffPendingPosition(proj, envelope, reply);
      broadcastCanvas(proj.id);
    },
  };

  return {
    broadcastCanvas,
    broadcastPositions,
    broadcastPending,
    broadcastGenerationResults,
    mutatorHooks,
  };
}
