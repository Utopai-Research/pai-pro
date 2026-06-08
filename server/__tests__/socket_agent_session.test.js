import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const priorBypass = process.env.PAI_AGENT_BYPASS;
process.env.PAI_AGENT_BYPASS = "0";
test.after(() => {
  if (priorBypass === undefined) delete process.env.PAI_AGENT_BYPASS;
  else process.env.PAI_AGENT_BYPASS = priorBypass;
});

test("persistDiscoveredAgentSession writes agent_session_id from discovered payload id", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "socket-agent-session-"));
  t.after(() => rm(projectsDir, { recursive: true, force: true }));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(() => {
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;

  const projectId = "codex_project";
  await mkdir(join(projectsDir, projectId), { recursive: true });
  const project = {
    meta: {
      id: projectId,
      title: "Codex project",
      agent_id: "codex",
    },
  };

  const { persistDiscoveredAgentSession } = await import(`../services/socket.js?persist=${Date.now()}`);
  assert.equal(
    await persistDiscoveredAgentSession(projectId, project, { sessionId: "payload-session-id" }),
    true,
  );
  assert.equal(project.meta.agent_session_id, "payload-session-id");

  const persisted = JSON.parse(await readFile(join(projectsDir, projectId, "meta.json"), "utf8"));
  assert.equal(persisted.agent_session_id, "payload-session-id");

  assert.equal(
    await persistDiscoveredAgentSession(projectId, project, { sessionId: "payload-session-id" }),
    false,
  );
  assert.equal(await persistDiscoveredAgentSession(projectId, project, { sessionId: "" }), false);
});

// ---------------------------------------------------------------------------
// Auto-launch shell-readiness gating (findings N09 + N44).
//
// These drive the real `pty:spawn` handler with a fake node-pty so we can
// observe exactly when the launch command is written, without a real shell.
// `findLatestSession` for a random projectId hits a non-existent session dir
// (ENOENT → null), so the provider falls back to a deterministic fresh launch.
// ---------------------------------------------------------------------------

function makeFakePty() {
  const dataListeners = [];
  const pty = {
    pid: 4242,
    writes: [],
    write(s) { pty.writes.push(s); },
    resize() {},
    kill() {},
    onData(fn) {
      dataListeners.push(fn);
      return { dispose() {
        const i = dataListeners.indexOf(fn);
        if (i >= 0) dataListeners.splice(i, 1);
      } };
    },
    onExit() { return { dispose() {} }; },
    // Test helper: push a chunk to every live onData listener.
    feed(chunk) { for (const fn of [...dataListeners]) fn(chunk); },
    listenerCount() { return dataListeners.length; },
  };
  return pty;
}

// Minimal socket + io doubles. `socket.on` records inbound handlers (invoked
// via `trigger`); `socket.emit` records outbound events; `io.sockets.sockets`
// lets the handler fan out to subscribers by id, matching the real surface.
function makeHarness(fakePty) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: "sock-1",
    join() {},
    on(event, fn) { handlers.set(event, fn); },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  const io = {
    sockets: { sockets: new Map([[socket.id, socket]]) },
    // registerSocketHandlers wires per-socket handlers inside io.on("connection").
    // Invoke the callback immediately with our single fake socket.
    on(event, cb) { if (event === "connection") cb(socket); },
  };
  const nodePty = { spawn() { return fakePty; } };
  return {
    socket,
    io,
    nodePty,
    emitted,
    trigger: (event, payload) => handlers.get(event)?.(payload),
  };
}

async function flush() {
  // Let the async launch() (incl. real findLatestSession FS read) settle.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

// Poll until `fn()` is truthy or the deadline passes, yielding to real I/O
// each turn so the async launch() (which awaits a filesystem readdir) settles.
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}

test("auto-launch writes the launch command only after a shell prompt appears", async (t) => {
  const { registerSocketHandlers } = await import(`../services/socket.js?launch-prompt=${Date.now()}`);
  const fakePty = makeFakePty();
  const { io, nodePty, trigger } = makeHarness(fakePty);

  const projectId = `prompt_gate_${Date.now()}`;
  const projects = new Map([[projectId, { meta: { id: projectId, title: "T", agent_id: "claude" } }]]);
  registerSocketHandlers({ io, projects, nodePty });
  t.after(() => trigger("pty:kill"));

  trigger("pty:spawn", { projectId, cols: 80, rows: 24 });
  await flush();
  // Before any prompt output, the command must not be written yet.
  assert.equal(fakePty.writes.length, 0, "command written before prompt appeared");

  // Pre-prompt banner without a prompt terminator: still no write.
  fakePty.feed("Last login: Mon Jun  8 on ttys001\r\n");
  await flush();
  assert.equal(fakePty.writes.length, 0, "command written on non-prompt output");

  // Prompt appears → launch fires exactly once with the fresh-launch command.
  fakePty.feed("user@host project % ");
  await waitFor(() => fakePty.writes.length > 0);
  assert.equal(fakePty.writes.length, 1, "command not written after prompt appeared");
  assert.match(fakePty.writes[0], /^claude .*\r$/);

  // Further output must not re-trigger a second write, and the probe listener
  // must have been disposed (only the buffering listener remains).
  fakePty.feed("user@host project % ");
  await flush();
  assert.equal(fakePty.writes.length, 1, "launch fired more than once");
  assert.equal(fakePty.listenerCount(), 1, "prompt probe was not disposed after launch");
});

test("auto-launch emits pty:error to the room when pty.write throws", async (t) => {
  const { registerSocketHandlers } = await import(`../services/socket.js?launch-throw=${Date.now()}`);
  const fakePty = makeFakePty();
  fakePty.write = () => { throw new Error("write boom"); };
  const { socket, io, nodePty, emitted, trigger } = makeHarness(fakePty);

  const projectId = `write_throw_${Date.now()}`;
  const projects = new Map([[projectId, { meta: { id: projectId, title: "T", agent_id: "claude" } }]]);
  registerSocketHandlers({ io, projects, nodePty });
  t.after(() => trigger("pty:kill"));

  trigger("pty:spawn", { projectId, cols: 80, rows: 24 });
  fakePty.feed("host % ");
  await waitFor(() => emitted.some((e) => e.event === "pty:error"));

  const errs = emitted.filter((e) => e.event === "pty:error");
  assert.equal(errs.length, 1, "expected exactly one pty:error after write threw");
  assert.match(errs[0].payload, /agent launch failed: write boom/);
  // The socket is the only subscriber, so the room fan-out lands on it.
  assert.equal(socket.id, [...io.sockets.sockets.keys()][0]);
});

test("auto-launch aborts when projects.get no longer returns the project", async (t) => {
  const { registerSocketHandlers } = await import(`../services/socket.js?launch-gone=${Date.now()}`);
  const fakePty = makeFakePty();
  const { io, nodePty, emitted, trigger } = makeHarness(fakePty);

  const projectId = `deleted_${Date.now()}`;
  const project = { meta: { id: projectId, title: "T", agent_id: "claude" } };
  const projects = new Map([[projectId, project]]);
  registerSocketHandlers({ io, projects, nodePty });
  t.after(() => trigger("pty:kill"));

  trigger("pty:spawn", { projectId, cols: 80, rows: 24 });
  // Project deleted/reloaded during the readiness wait, before the prompt.
  projects.delete(projectId);
  fakePty.feed("host % ");
  await flush();

  assert.equal(fakePty.writes.length, 0, "launch command written after project went away");
  assert.equal(emitted.some((e) => e.event === "pty:error"), false, "unexpected pty:error on quiet abort");
});
