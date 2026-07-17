// Integration tests for the viewer HTTP surface. Spawns the viewer in a
// subprocess against a tmp PROJECTS_DIR so failures can't touch the real
// repo. Tests cover:
//   - POST /projects/:id/mutate     (new route)
//   - PATCH .../nodes/:nodeId/data  (migrated route)
//   - PATCH .../nodes/batch-data    (migrated route)
//   - PATCH /projects/:id           (title mirror migrated)

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");

const TEST_PROJECT_ID = "test_project";

let viewerProc = null;
let projectsDir = null;
let port = 0;
let baseUrl = "";

async function freePort() {
  // Pick a port unlikely to collide; default 7488 is the real viewer.
  return 17400 + Math.floor(Math.random() * 1000);
}

async function setupTestProject(projectsDir, id) {
  const dir = join(projectsDir, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  await mkdir(join(dir, "assets/notes"), { recursive: true });
  const workflow = {
    version: 2,
    workflow_id: id,
    title: "Initial",
    nodes: [],
    edges: [],
  };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  const meta = { id, title: "Initial", created_at: now, last_active_at: now };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "canvas-mutator-http-"));
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await setupTestProject(projectsDir, TEST_PROJECT_ID);
  const env = {
    ...process.env,
    VIEWER_PORT: String(port),
    PAI_PROJECTS_DIR: projectsDir,
    PAI_ACTIVE_FILE: join(projectsDir, ".active_project"),
    PAI_ROOT_LINK: join(projectsDir, "workflow.json"),
    WEB_ORIGIN: "http://localhost:0",
  };
  viewerProc = spawn(process.execPath, [VIEWER_PATH], { env, stdio: ["ignore", "pipe", "pipe"] });
  // Wait for "listening" log (or just poll the health endpoint).
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("viewer did not start in 10s");
}

async function stopViewer() {
  if (viewerProc) {
    viewerProc.kill("SIGTERM");
    await new Promise((r) => viewerProc.once("exit", r));
    viewerProc = null;
  }
  if (projectsDir) {
    await rm(projectsDir, { recursive: true, force: true });
    projectsDir = null;
  }
}

async function readWorkflow() {
  const raw = await readFile(join(projectsDir, TEST_PROJECT_ID, "workflow.json"), "utf8");
  return JSON.parse(raw);
}

async function readMeta() {
  const raw = await readFile(join(projectsDir, TEST_PROJECT_ID, "meta.json"), "utf8");
  return JSON.parse(raw);
}

async function postMutate(envelope) {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/mutate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return { status: r.status, body: await r.json() };
}

// --- lifecycle ----------------------------------------------------------

test.before(async () => {
  await startViewer();
});
test.after(async () => {
  await stopViewer();
});

// --- POST /mutate -------------------------------------------------------

test("POST /mutate addNode → 200, disk has new node", async () => {
  const { status, body } = await postMutate({
    request_id: "http-add-1",
    op: "addNode",
    payload: { node: { type: "note", data: { label: "via http", body: "yes" } } },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.assigned.node_id, "note_1");
  const wf = await readWorkflow();
  assert.equal(wf.nodes.length, 1);
  assert.equal(wf.nodes[0].id, "note_1");
});

test("POST /mutate same request_id → applied:false", async () => {
  const env = {
    request_id: "http-dup-1",
    op: "addNode",
    payload: { node: { type: "note", data: { label: "once", body: "y" } } },
  };
  const r1 = await postMutate(env);
  assert.equal(r1.body.applied, true);
  const r2 = await postMutate(env);
  assert.equal(r2.body.applied, false);
  assert.equal(r2.body.assigned.node_id, r1.body.assigned.node_id);
});

test("POST /mutate invalid payload → 400", async () => {
  const { status, body } = await postMutate({
    request_id: "http-bad-1",
    op: "addNode",
    payload: { node: { type: "note", data: { label: "missing body" } } },
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.klass, "validation");
});

test("POST /mutate unknown op → 400 (envelope schema)", async () => {
  const { status, body } = await postMutate({
    request_id: "http-bad-op",
    op: "doesNotExist",
    payload: {},
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

// --- Migrated PATCH .../nodes/:id/data ---------------------------------

test("PATCH /nodes/:nodeId/data → 200, node patched, shot_id:null deletes key", async () => {
  // Seed a video node.
  await postMutate({
    request_id: "seed-vid-1",
    op: "addNode",
    payload: {
      node: {
        type: "video_result",
        data: {
          label: "v",
          local_path: "assets/videos/v.mp4",
          duration: 5,
          aspect: "16:9",
          shot_id: 5,
          metadata: { source: "t" },
        },
      },
    },
  });
  const wfBefore = await readWorkflow();
  const videoNode = wfBefore.nodes.find((n) => n.type === "video_result");
  assert.ok(videoNode, "seed video present");
  const r1 = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/nodes/${videoNode.id}/data`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shot_id: 3 }),
  });
  assert.equal(r1.status, 200);
  let wf = await readWorkflow();
  assert.equal(wf.nodes.find((n) => n.id === videoNode.id).data.shot_id, 3);
  // Null deletes key.
  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/nodes/${videoNode.id}/data`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shot_id: null }),
  });
  wf = await readWorkflow();
  assert.equal("shot_id" in wf.nodes.find((n) => n.id === videoNode.id).data, false);
});

test("PATCH /nodes/:nodeId/data on missing node → 404", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/nodes/note_999/data`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(r.status, 404);
});

test("PATCH /nodes/:nodeId/data with a __proto__/constructor body is neutralized (N59)", async () => {
  // Seed a note to patch.
  await postMutate({
    request_id: `seed-proto-${Date.now()}`,
    op: "addNode",
    payload: { node: { type: "note", data: { label: "proto-seed", body: "b" } } },
  });
  const wf0 = await readWorkflow();
  const note = wf0.nodes.find((n) => n.type === "note" && n.data.label === "proto-seed");
  assert.ok(note, "seed note present");
  // Hostile body: express.json parses __proto__ / constructor as own-enumerable
  // keys (the exploit shape). deepMergePatch's guard skips them, so the merge is
  // a valid no-op on those keys and the legit key still lands.
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/nodes/${note.id}/data`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"},"label":"safe"}',
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  // Dangerous keys never became node data (without the guard, `constructor`
  // lands as an own key here); the legit key merged.
  assert.equal(Object.prototype.hasOwnProperty.call(body.node.data, "polluted"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body.node.data, "constructor"), false);
  assert.equal(body.node.data.label, "safe");
  // Server is still healthy after the hostile request.
  const health = await postMutate({
    request_id: `post-proto-${Date.now()}`,
    op: "addNode",
    payload: { node: { type: "note", data: { label: "after-proto", body: "ok" } } },
  });
  assert.equal(health.body.ok, true);
});

// --- Migrated PATCH .../nodes/batch-data --------------------------------

test("PATCH /nodes/batch-data → all updates atomic on disk", async () => {
  // Seed 3 video nodes.
  for (let i = 0; i < 3; i++) {
    await postMutate({
      request_id: `seed-batch-${i}-${Date.now()}`,
      op: "addNode",
      payload: {
        node: {
          type: "video_result",
          data: {
            label: `b${i}`,
            local_path: `assets/videos/b${i}.mp4`,
            duration: 5,
            aspect: "16:9",
            shot_id: null,
            metadata: { source: "t" },
          },
        },
      },
    });
  }
  const wfBefore = await readWorkflow();
  const videos = wfBefore.nodes.filter((n) => n.type === "video_result").slice(-3);
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/nodes/batch-data`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      updates: videos.map((v, i) => ({ nodeId: v.id, data: { shot_id: i + 1 } })),
    }),
  });
  assert.equal(r.status, 200);
  const wf = await readWorkflow();
  const after = wf.nodes.filter((n) => videos.some((v) => v.id === n.id));
  assert.deepEqual(after.map((n) => n.data.shot_id), [1, 2, 3]);
});

// --- Migrated PATCH /projects/:id (title) -------------------------------

test("PATCH /projects/:id sets title in both meta.json and workflow.json", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Renamed By Test" }),
  });
  assert.equal(r.status, 200);
  const wf = await readWorkflow();
  assert.equal(wf.title, "Renamed By Test");
  const meta = JSON.parse(await readFile(join(projectsDir, TEST_PROJECT_ID, "meta.json"), "utf8"));
  assert.equal(meta.title, "Renamed By Test");
});

test("POST /mutate setTitle mirrors title into meta.json (agent path)", async () => {
  const { status, body } = await postMutate({
    request_id: `r-set-title-${Date.now()}`,
    op: "setTitle",
    payload: { title: "Agent Set Title" },
    actor: "test",
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const meta = JSON.parse(await readFile(join(projectsDir, TEST_PROJECT_ID, "meta.json"), "utf8"));
  assert.equal(meta.title, "Agent Set Title");
});

// --- PATCH /projects/:id (bypass flag) ---------------------------------

test("PATCH /projects/:id sets dangerously_skip_draft_gate=true", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dangerously_skip_draft_gate: true }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.row.dangerously_skip_draft_gate, true);
  const meta = JSON.parse(await readFile(join(projectsDir, TEST_PROJECT_ID, "meta.json"), "utf8"));
  assert.equal(meta.dangerously_skip_draft_gate, true);
});

test("PATCH /projects/:id clears dangerously_skip_draft_gate on false", async () => {
  // First enable it.
  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dangerously_skip_draft_gate: true }),
  });
  // Then disable.
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dangerously_skip_draft_gate: false }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.row.dangerously_skip_draft_gate, false);
  const meta = JSON.parse(await readFile(join(projectsDir, TEST_PROJECT_ID, "meta.json"), "utf8"));
  // Cleared on false so meta stays minimal for projects that never enabled.
  assert.equal(meta.dangerously_skip_draft_gate, undefined);
});

test("PATCH /projects/:id rejects non-boolean bypass flag", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dangerously_skip_draft_gate: "yes" }),
  });
  assert.equal(r.status, 400);
});

test("PATCH /projects/:id with empty body rejects with 400", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

// --- Auto runs ----------------------------------------------------------

test("POST /projects/:id/auto-runs creates scoped run without enabling global bypass", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      budget_cap_usd: 12.5,
      estimate_usd: 10,
      planned_runtime_seconds: 60,
      brief: "make a one minute noir short",
    }),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.match(body.auto_run.id, /^auto_/);
  assert.equal(body.auto_run.status, "approved");
  assert.equal(body.auto_run.budget_cap_usd, 12.5);
  assert.equal(body.auto_run.spent_usd, 0);

  const meta = await readMeta();
  assert.equal(meta.auto_run.id, body.auto_run.id);
  assert.equal(meta.dangerously_skip_draft_gate, undefined);

  // Terminate so later tests can create fresh runs (single run slot).
  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${body.auto_run.id}`, {
    method: "DELETE",
  });
});

test("creating a second auto run while one is active returns 409", async () => {
  const first = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 2, brief: "run A" }),
  });
  assert.equal(first.status, 201);
  const runA = (await first.json()).auto_run;

  const second = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 2, brief: "run B" }),
  });
  assert.equal(second.status, 409);
  const blocked = await second.json();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.klass, "conflict");

  const meta = await readMeta();
  assert.equal(meta.auto_run.id, runA.id, "active run must not be replaced");

  const cancel = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runA.id}`, {
    method: "DELETE",
  });
  assert.equal(cancel.status, 200);

  const third = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 2, brief: "run C" }),
  });
  assert.equal(third.status, 201, "terminal run can be replaced");
  const runC = (await third.json()).auto_run;
  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runC.id}`, {
    method: "DELETE",
  });
});

test("reserve rejects null, missing, and negative cost_usd", async () => {
  const create = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 2, brief: "cost validation" }),
  });
  const runId = (await create.json()).auto_run.id;

  for (const costUsd of [null, undefined, -0.0004, "0.45", true]) {
    const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "pending_auto_bad_cost", cost_usd: costUsd }),
    });
    assert.equal(r.status, 400, `cost_usd ${String(costUsd)} must be rejected`);
    assert.equal((await r.json()).klass, "bad_args");
  }

  const meta = await readMeta();
  assert.equal(meta.auto_run.jobs.length, 0, "no $0 reservations recorded");

  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}`, {
    method: "DELETE",
  });
});

test("auto run reservations accumulate and reject jobs over cap", async () => {
  const create = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 1, brief: "tiny budget" }),
  });
  const created = await create.json();
  const runId = created.auto_run.id;

  const reserveOne = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: "pending_auto_1",
      kind: "image",
      model: "image-generation",
      cost_usd: 0.45,
      prompt: "character sheet",
    }),
  });
  assert.equal(reserveOne.status, 200);
  const first = await reserveOne.json();
  assert.equal(first.ok, true);
  assert.equal(first.auto_run.status, "running");
  assert.equal(first.auto_run.spent_usd, 0.45);

  const duplicate = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: "pending_auto_1",
      kind: "image",
      model: "image-generation",
      cost_usd: 0.45,
    }),
  });
  assert.equal(duplicate.status, 200);
  const dup = await duplicate.json();
  assert.equal(dup.already_reserved, true);
  assert.equal(dup.auto_run.spent_usd, 0.45);

  const over = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: "pending_auto_2",
      kind: "video",
      model: "video-generation",
      cost_usd: 0.6,
    }),
  });
  assert.equal(over.status, 402);
  const blocked = await over.json();
  assert.equal(blocked.klass, "budget_exceeded");

  const meta = await readMeta();
  assert.equal(meta.auto_run.spent_usd, 0.45);
  assert.equal(meta.auto_run.jobs.length, 1);

  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}`, {
    method: "DELETE",
  });
});

test("auto run completion is terminal", async () => {
  const create = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 3, brief: "status checks" }),
  });
  const created = await create.json();
  const runId = created.auto_run.id;

  const complete = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(complete.status, 200);
  assert.equal((await complete.json()).auto_run.status, "completed");

  const invalid = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "cancelled" }),
  });
  assert.equal(invalid.status, 400);

  const cancel = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}`, {
    method: "DELETE",
  });
  assert.equal(cancel.status, 409);
});

test("active auto run can be cancelled", async () => {
  const create = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ budget_cap_usd: 3, brief: "cancel checks" }),
  });
  const created = await create.json();
  const runId = created.auto_run.id;

  const cancel = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/auto-runs/${runId}`, {
    method: "DELETE",
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).auto_run.status, "cancelled");
});

test("GET /projects rows include cover_url from first non-archived video", async () => {
  const r = await fetch(`${baseUrl}/projects`);
  const rows = await r.json();
  const row = rows.find((x) => x.id === TEST_PROJECT_ID);
  assert.equal(typeof row.cover_url, "string");
  assert.ok(row.cover_url.length > 0);
});

// --- mutations.jsonl audit log -----------------------------------------

test("mutations.jsonl has one line per applied mutation", async () => {
  // Give the best-effort append a tick (the test before doesn't await it).
  await new Promise((r) => setTimeout(r, 100));
  const raw = await readFile(join(projectsDir, TEST_PROJECT_ID, "mutations.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  // At minimum: the various POST /mutate calls above + the migrated PATCH
  // calls + the title PATCH — should be >=8 lines.
  assert.ok(lines.length >= 8, `expected >=8 lines, got ${lines.length}`);
  // Every line is JSON with op + request_id.
  for (const l of lines) {
    const obj = JSON.parse(l);
    assert.ok(obj.op, "log line has op");
    assert.ok(obj.request_id, "log line has request_id");
  }
});

// --- body-size limit (N61) ---------------------------------------------

test("POST /mutate addNode with a >100KB note body → 200, not 413", async () => {
  // 200KB of inline text: over express.json's 100kb default, well under the
  // 4mb cap. Long scripts/screenplays exceed 100KB and the agent/CLIs create
  // notes over HTTP — before the limit bump this 413'd before reaching the
  // mutator. Raw fetch (not postMutate) so a pre-fix 413 asserts cleanly
  // instead of throwing in res.json().
  const bigBody = "x".repeat(200 * 1024);
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/mutate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: `http-big-note-${Date.now()}`,
      op: "addNode",
      payload: { node: { type: "note", data: { label: "big", body: bigBody } } },
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.assigned.node_id.startsWith("note_"), true);
});
