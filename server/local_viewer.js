// pai-pro — local viewer server (entry point).
//
// Watches each project's workflow.json (canvas state), meta.json
// (title/timestamps) and canvas_positions.json (drag positions +
// group frames) on disk and pushes them to the browser via Socket.IO.
// Also bridges an in-browser xterm.js terminal to a node-pty process
// running `claude` with cwd=projects/<active>/.
//
// File layout (from the repo root):
//   projects/<id>/workflow.json          — the canvas (nodes/edges/groups)
//   projects/<id>/meta.json              — { id, title, created_at, last_active_at, claude_session_id? }
//   projects/<id>/assets/                — local mirror of generated media
//   projects/<id>/canvas_positions.json  — drag positions + group frames sidecar
//   .active_project                      — id of the active project
//   workflow.json                        — symlink → projects/<active>/workflow.json
//
// HTTP endpoints:
//   GET    /                                              health
//   GET    /projects                                      list
//   POST   /projects                                      create
//   GET    /projects/:id                                  bundle: { row, canvas_state, canvas_positions, pending_generations }
//   GET    /projects/:id/reel.mp4                          stitch every shot-id'd clip and stream as a download
//   PATCH  /projects/:id                                   update meta (title)
//   DELETE /projects/:id                                   soft delete (move to projects/.archive/)
//   POST   /projects/:id/activate                         flip active symlinks
//   PATCH  /projects/:id/positions                        merge { nodeId: {x,y}, … } into positions
//   PUT    /projects/:id/group-frames/:frameId            upsert a group frame
//   PATCH  /projects/:id/group-frames/:frameId/position   move an existing frame
//   DELETE /projects/:id/group-frames/:frameId            remove a frame
//
// Socket.IO:
//   subscribe { projectId }   — join the project's room and seed all state
//   canvas-state              — workflow.json on every disk change
//   canvas-positions          — sidecar on every disk change
//   title                     — { projectId, title } on meta change
//
//   pty:spawn { projectId?, cols?, rows? }  — start a new claude pty
//   pty:input data            — keystrokes from browser → pty stdin
//   pty:output data           — pty stdout → browser
//   pty:resize { cols, rows } — terminal resize
//   pty:kill                  — terminate this socket's pty
//   pty:spawned { pid }       — server confirms spawn
//   pty:exit                  — pty closed
//   pty:error message         — pty unavailable (e.g. node-pty not installed)
//
// Implementation is split across lib/, services/, and routes/; this
// file is the boot orchestrator.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import { Server as SocketServer } from "socket.io";

import { createBroadcasters } from "./lib/broadcasters.js";
import { PORT, PROJECTS_DIR, WEB_ORIGIN } from "./lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, "..", "web", "dist");
const IS_PROD = process.env.NODE_ENV === "production";

// Prod binds to 0.0.0.0 so Docker's port forwarder can reach the
// process; the host-side LAN defense lives in docker-compose.yml (host
// port pinned to 127.0.0.1). Dev binds straight to loopback — no
// Docker layer to defend behind, and the upload / pty:spawn surfaces
// are unauthenticated. Override via VIEWER_BIND.
const BIND = process.env.VIEWER_BIND ?? (IS_PROD ? "0.0.0.0" : "127.0.0.1");
import { readActive, writeActive } from "./lib/writers.js";
import { registerCanvasRoutes } from "./routes/canvas.js";
import { registerPendingRoutes } from "./routes/pending.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerReelRoutes } from "./routes/reel.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { primeProjects } from "./services/projects.js";
import {
  killAllPtys,
  registerSocketHandlers,
} from "./services/socket.js";
import { wireAssetSync } from "./services/asset_sync.js";
import { watchProjects } from "./services/watcher.js";

// id -> { meta, canvasState, canvasPositions, pendingGenerations, ... }
const projects = new Map();

// Lazy-import node-pty so a missing native build doesn't crash the viewer.
let nodePty = null;
try {
  const mod = await import("node-pty");
  nodePty = mod.default || mod;
} catch (e) {
  console.warn(`[viewer] node-pty unavailable; terminal panel will be disabled (${e.message})`);
}

const app = express();
// Dev only: the React frontend lives on a different origin (Vite
// :7443) and needs explicit CORS to talk to the viewer. Prod serves
// the bundle from the same origin as the API, so CORS isn't needed —
// same-origin bypasses it, and skipping the middleware closes a CSRF
// vector against the unauthenticated mutation surface. Same option
// is applied to Socket.IO below.
const corsOptions = IS_PROD ? null : { origin: WEB_ORIGIN, credentials: true };
if (corsOptions) app.use(cors(corsOptions));
app.use(express.json());

// Production: serve the prebuilt web bundle from web/dist BEFORE the API
// routes. express.static passes through to next() when a path doesn't
// resolve to a file, so /projects, /healthz, /models all still hit their
// API handlers — only real static files (/assets/*, /favicon.ico, etc.)
// are intercepted. Dev mode keeps the legacy split (Vite serves :7443,
// viewer serves :7488 API-only).
if (IS_PROD) {
  app.use(express.static(STATIC_DIR));
}

const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, corsOptions ? { cors: corsOptions } : undefined);

const broadcasters = createBroadcasters({ io, projects });
const { mutatorHooks } = broadcasters;

registerSystemRoutes({ app, projects, nodePty });
registerProjectsRoutes({ app, io, projects, mutatorHooks });
registerReelRoutes({ app, projects });
registerCanvasRoutes({ app, io, projects, mutatorHooks });
registerUploadRoutes({ app, io, projects, mutatorHooks });
registerPendingRoutes({ app, projects });

registerSocketHandlers({ io, projects, nodePty });
// Persists video-generation-assets terminal states (active / rejected) onto the owning
// node's data.metadata via the canvas mutator. Replaces .asset_cache.json.
wireAssetSync({ projects, mutatorHooks });

// SPA fallback (production only) — any GET that didn't match an API
// route or a static file gets index.html. React Router takes it from
// there. Excludes /socket.io (handled by Socket.IO's own attach).
if (IS_PROD) {
  app.get(/^\/(?!socket\.io).*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
}

// Verbose boot log behind DEBUG=1. Default output is a single friendly
// "ready, open this URL" block printed at the end of httpServer.listen.
// Set DEBUG=1 in .env to get the full URL table + watcher state.
const DEBUG = process.env.DEBUG === "1";

async function boot() {
  if (DEBUG) console.log(`[viewer] booting (port=${PORT}) …`);
  await primeProjects(projects);
  await watchProjects({ projects, io, broadcasters });

  let active = await readActive();
  if (!active || !projects.has(active)) {
    const fallback = Array.from(projects.values())
      .sort((a, b) => Date.parse(b.meta.last_active_at) - Date.parse(a.meta.last_active_at))[0];
    if (fallback) {
      active = fallback.meta.id;
      await writeActive(active);
      if (DEBUG) console.log(`[viewer] .active_project was missing — defaulted to ${active}`);
    }
  }

  // Docker maps the container's PORT to HOST_VIEWER_PORT on the host;
  // the viewer itself only knows PORT. Prefer the host-side port for
  // user-facing URLs when it's set and differs (Docker mode). Falls
  // back to PORT for host mode / start.sh / anywhere HOST_VIEWER_PORT
  // is unset.
  const hostPortRaw = process.env.HOST_VIEWER_PORT;
  const hostPort = hostPortRaw && hostPortRaw !== String(PORT) ? hostPortRaw : null;
  const publicBase = `http://localhost:${hostPort ?? PORT}`;

  httpServer.listen(PORT, BIND, () => {
    if (DEBUG) {
      console.log(`[viewer] listening on ${BIND}:${PORT} (NODE_ENV=${process.env.NODE_ENV ?? "development"})`);
      if (hostPort) {
        console.log(`[viewer]   container port ${PORT} → host port ${hostPort}`);
      }
      console.log(`[viewer]   ${publicBase}/        ${IS_PROD ? "frontend" : "health JSON"}`);
      console.log(`[viewer]   ${publicBase}/healthz health`);
      console.log(`[viewer]   ${publicBase}/projects projects list`);
      console.log(`[viewer]   active project: ${active ?? "(none)"}`);
      console.log(`[viewer]   pty bridge:     ${nodePty ? "ready" : "disabled (node-pty not installed)"}`);
      console.log(`[viewer]   watching ${PROJECTS_DIR}`);
    }

    // Friendly ready block — always printed. Blank lines top + bottom
    // visually separate it from build / startup chatter so the user
    // can spot it at the bottom of `docker compose up`.
    console.log("");
    console.log("✨ PAI Pro is ready.");
    console.log("");
    console.log(`    Open in your browser:  ${publicBase}`);
    console.log("");
  });
}

// Graceful shutdown — drain the per-project mutation queues so any
// in-flight workflow.json writes (atomic temp-rename) land before we
// exit. Without this, killing the container mid-batch could leave a
// stale .tmp file and a half-written canvas state.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[viewer] ${signal} — draining mutation queues…`);
  httpServer.close();                                  // stop new HTTP
  try { io.emit("viewer-shutdown"); } catch { /* noop */ }
  const drains = Array.from(projects.values())
    .map((p) => p.mutationQueue?.onIdle?.() ?? Promise.resolve());
  await Promise.race([
    Promise.all(drains),
    new Promise((r) => setTimeout(r, 10_000)),         // hard cap 10s
  ]);
  killAllPtys();
  try { io.close(); } catch { /* noop */ }
  console.log(`[viewer] drain complete, exiting`);
  process.exit(0);
}
process.on("SIGINT",  () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

boot().catch((e) => {
  console.error("[viewer] boot failed:", e);
  process.exit(1);
});
