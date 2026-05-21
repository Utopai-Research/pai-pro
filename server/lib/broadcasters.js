// Socket.IO broadcast helpers + the mutator's onApply hook + the
// klass→HTTP-status mapper. Factory shape so the io instance + projects
// Map are closed-over once and re-used across routes and the watcher.

import { EMPTY_POSITIONS } from "./readers.js";
import { kickReelPrebuild } from "./reel_cache.js";
import { withProjectMutationLock, writeCanvasPositions } from "./writers.js";

// Burst N parallel CLIs each write a separate `.pending/<jobId>.json`
// sidecar; chokidar fires N add events in close succession; without
// debouncing, each event triggers its own pending-generations broadcast,
// and the client's placement effect runs once per broadcast with stale
// rfNodesRef — three pads can end up spiral-placed at (0,0) before any
// of them sees the others. Coalescing into one broadcast lets the
// client's gridPackBatch lay them out as a unit, the same way pasted
// images do.
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

  // Leading-delay debounce: the first call schedules a timer; subsequent
  // calls within the window are coalesced into that same timer. When it
  // fires, the broadcast carries the CURRENT pendingGenerations state,
  // which by then includes every write that landed during the window.
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

  return { broadcastCanvas, broadcastPositions, broadcastPending, mutatorHooks };
}
