import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function fakeIo() {
  let connectionHandler = null;
  return {
    on(event, cb) {
      if (event === "connection") connectionHandler = cb;
    },
    to() {
      return { emit() {} };
    },
    sockets: { sockets: new Map() },
    connect(socket) {
      connectionHandler?.(socket);
    },
  };
}

function fakeSocket(id = "socket_1") {
  const handlers = new Map();
  return {
    id,
    emitted: [],
    on(event, cb) {
      handlers.set(event, cb);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    join() {},
    fire(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
}

test("submitAgentNotification reports no_pty when node-pty is unavailable", async () => {
  const { registerSocketHandlers, submitAgentNotification } =
    await import(`../services/socket.js?submit_no_pty=${Date.now()}`);
  registerSocketHandlers({
    io: fakeIo(),
    projects: new Map([["p1", { meta: { id: "p1", agent_id: "claude" } }]]),
    nodePty: null,
  });

  const result = await submitAgentNotification("p1", "hello", { requireIdleMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_pty");
});

test("submitAgentNotification does not server-spawn a missing project PTY", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "socket-submit-spawn-"));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;
  const projectId = "p_spawn";
  await mkdir(join(projectsDir, projectId), { recursive: true });

  const writes = [];
  let dataHandler = null;
  const fakePtyHandle = {
    pid: 4242,
    write(data) {
      writes.push(data);
      if (data === "\r") setTimeout(() => dataHandler?.("accepted"), 0);
    },
    onData(cb) { dataHandler = cb; },
    onExit() {},
    resize() {},
    kill() {},
  };
  const nodePty = {
    spawn() {
      return fakePtyHandle;
    },
  };

  const { registerSocketHandlers, submitAgentNotification } =
    await import(`../services/socket.js?submit_spawn=${Date.now()}`);
  registerSocketHandlers({
    io: fakeIo(),
    projects: new Map([[
      projectId,
      { meta: { id: projectId, title: "Spawn", agent_id: "claude" } },
    ]]),
    nodePty,
  });

  const result = await submitAgentNotification(projectId, "hello", { requireIdleMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_pty");
  assert.deepEqual(writes, []);
});

test("submitAgentNotification defers while browser input is dirty", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "socket-submit-dirty-"));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;
  const projectId = "p_dirty";
  await mkdir(join(projectsDir, projectId), { recursive: true });

  let dataHandler = null;
  const writes = [];
  const fakePtyHandle = {
    pid: 4343,
    write(data) {
      writes.push(data);
      if (data === "\r") setTimeout(() => dataHandler?.("accepted"), 0);
    },
    onData(cb) { dataHandler = cb; },
    onExit() {},
    resize() {},
    kill() {},
  };
  const nodePty = { spawn: () => fakePtyHandle };
  const io = fakeIo();
  const socket = fakeSocket();

  const { registerSocketHandlers, submitAgentNotification } =
    await import(`../services/socket.js?submit_dirty=${Date.now()}`);
  registerSocketHandlers({
    io,
    projects: new Map([[
      projectId,
      { meta: { id: projectId, title: "Dirty", agent_id: "claude" } },
    ]]),
    nodePty,
  });
  io.connect(socket);
  socket.fire("pty:spawn", { projectId, cols: 100, rows: 30 });
  socket.fire("pty:input", "half-written user draft");

  const dirty = await submitAgentNotification(projectId, "hello", { requireIdleMs: 0 });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.reason, "unsafe_input");
  assert.ok(!writes.includes("hello"));

  socket.fire("pty:input", "\r");
  const clean = await submitAgentNotification(projectId, "hello", { requireIdleMs: 0 });
  assert.equal(clean.ok, true);
  assert.ok(writes.includes("hello"));
});

test("submitAgentNotification defers when no browser is attached", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "socket-submit-detached-"));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(async () => {
    await rm(projectsDir, { recursive: true, force: true });
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;
  const projectId = "p_detached";
  await mkdir(join(projectsDir, projectId), { recursive: true });

  const fakePtyHandle = {
    pid: 4444,
    write() {},
    onData() {},
    onExit() {},
    resize() {},
    kill() {},
  };
  const io = fakeIo();
  const socket = fakeSocket();

  const { registerSocketHandlers, submitAgentNotification } =
    await import(`../services/socket.js?submit_detached=${Date.now()}`);
  registerSocketHandlers({
    io,
    projects: new Map([[
      projectId,
      { meta: { id: projectId, title: "Detached", agent_id: "claude" } },
    ]]),
    nodePty: { spawn: () => fakePtyHandle },
  });
  io.connect(socket);
  socket.fire("pty:spawn", { projectId, cols: 100, rows: 30 });
  socket.fire("disconnect");

  const result = await submitAgentNotification(projectId, "hello", { requireIdleMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_subscriber");
});
