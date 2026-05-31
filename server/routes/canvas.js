// Canvas routes: the generic /mutate envelope (the agent's main entry
// point), the convenience PATCH wrappers (used by the renderer's
// Timeline drag-reorder), the positions sidecar PATCH, the group-frame
// upsert/move/delete (sidecar siblings to /positions), and the
// asset-preupload kick.

import { mutate } from "../canvas_mutator.js";
import { preuploadCanvasUrl } from "../pai_assets_client.js";
import { statusForKlass } from "../lib/broadcasters.js";
import { withProjectMutationLock, writeCanvasPositions } from "../lib/writers.js";

export function registerCanvasRoutes({ app, io, projects, mutatorHooks }) {
  // POST /projects/:id/preupload-asset — paired with server/scripts/_preupload_hook.js
  // (see there for why CLIs can't broadcast their own asset events).
  // Body: { local_path, mime_type? }. local_path is the disk-relative
  // form (e.g. "assets/images/image_5.png") read off the asset node;
  // the viewer composes the canonical key + tunnel URL itself.
  app.post("/projects/:id/preupload-asset", async (req, res) => {
    const id = req.params.id;
    if (!projects.has(id)) return res.status(404).json({ ok: false, error: "not found" });
    const { local_path, mime_type } = req.body ?? {};
    if (typeof local_path !== "string") {
      return res.status(400).json({ ok: false, error: "local_path required" });
    }
    preuploadCanvasUrl({ projectId: id, localPath: local_path, mimeType: mime_type });
    res.json({ ok: true });
  });

  // POST /projects/:id/mutate — generic mutator entry. Body is the envelope
  // minus project_id (taken from the path). See server/canvas_mutator.js
  // for ops + reducer table.
  app.post("/projects/:id/mutate", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const envelope = { ...req.body, project_id: id };
    const reply = await mutate(p, envelope, mutatorHooks);
    if (reply.ok) return res.json(reply);
    return res.status(statusForKlass(reply.klass)).json(reply);
  });

  // PATCH /projects/:id/nodes/:nodeId/data — partial merge into a node's
  // `data`. Body: { shot_id: 3 } or { shot_id: null } to remove. Wraps the
  // mutator's updateNode op so timeline drag-shot changes share one writer
  // path with the agent.
  app.patch("/projects/:id/nodes/:nodeId/data", async (req, res) => {
    const id = req.params.id;
    const nodeId = req.params.nodeId;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const patch = req.body;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return res.status(400).json({ error: "body must be a flat object" });
    }
    const reply = await mutate(
      p,
      {
        request_id: `viewer-patch-${id}-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        op: "updateNode",
        payload: { id: nodeId, patch },
        actor: "viewer",
      },
      mutatorHooks,
    );
    if (!reply.ok) {
      return res.status(statusForKlass(reply.klass)).json({ error: reply.message });
    }
    const node = p.canvasState.nodes.find((n) => n.id === nodeId);
    res.json({ ok: true, node });
  });

  // PATCH /projects/:id/nodes/batch-data — apply many shallow data merges
  // in one atomic mutation (one disk write + one canvas-state emit). Used
  // by the Timeline tab's drag-reorder; renumbering N shots in N separate
  // requests would race the UI.
  app.patch("/projects/:id/nodes/batch-data", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const updates = req.body?.updates;
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: "body.updates must be an array of {nodeId, data}" });
    }
    const mutatorUpdates = [];
    for (const u of updates) {
      if (!u || typeof u !== "object") continue;
      if (typeof u.nodeId !== "string" || !u.data || typeof u.data !== "object") continue;
      mutatorUpdates.push({ id: u.nodeId, patch: u.data });
    }
    const reply = await mutate(
      p,
      {
        request_id: `viewer-batch-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        op: "updateBatch",
        payload: { updates: mutatorUpdates },
        actor: "viewer",
      },
      mutatorHooks,
    );
    if (!reply.ok) {
      return res.status(statusForKlass(reply.klass)).json({ error: reply.message });
    }
    res.json({ ok: true, count: mutatorUpdates.length });
  });

  // ---- canvas_positions sidecar (drag positions + group frames) ----
  //
  // Both endpoint families share `withProjectMutationLock` to guard the
  // single sidecar file, then re-broadcast the full sidecar state to
  // every connected tab.

  app.patch("/projects/:id/positions", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res.status(400).json({ error: "body must be { nodeId: {x,y}, … }" });
    }
    try {
      await withProjectMutationLock(id, async () => {
        // Build the membership set inside the lock so a concurrent canvas-state
        // change can't race the validation. Deletes are always honored (lets a
        // stale entry be cleaned up); writes require a known node id, otherwise
        // the sidecar grows ghosts whenever the agent typos.
        const knownIds = new Set(
          Array.isArray(p.canvasState?.nodes) ? p.canvasState.nodes.map((n) => n.id) : [],
        );
        for (const [nodeId, pos] of Object.entries(updates)) {
          if (pos === null) {
            delete p.canvasPositions.positions[nodeId];
          } else if (
            pos && typeof pos === "object" &&
            typeof pos.x === "number" && typeof pos.y === "number" &&
            knownIds.has(nodeId)
          ) {
            p.canvasPositions.positions[nodeId] = { x: pos.x, y: pos.y };
          }
        }
        await writeCanvasPositions(id, p.canvasPositions);
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    io.to(id).emit("canvas-positions", { projectId: id, state: p.canvasPositions });
    res.json({ ok: true });
  });

  app.put("/projects/:id/group-frames/:frameId", async (req, res) => {
    const id = req.params.id;
    const frameId = req.params.frameId;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const frame = req.body;
    if (!frame || typeof frame !== "object") {
      return res.status(400).json({ error: "frame body required" });
    }
    try {
      await withProjectMutationLock(id, async () => {
        p.canvasPositions.groupFrames[frameId] = frame;
        await writeCanvasPositions(id, p.canvasPositions);
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    io.to(id).emit("canvas-positions", { projectId: id, state: p.canvasPositions });
    res.json({ ok: true });
  });

  app.patch("/projects/:id/group-frames/:frameId/position", async (req, res) => {
    const id = req.params.id;
    const frameId = req.params.frameId;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const pos = req.body;
    if (typeof pos?.x !== "number" || typeof pos?.y !== "number") {
      return res.status(400).json({ error: "{x,y} required" });
    }
    let notFound = false;
    try {
      await withProjectMutationLock(id, async () => {
        const existing = p.canvasPositions.groupFrames[frameId];
        if (!existing) { notFound = true; return; }
        existing.x = pos.x;
        existing.y = pos.y;
        await writeCanvasPositions(id, p.canvasPositions);
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (notFound) return res.status(404).json({ error: "frame not found" });
    io.to(id).emit("canvas-positions", { projectId: id, state: p.canvasPositions });
    res.json({ ok: true });
  });

  app.delete("/projects/:id/group-frames/:frameId", async (req, res) => {
    const id = req.params.id;
    const frameId = req.params.frameId;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    try {
      await withProjectMutationLock(id, async () => {
        delete p.canvasPositions.groupFrames[frameId];
        await writeCanvasPositions(id, p.canvasPositions);
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    io.to(id).emit("canvas-positions", { projectId: id, state: p.canvasPositions });
    res.json({ ok: true });
  });
}
