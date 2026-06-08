// Socket.IO surface — the connection handler, the PTY bridge, and the
// asset-preupload event fanout. All three share the same socket
// instance and the same `projects` Map, so they live together.
//
// Connection lifecycle:
//   client connects → `subscribe { projectId }` joins the room, seeds
//   state events (title, canvas-state, canvas-positions,
//   pending-generations, generation-results, pai-assets-snapshot), and
//   re-pre-uploads any image_result whose asset-cache entry has expired. Same socket can
//   then issue pty:* messages to drive the embedded terminal.
//
// Socket event names `pai-assets` and `pai-assets-snapshot` are the
// wire protocol with the browser client.
//
// PTY persistence model — tmux-style.
//
// Each project has at most ONE shell+agent process, kept alive across
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
import { getProvider, resolveAgentIdForMeta } from "../agents/index.js";
import { resolveAgentBypass } from "../agents/bypass.js";
import {
  PAI_REPO_ROOT,
  projectDir,
  projectIdFromCanvasUrl,
} from "../lib/paths.js";
import {
  compareResultSummaries,
  GENERATION_RESULTS_BUNDLE_LIMIT,
} from "../lib/readers.js";
import { updateProjectMeta } from "../lib/writers.js";

const ptys = new Map();
const socketAttach = new Map();           // socket.id -> projectId
const PTY_BUFFER_CAP = 256 * 1024;        // 256 KB rolling tail; xterm scrollback handles the rest
// Upper bound on how long the auto-launch waits for a shell prompt before
// writing the launch/resume command anyway. A login shell normally prints its
// prompt in well under a second; this only matters on a slow/loaded machine
// where the prompt is late. Guaranteed progress: the command is written at the
// latest after this deadline so the launch never hangs.
const PTY_PROMPT_DEADLINE_MS = 4000;
// Heuristic "shell is idle at a prompt" detector. zsh prints `%`, bash `$`,
// root `#`, and some themes end in `>` or `❯`; tolerate a trailing space and
// any ANSI/OSC trailer the prompt emits after the marker. Best-effort only —
// the bounded deadline above covers prompts this doesn't match.
const SHELL_PROMPT_RE = /[$%#>❯][ \t]*(?:\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~])*[ \t]*$/;

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

// Shut every pty down cleanly on viewer exit so dev's Ctrl+C doesn't
// orphan agent processes (they'd otherwise live until the user kills
// them by hand).
export function killAllPtys() {
  for (const projectId of Array.from(ptys.keys())) killPty(projectId);
}

export async function persistDiscoveredAgentSession(projectId, project, session) {
  const sessionId =
    typeof session?.sessionId === "string" && session.sessionId.trim() !== ""
      ? session.sessionId
      : null;
  if (!sessionId || !project?.meta) return false;
  if (project.meta.agent_session_id === sessionId) return false;

  const { changed } = await updateProjectMeta(projectId, project, (meta) => {
    if (meta.agent_session_id === sessionId) return false;
    meta.agent_session_id = sessionId;
  });
  return changed;
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
  socket.on("pty:spawn", async ({ projectId, cols: rawCols, rows: rawRows } = {}) => {
    // Reject 0/<10 cols — client may emit before xterm has fit a visible container.
    const cols = (typeof rawCols === "number" && rawCols >= 10) ? rawCols : 80;
    const rows = (typeof rawRows === "number" && rawRows >= 3)  ? rawRows : 24;
    if (!nodePty) {
      socket.emit("pty:error", "node-pty not available; rebuild server with native deps");
      return;
    }
    const project = projects.get(projectId);
    if (!projectId || !project) {
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

    const agentId = resolveAgentIdForMeta(project.meta);
    const provider = getProvider(agentId);
    if (!provider) {
      socket.emit("pty:error", `no provider available for agent '${agentId}'`);
      return;
    }

    // Fresh-spawn path.
    const cwd = projectDir(projectId);
    const passthroughEnv = provider.filterEnv(process.env);
    const env = {
      ...passthroughEnv,
      TERM: "xterm-256color",
      // Absolute path to the repo root, so the agent can invoke media CLIs
      // as `"$PAI_REPO_ROOT/server/cli/<x>.js"` regardless of the
      // per-project cwd. See the per-project PROJECT_AGENT.md media CLI table.
      PAI_REPO_ROOT,
      // Pad PATH so agent binaries resolve under whatever shell launched us.
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

    // Auto-launch the owning agent once the shell is ready, resuming the most
    // recent session in the project's cwd if the provider can find one. Writing
    // into a half-initialized `zsh -l` lands the command in a bare terminal, so
    // gate the write on a shell prompt appearing in the pty output. A bounded
    // fallback timer guarantees progress if the prompt is never matched.
    let launched = false;
    let promptProbe = null;
    let promptDeadline = null;
    const launch = async () => {
      if (launched) return;
      launched = true;
      if (promptProbe) { try { promptProbe.dispose(); } catch {} }
      if (promptDeadline) clearTimeout(promptDeadline);

      // Re-fetch the live project: the deferred wait above means it may have
      // been deleted or reloaded (routes/projects.js, services/watcher.js both
      // mutate this Map). The captured `project` could be stale, so abort
      // quietly if it's gone or has been replaced by a different entry.
      const liveProject = projects.get(projectId);
      if (!liveProject || liveProject !== project) {
        console.debug(`[viewer] skipping agent auto-launch for ${projectId}: project gone or replaced`);
        return;
      }

      let latest = null;
      try { latest = await provider.findLatestSession(projectId); }
      catch (e) {
        // Don't silently downgrade a resume to a fresh launch — the agent would
        // lose all prior context. Keep the fresh-launch fallback, but log it.
        console.warn(`[viewer] findLatestSession failed for ${projectId}, launching fresh: ${e.message}`);
      }
      if (latest) {
        persistDiscoveredAgentSession(projectId, liveProject, latest).catch((e) => {
          console.warn(`[viewer] failed to persist agent session for ${projectId}: ${e.message}`);
        });
      }
      // When the permission bypass is on, also pre-trust the project folder so
      // the agent's one-time workspace-trust prompt doesn't block the launch.
      // Best-effort: a failure here just means the trust prompt appears once.
      if (resolveAgentBypass() && typeof provider.ensureTrust === "function") {
        try { await provider.ensureTrust(cwd); }
        catch (e) { console.warn(`[viewer] ensureTrust failed for ${projectId}: ${e.message}`); }
      }
      const input = { projectId, meta: liveProject.meta, session: latest };
      const cmd = latest
        ? provider.buildResumeCommand(input)
        : provider.buildLaunchCommand(input);
      try {
        pty.write(cmd);
      } catch (e) {
        // A failed write leaves a bare terminal; surface it instead of swallowing.
        for (const sid of entry.subscribers) {
          io.sockets.sockets.get(sid)?.emit("pty:error", `agent launch failed: ${e.message}`);
        }
      }
    };

    // Watch the pty output for a shell prompt, then launch. The deadline fires
    // the launch regardless if no prompt is matched in time.
    let promptSeen = "";
    promptProbe = pty.onData((data) => {
      promptSeen = (promptSeen + data).slice(-256);
      if (SHELL_PROMPT_RE.test(promptSeen)) launch();
    });
    promptDeadline = setTimeout(launch, PTY_PROMPT_DEADLINE_MS);
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
      socket.emit("generation-results", {
        projectId,
        state: Array.from(p.generationResults?.values() ?? [])
          .sort(compareResultSummaries)
          .slice(0, GENERATION_RESULTS_BUNDLE_LIMIT),
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
