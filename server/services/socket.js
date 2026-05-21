// Socket.IO surface — the connection handler, the PTY bridge, and the
// asset-preupload event fanout. All three share the same socket
// instance and the same `projects` Map, so they live together.
//
// Connection lifecycle:
//   client connects → `subscribe { projectId }` joins the room, seeds
//   all five state events (title, canvas-state, canvas-positions,
//   pending-generations, pai-assets-snapshot), and re-pre-uploads any
//   image_result whose asset-cache entry has expired. Same socket can
//   then issue pty:* messages to drive the embedded terminal.
//
// Socket event names `pai-assets` and `pai-assets-snapshot` are the
// wire protocol with the browser client.
//
// PTY persistence model — tmux-style.
//
// Each project has at most ONE shell+claude process, kept alive across
// browser tabs and disconnects. Closing a tab detaches the socket but
// leaves the pty running, so an in-flight `generate_video.js` (2-4
// minute job) survives the user navigating away. Re-opening the
// project's URL re-attaches and replays the recent stdout buffer so the
// terminal looks like it never went away.
//
// ptys: projectId -> {
//   pty,                      // node-pty handle (carries its own cols/rows)
//   buffer,                   // rolling stdout (last PTY_BUFFER_CAP bytes) for replay
//   subscribers,              // Set<socket.id> currently attached
// }

import {
  paiAssetEvents,
  preuploadCanvasUrl,
  snapshotAssetStates,
} from "../pai_assets_client.js";
import {
  PROJECT_ROOT,
  projectDir,
  projectIdFromCanvasUrl,
} from "../lib/paths.js";
import { findLatestSessionFile, readMeta } from "../lib/readers.js";

const ptys = new Map();
const socketAttach = new Map();           // socket.id -> projectId
const PTY_BUFFER_CAP = 256 * 1024;        // 256 KB rolling tail; xterm scrollback handles the rest

function detachSocket(socketId) {
  const projectId = socketAttach.get(socketId);
  if (!projectId) return;
  socketAttach.delete(socketId);
  const entry = ptys.get(projectId);
  if (entry) entry.subscribers.delete(socketId);
}

export function killPty(projectId) {
  const entry = ptys.get(projectId);
  if (!entry) return;
  try { entry.pty.kill(); } catch {}
  ptys.delete(projectId);
  for (const sid of entry.subscribers) socketAttach.delete(sid);
}

// Inject text into a project's PTY as if the user had typed it. No trailing
// \r — bytes land in claude's input box, user decides whether to submit.
// Auto-submit would need the two-connection orchestration documented in
// PR #23 (brittle to TUI changes); text-only uses the same single path the
// browser uses for every keystroke. Returns false if no PTY is attached.
export function writeToProjectPty(projectId, text) {
  const entry = ptys.get(projectId);
  if (!entry) return false;
  try { entry.pty.write(text); return true; } catch { return false; }
}

// Shut every pty down cleanly on viewer exit so dev's Ctrl+C doesn't
// orphan claude processes (they'd otherwise live until the user kills
// them by hand).
export function killAllPtys() {
  for (const projectId of Array.from(ptys.keys())) killPty(projectId);
}

// Walk a project's image_result nodes and pre-upload any whose canvas
// URL isn't already in the cache. Used by subscribe to recover chip
// state for projects re-opened across viewer restarts or asset
// expiration. Idempotent — preuploadCanvasUrl's own _assetCache.has
// check short-circuits already-uploaded entries.
function backfillProjectAssets(p) {
  const projectId = p.meta.id;
  for (const n of p.canvasState?.nodes ?? []) {
    if (n.type !== "image_result") continue;
    const localPath = n.data?.local_path;
    if (typeof localPath !== "string" || !localPath) continue;
    preuploadCanvasUrl({ projectId, localPath });
  }
}

// Wire the pty:* handlers onto a single socket. The fresh-spawn vs.
// re-attach branch is the heart of tmux-style persistence.
function registerSocketPtyHandlers({ socket, io, projects, nodePty }) {
  socket.on("pty:spawn", ({ projectId, cols: rawCols, rows: rawRows } = {}) => {
    // Reject 0/<10 cols — client may emit before xterm has fit a visible container.
    const cols = (typeof rawCols === "number" && rawCols >= 10) ? rawCols : 80;
    const rows = (typeof rawRows === "number" && rawRows >= 3)  ? rawRows : 24;
    if (!nodePty) {
      socket.emit("pty:error", "node-pty not available; rebuild server with native deps");
      return;
    }
    if (!projectId || !projects.has(projectId)) {
      socket.emit("pty:error", "no such project");
      return;
    }

    // If this socket was attached to a different project, detach first.
    const prevAttach = socketAttach.get(socket.id);
    if (prevAttach && prevAttach !== projectId) detachSocket(socket.id);

    // Re-attach path: pty already exists for this project.
    const existing = ptys.get(projectId);
    if (existing) {
      existing.subscribers.add(socket.id);
      socketAttach.set(socket.id, projectId);
      // Match the pty's dimensions to what THIS client expects so the
      // first frame after replay isn't wrapped wrong. If multiple tabs
      // are attached, the most-recent resize wins — same as tmux.
      try { existing.pty.resize(cols, rows); } catch {}
      socket.emit("pty:spawned", { pid: existing.pty.pid, attached: true });
      if (existing.buffer) socket.emit("pty:output", existing.buffer);
      return;
    }

    // Fresh-spawn path.
    const cwd = projectDir(projectId);
    // Strip Anthropic auth env vars so `claude` always uses the user's
    // ~/.claude/ login. Otherwise, when the shell inherits a developer's
    // ANTHROPIC_API_KEY, claude prompts "Detected a custom API key" and
    // hangs the embedded terminal until the user picks an option.
    const {
      ANTHROPIC_API_KEY: _a,
      ANTHROPIC_AUTH_TOKEN: _b,
      CLAUDE_API_KEY: _c,
      ...passthroughEnv
    } = process.env;
    const env = {
      ...passthroughEnv,
      TERM: "xterm-256color",
      // Absolute path to the repo root, so the agent can invoke media CLIs
      // as `"$PAI_REPO_ROOT/server/scripts/<x>.js"` regardless of the
      // per-project cwd. See CLAUDE.md § "Media CLIs".
      PAI_REPO_ROOT: PROJECT_ROOT,
      // Pad PATH so `claude` resolves under whatever shell launched us.
      PATH: [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        process.env.PATH || "",
        `${process.env.HOME || ""}/.npm-global/bin`,
        `${process.env.HOME || ""}/.local/bin`,
      ].filter(Boolean).join(":"),
    };
    let pty;
    try {
      pty = nodePty.spawn(process.env.SHELL || "/bin/zsh", ["-l"], {
        name: "xterm-256color",
        cols, rows, cwd, env,
      });
    } catch (e) {
      socket.emit("pty:error", `spawn failed: ${e.message}`);
      return;
    }
    const entry = {
      pty,
      buffer: "",
      subscribers: new Set([socket.id]),
    };
    ptys.set(projectId, entry);
    socketAttach.set(socket.id, projectId);

    pty.onData((data) => {
      entry.buffer += data;
      if (entry.buffer.length > PTY_BUFFER_CAP) {
        entry.buffer = entry.buffer.slice(-PTY_BUFFER_CAP);
      }
      for (const sid of entry.subscribers) {
        io.sockets.sockets.get(sid)?.emit("pty:output", data);
      }
    });
    pty.onExit((evt) => {
      for (const sid of entry.subscribers) {
        io.sockets.sockets.get(sid)?.emit("pty:exit", evt);
        socketAttach.delete(sid);
      }
      ptys.delete(projectId);
    });
    socket.emit("pty:spawned", { pid: pty.pid, attached: false });
    // Auto-launch claude after the shell settles. Resume the most recent
    // session in the project's cwd if one exists so the user keeps full
    // context across browser refreshes — `claude --continue` is what the
    // CLI uses for "pick up where I left off". If no session exists yet,
    // fall back to a fresh `claude`.
    //
    // Per-project overrides come from meta.json:
    //   claude_model  — alias (sonnet|opus|haiku) or full id (claude-opus-4-7)
    //                   Defaults to `sonnet` when unset.
    //   claude_effort — low|medium|high|xhigh|max. `xhigh` is Opus-only;
    //                   Sonnet silently clamps it to `high`, which is why
    //                   the default here is `max` (Sonnet's top level).
    setTimeout(async () => {
      let flagsSuffix = " --model sonnet --effort max";
      try {
        const meta = await readMeta(projectId);
        const safe = (v) => typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v);
        const model = safe(meta?.claude_model) ? meta.claude_model : "sonnet";
        const effort = safe(meta?.claude_effort) ? meta.claude_effort : "max";
        flagsSuffix = ` --model ${model} --effort ${effort}`;
      } catch { /* keep the default suffix */ }
      let cmd = `claude${flagsSuffix}\r`;
      try {
        const latest = await findLatestSessionFile(projectId);
        if (latest) cmd = `claude --continue${flagsSuffix}\r`;
      } catch { /* fall back to plain claude */ }
      try { pty.write(cmd); } catch {}
    }, 500);
  });

  socket.on("pty:input", (data) => {
    const projectId = socketAttach.get(socket.id);
    if (!projectId) return;
    const entry = ptys.get(projectId);
    if (entry && typeof data === "string") {
      try { entry.pty.write(data); } catch {}
    }
  });

  socket.on("pty:resize", ({ cols, rows } = {}) => {
    const projectId = socketAttach.get(socket.id);
    if (!projectId) return;
    const entry = ptys.get(projectId);
    if (!entry || typeof cols !== "number" || typeof rows !== "number") return;
    // Reject obviously-bad sizes — client may emit while xterm container is hidden.
    if (cols < 10 || rows < 3) return;
    try { entry.pty.resize(cols, rows); } catch {}
  });

  // Closing a tab leaves the pty running so it survives reattach;
  // pty:kill is the explicit teardown path (e.g. a Stop button).
  socket.on("pty:kill", () => {
    const projectId = socketAttach.get(socket.id);
    if (projectId) killPty(projectId);
  });

  socket.on("disconnect", () => detachSocket(socket.id));
}

// Single entry point: wire the io-level asset-event listener once, then
// register the per-socket subscribe + pty handlers on every connect.
export function registerSocketHandlers({ io, projects, nodePty }) {
  // Forward asset-preupload status updates to the project's room.
  // Terminal-state persistence (active / rejected) is handled separately
  // by services/asset_sync.js, which dispatches a mutator updateNode
  // patch onto the owning node's data.metadata — workflow.json is the
  // durable cache.
  paiAssetEvents.on("update", (evt) => {
    const projectId = projectIdFromCanvasUrl(evt?.url);
    if (!projectId) return;
    io.to(projectId).emit("pai-assets", evt);
  });

  io.on("connection", (socket) => {
    socket.on("subscribe", ({ projectId } = {}) => {
      const p = projects.get(projectId);
      if (!p) return;
      socket.join(projectId);
      socket.emit("subscribed", { projectId });
      socket.emit("title", { projectId, title: p.meta.title });
      socket.emit("canvas-state",     { projectId, state: p.canvasState });
      socket.emit("canvas-positions", { projectId, state: p.canvasPositions });
      socket.emit("pending-generations", {
        projectId,
        state: Array.from(p.pendingGenerations?.values() ?? []),
      });
      // Replay cached asset statuses so chips render on load, not on the next flip.
      const projectEntries = {};
      for (const [url, entry] of Object.entries(snapshotAssetStates())) {
        if (projectIdFromCanvasUrl(url) === projectId) projectEntries[url] = entry;
      }
      socket.emit("pai-assets-snapshot", { projectId, state: projectEntries });

      // Backfill: re-pre-upload any image_result whose canvas URL isn't in the
      // cache yet. Lights up chips on projects re-opened across viewer restarts
      // or after upstream expiration. Idempotent via preuploadCanvasUrl's own
      // _assetCache.has check; no-op when PAI_KEY isn't configured.
      backfillProjectAssets(p);
    });

    registerSocketPtyHandlers({ socket, io, projects, nodePty });
  });
}
