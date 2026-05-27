// Project CRUD + per-project read-only routes (asset serving and
// chat-history). All of these are `/projects/:id/...` paths that need
// the projects Map, so they share one module.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  getProvider,
  resolveAgentIdForMeta,
  resolveAgentIdForNewProject,
} from "../agents/index.js";
import { mutate } from "../canvas_mutator.js";
import {
  ACTIVE_FILE,
  PROJECTS_DIR,
  ROOT_LINK,
  genProjectId,
  projectDir,
  slugify,
  workflowPath,
} from "../lib/paths.js";
import { readActive, writeActive, writeMeta } from "../lib/writers.js";
import {
  compareResultSummaries,
  GENERATION_RESULTS_BUNDLE_LIMIT,
} from "../lib/readers.js";
import {
  ensureProjectStructure,
  loadProject,
} from "../services/projects.js";
import { killPty } from "../services/socket.js";
import { rowFor } from "./system.js";

const ALLOWED_ASSET_KINDS = new Set(["images", "videos", "audios", "refs", "notes"]);

export function registerProjectsRoutes({ app, io, projects, mutatorHooks }) {
  app.post("/projects", async (req, res) => {
    try {
      const titleIn = (req.body?.title || "").trim();
      let id;
      if (titleIn) {
        // User-supplied title → slugify and disambiguate with -N suffix.
        const baseSlug = slugify(titleIn);
        id = baseSlug;
        let n = 1;
        while (projects.has(id) || fs.existsSync(projectDir(id))) {
          n += 1;
          id = `${baseSlug}-${n}`;
        }
      } else {
        // Untitled → random `project_<6char>` id (replaces the old
        // `untitled` / `untitled-N` sequence). Loop on the slim chance
        // of a collision.
        do {
          id = genProjectId();
        } while (projects.has(id) || fs.existsSync(projectDir(id)));
      }
      const agentId = resolveAgentIdForNewProject();
      await ensureProjectStructure(id, { agentId });
      const now = new Date().toISOString();
      const meta = {
        id,
        title: titleIn || "Untitled project",
        created_at: now,
        last_active_at: now,
        agent_id: agentId,
        use_server_owned_generation: true,
      };
      await fsp.writeFile(
        workflowPath(id),
        JSON.stringify({ version: 2, workflow_id: id, title: meta.title, nodes: [], edges: [] }, null, 2) + "\n",
      );
      await writeMeta(id, meta);
      await loadProject(projects, id);
      res.status(201).json(rowFor(meta, projects.get(id)));
    } catch (e) {
      console.warn("[viewer] POST /projects failed:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/projects/:id", (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({
      ...rowFor(p.meta, p),
      canvas_state: p.canvasState,
      canvas_positions: p.canvasPositions,
      pending_generations: Array.from(p.pendingGenerations?.values() ?? []),
      generation_results: Array.from(p.generationResults?.values() ?? [])
        .sort(compareResultSummaries)
        .slice(0, GENERATION_RESULTS_BUNDLE_LIMIT),
    });
  });

  // PATCH /projects/:id — partial meta update. Accepts `title` (string)
  // and/or `dangerously_skip_draft_gate` (boolean). Title changes mirror
  // into workflow.json via the mutator so the canvas file stays
  // self-describing. The bypass flag is meta-only (canvas doesn't care).
  app.patch("/projects/:id", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const body = req.body ?? {};
    const titleIn = body.title;
    const flagIn = body.dangerously_skip_draft_gate;
    const hasTitle = titleIn !== undefined;
    const hasFlag = flagIn !== undefined;
    if (!hasTitle && !hasFlag) {
      return res.status(400).json({ error: "no patchable fields in body" });
    }
    if (hasTitle && typeof titleIn !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    if (hasFlag && typeof flagIn !== "boolean") {
      return res.status(400).json({ error: "dangerously_skip_draft_gate must be a boolean" });
    }
    try {
      let title = p.meta.title;
      if (hasTitle) {
        title = titleIn.trim().slice(0, 120) || "Untitled project";
        p.meta.title = title;
      }
      if (hasFlag) {
        // Store true explicitly; clear on false so the meta stays
        // minimal for projects that never enabled bypass.
        if (flagIn) p.meta.dangerously_skip_draft_gate = true;
        else delete p.meta.dangerously_skip_draft_gate;
      }
      await writeMeta(id, p.meta);
      if (hasTitle && p.canvasState && typeof p.canvasState === "object") {
        const reply = await mutate(
          p,
          {
            request_id: `viewer-title-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            op: "setTitle",
            payload: { title },
            actor: "viewer",
          },
          mutatorHooks,
        );
        if (!reply.ok) {
          console.warn(`[viewer] title mirror failed for ${id}: ${reply.message}`);
        }
      }
      io.to(id).emit("title", {
        projectId: id,
        title,
        dangerously_skip_draft_gate: !!p.meta.dangerously_skip_draft_gate,
      });
      res.json({ ok: true, row: rowFor(p.meta, p) });
    } catch (e) {
      console.warn(`[viewer] PATCH /projects/${id} failed:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /projects/:id — soft delete. The project disappears from the
  // grid but its files stay on disk: we move `projects/<id>/` into
  // `projects/.archive/<id>_<timestamp>/`. The archive dir starts with
  // `.` so isValidId rejects it, which keeps the loader / chokidar from
  // surfacing it again. Pty is killed, active-pointer flipped, claude
  // session dir is left alone. Restore is a manual `mv` from
  // `projects/.archive/` back to `projects/`.
  app.delete("/projects/:id", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    try {
      killPty(id);

      // Pick a new active project before moving the dir so the symlinks
      // never point at the soon-to-be-archived location.
      const wasActive = (await readActive()) === id;
      let nextActiveId = null;
      if (wasActive) {
        const others = Array.from(projects.values())
          .filter((q) => q.meta.id !== id)
          .sort((a, b) =>
            Date.parse(b.meta.last_active_at) - Date.parse(a.meta.last_active_at),
          );
        nextActiveId = others[0]?.meta.id ?? null;
        if (nextActiveId) {
          await writeActive(nextActiveId);
        } else {
          try { await fsp.unlink(ROOT_LINK); } catch {}
          try { await fsp.unlink(ACTIVE_FILE); } catch {}
        }
      }

      const archiveRoot = path.join(PROJECTS_DIR, ".archive");
      await fsp.mkdir(archiveRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archived = path.join(archiveRoot, `${id}_${stamp}`);
      await fsp.rename(projectDir(id), archived);

      projects.delete(id);
      res.json({ ok: true, deleted: id, archived_to: archived, new_active: nextActiveId });
    } catch (e) {
      console.warn(`[viewer] DELETE /projects/${id} failed:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/projects/:id/activate", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    try {
      await writeActive(id);
      p.meta.last_active_at = new Date().toISOString();
      await writeMeta(id, p.meta);
      res.json({ ok: true, active: id });
    } catch (e) {
      console.warn(`[viewer] activate failed for ${id}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /projects/:id/assets/:kind/:filename — serves mirrored generation
  // assets out of projects/<id>/assets/ so the browser can display them
  // via image_url / video_url / audio_url without any cloud upload. The
  // agent-side `local_mirror.js#viewerUrlForLocalPath` constructs URLs
  // that hit this route.
  app.get("/projects/:id/assets/:kind/:filename", (req, res) => {
    const { id, kind, filename } = req.params;
    // Defense in depth: refuse traversal in any segment. Each route segment
    // is a single path component, but it can contain "." or sneaky bytes.
    for (const seg of [id, kind, filename]) {
      if (!seg || seg.includes("/") || seg.includes("\\") || seg.includes("..") || seg.startsWith(".")) {
        return res.status(400).end();
      }
    }
    if (!projects.has(id)) return res.status(404).end();
    if (!ALLOWED_ASSET_KINDS.has(kind)) return res.status(404).end();
    const rel = path.join("assets", kind, filename);
    // `?download=1` forces a save-to-disk via Content-Disposition: attachment.
    // The download buttons on the canvas live on a cross-origin page (web UI
    // on 7443, this viewer on 7488), and the HTML `download` attribute is
    // silently ignored cross-origin — without this header Chrome navigates
    // the tab to the asset URL instead of downloading. <img>/<video> tags
    // omit the flag and continue to render inline.
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "")}"`,
      );
    }
    // sendFile with `root` anchors the resolution at projectDir AND scopes the
    // `dotfiles: "deny"` check to the relative path only. Without `root`, the
    // check inspects the entire absolute path — which 500s on deployments
    // running under a dotfile-prefixed parent (e.g. `.worktrees/<branch>/`).
    // The earlier per-segment check already prevents request-side traversal.
    res.sendFile(rel, { root: projectDir(id), dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) {
        if (err.code === "ENOENT") return res.status(404).end();
        return res.status(500).end();
      }
    });
  });

  // GET /projects/:id/chat-history — returns the parsed messages of the
  // owning agent's most-recent session.
  // Used by the chat-history sidebar to seed a project's transcript view
  // when the user reopens it.
  app.get("/projects/:id/chat-history", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    try {
      const provider = getProvider(resolveAgentIdForMeta(p.meta));
      if (!provider) return res.json({ session_id: null, mtime: null, messages: [] });
      const latest = await provider.findLatestSession(id);
      if (!latest) return res.json({ session_id: null, mtime: null, messages: [] });
      const messages = await provider.parseHistory(latest);
      res.json({ session_id: latest.sessionId, mtime: latest.mtime, messages });
    } catch (e) {
      console.warn(`[viewer] chat-history failed for ${id}:`, e);
      res.status(500).json({ error: e.message });
    }
  });
}
