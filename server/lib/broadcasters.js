// Socket.IO broadcast helpers + the mutator's onApply hook + the
// klass→HTTP-status mapper. Factory shape so the io instance + projects
// Map are closed-over once and re-used across routes and the watcher.

import {
  compareResultSummaries,
  EMPTY_POSITIONS,
  GENERATION_RESULTS_BUNDLE_LIMIT,
} from "./readers.js";
import { kickReelPrebuild } from "./reel_cache.js";
import {
  updateProjectMeta,
  withProjectMutationLock,
  writeCanvasPositions,
} from "./writers.js";

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

  // Garbage-collect a deleted node's id out of the positions sidecar:
  // its drag position and any group-frame membership. workflow.json
  // (mutator PQueue) and canvas_positions.json (withProjectMutationLock)
  // are separate stores, so deleteNode otherwise leaves the id lingering
  // in positions{} and groupFrames[*].memberIds — a frame keeps sizing a
  // ghost member until that frame is next re-saved (audit N45).
  //
  // Unlike handoffPendingPosition (N41), the read-modify-write happens
  // ENTIRELY inside the lock: we read proj.canvasPositions, mutate it, and
  // persist within the same callback so no other sidecar writer can
  // interleave. Broadcast only after the write commits.
  async function pruneDeletedNodesFromPositions(proj, envelope, reply) {
    if (envelope.op !== "deleteNode") return;
    const deletedIds = reply?.assigned?.deleted_node_ids;
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    const deleted = new Set(deletedIds);
    let changed = false;
    await withProjectMutationLock(proj.id, async () => {
      const pos = proj.canvasPositions;
      if (!pos) return;
      for (const id of deleted) {
        if (Object.prototype.hasOwnProperty.call(pos.positions ?? {}, id)) {
          delete pos.positions[id];
          changed = true;
        }
      }
      for (const [frameId, frame] of Object.entries(pos.groupFrames ?? {})) {
        if (!frame || !Array.isArray(frame.memberIds)) continue;
        const kept = frame.memberIds.filter((m) => !deleted.has(m));
        if (kept.length === frame.memberIds.length) continue;
        changed = true;
        // A frame needs >=2 members to render (see canvas_layout.js
        // normalizeFrame); drop one that falls below after pruning.
        if (kept.length < 2) delete pos.groupFrames[frameId];
        else frame.memberIds = kept;
      }
      if (changed) await writeCanvasPositions(proj.id, pos);
    });
    if (changed) broadcastPositions(proj.id);
  }

  async function mirrorTitleToMeta(proj, envelope) {
    if (envelope?.op !== "setTitle") return;
    const title = envelope?.payload?.title;
    if (typeof title !== "string") return;
    try {
      const { changed, meta } = await updateProjectMeta(proj.id, proj, (next) => {
        if (next.title === title) return false;
        next.title = title;
      });
      if (changed) {
        io.to(proj.id).emit("title", {
          projectId: proj.id,
          title: meta.title,
          dangerously_skip_draft_gate: !!meta.dangerously_skip_draft_gate,
        });
      }
    } catch (e) {
      console.warn(`[viewer] title mirror failed for ${proj.id}: ${e.message}`);
    }
  }

  const mutatorHooks = {
    onApply: async (proj, envelope, reply) => {
      handoffPendingPosition(proj, envelope, reply);
      await pruneDeletedNodesFromPositions(proj, envelope, reply);
      await mirrorTitleToMeta(proj, envelope);
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
