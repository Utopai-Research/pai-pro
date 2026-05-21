// Integration tests for the server-side pending → real position handoff.
//
// When the CLI threads `pending_job_id` through the mutate envelope and
// the pending sidecar has a `position` field (set by user drag → PATCH
// /pending/:jobId), the mutator's onApply hook copies that position onto
// the freshly-minted node id in canvas_positions.json — atomic with the
// canvas-state broadcast. This file exercises that path end-to-end via
// the real viewer subprocess + HTTP, mirroring the pattern in
// canvas_mutator_http.test.js and pending_routes.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const TEST_PROJECT_ID = "test_handoff";

let viewerProc = null;
let projectsDir = null;
let port = 0;
let baseUrl = "";

async function freePort() {
  return 17800 + Math.floor(Math.random() * 1000);
}

async function setupTestProject(projectsDir, id) {
  const dir = join(projectsDir, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  await mkdir(join(dir, "assets/notes"), { recursive: true });
  await mkdir(join(dir, ".pending"), { recursive: true });
  const workflow = { version: 2, workflow_id: id, title: "T", nodes: [], edges: [] };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: "T", created_at: now, last_active_at: now }, null, 2) + "\n",
  );
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "pending-handoff-"));
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
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return;
    } catch { /* not up yet */ }
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

function sidecarPath(jobId) {
  return join(projectsDir, TEST_PROJECT_ID, ".pending", `${jobId}.json`);
}

function positionsPath() {
  return join(projectsDir, TEST_PROJECT_ID, "canvas_positions.json");
}

// Seed a running-stage sidecar that mimics what a CLI in-flight would have
// after the user dragged the pad. Includes `position` so the handoff has
// something to copy.
async function seedRunningPending({ jobId, kind = "audio", position, text } = {}) {
  const id = jobId || `pending_${Math.random().toString(36).slice(2, 12)}`;
  const payload = {
    id,
    kind,
    stage: "running",
    prompt: kind === "audio" ? "warm female voice" : "a cat with a fedora",
    aspect_ratio: "1:1",
    references: [],
    created_at: new Date().toISOString(),
    model: "test/model",
    ...(text !== undefined ? { text } : {}),
    ...(position !== undefined ? { position } : {}),
  };
  await writeFile(sidecarPath(id), JSON.stringify(payload) + "\n");
  return { jobId: id, payload };
}

// Wait for the chokidar watcher inside the viewer to pick up a sidecar
// (awaitWriteFinish stabilityThreshold = 100ms). Polls GET /projects/:id
// until the pending entry surfaces; bails after timeoutMs.
async function waitForPendingPicked(jobId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`);
    if (r.ok) {
      const b = await r.json();
      if (
        Array.isArray(b.pending_generations) &&
        b.pending_generations.some((e) => e.id === jobId)
      ) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`watcher did not pick up sidecar ${jobId} within ${timeoutMs}ms`);
}

async function readPositions() {
  try {
    return JSON.parse(await readFile(positionsPath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { positions: {}, groupFrames: {} };
    throw e;
  }
}

// Wait for canvas_positions.json on disk to satisfy a predicate. Used to
// observe the fire-and-forget write the broadcaster schedules under the
// project lock — bounded to keep the test from hanging if the write
// never lands.
async function waitForPositionsWrite(pred, timeoutMs = 3000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPositions();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`positions did not satisfy predicate within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function postMutate(envelope) {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/mutate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return { status: r.status, body: await r.json() };
}

// ─── lifecycle ──────────────────────────────────────────────────────────

test.before(async () => { await startViewer(); });
test.after(async () => { await stopViewer(); });

// ─── happy path ─────────────────────────────────────────────────────────

test("addBatch + pending_job_id + sidecar position → canvas_positions written", async () => {
  const { jobId } = await seedRunningPending({
    kind: "audio",
    text: "hello world",
    position: { x: 480, y: 320 },
  });
  await waitForPendingPicked(jobId);

  const { status, body } = await postMutate({
    request_id: `handoff-happy-${jobId}`,
    op: "addBatch",
    pending_job_id: jobId,
    payload: {
      nodes: [
        {
          type: "audio_result",
          data: {
            subtype: "voice",
            label: "hello world",
            local_path: "assets/audios/audio.mp3",
            text: "hello world",
            metadata: { source: "test" },
          },
        },
      ],
    },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const newId = body.assigned?.node_ids?.[0];
  assert.ok(newId, "addBatch returns an assigned node id");

  const positions = await waitForPositionsWrite((p) => p.positions[newId] !== undefined);
  assert.deepEqual(positions.positions[newId], { x: 480, y: 320 });
});

// ─── no-position sidecar ────────────────────────────────────────────────

test("addBatch + pending_job_id but sidecar has no position → no entry", async () => {
  const { jobId } = await seedRunningPending({ kind: "audio", text: "no drag" });
  await waitForPendingPicked(jobId);

  const positionsBefore = await readPositions();
  const beforeKeys = new Set(Object.keys(positionsBefore.positions));

  const { body } = await postMutate({
    request_id: `handoff-no-pos-${jobId}`,
    op: "addBatch",
    pending_job_id: jobId,
    payload: {
      nodes: [
        {
          type: "audio_result",
          data: {
            subtype: "voice",
            label: "no drag",
            local_path: "assets/audios/audio.mp3",
            text: "no drag",
            metadata: { source: "test" },
          },
        },
      ],
    },
  });
  const newId = body.assigned?.node_ids?.[0];
  assert.ok(newId);

  // Let any spurious fire-and-forget write race in; assert nothing new
  // appeared for newId.
  await new Promise((r) => setTimeout(r, 250));
  const positionsAfter = await readPositions();
  assert.equal(
    positionsAfter.positions[newId],
    undefined,
    "no sidecar position → no canvas_positions entry",
  );
  // No unrelated keys touched either.
  for (const k of Object.keys(positionsAfter.positions)) {
    if (k === newId) continue;
    assert.ok(beforeKeys.has(k), `new key ${k} appeared unexpectedly`);
  }
});

// ─── unknown jobId ──────────────────────────────────────────────────────

test("addBatch + pending_job_id pointing at no sidecar → no error, no entry", async () => {
  const ghostJobId = "pending_does_not_exist_xyz";

  const { status, body } = await postMutate({
    request_id: `handoff-ghost-${ghostJobId}`,
    op: "addBatch",
    pending_job_id: ghostJobId,
    payload: {
      nodes: [
        {
          type: "note",
          data: { label: "ghost", body: "no real pending" },
        },
      ],
    },
  });
  assert.equal(status, 200, "mutation succeeds even with bogus pending_job_id");
  assert.equal(body.ok, true);
  const newId = body.assigned?.node_ids?.[0];
  assert.ok(newId);

  await new Promise((r) => setTimeout(r, 250));
  const positions = await readPositions();
  assert.equal(positions.positions[newId], undefined);
});

// ─── op gating ──────────────────────────────────────────────────────────

test("pending_job_id on non-addBatch op (addNode) → ignored, no handoff", async () => {
  const { jobId } = await seedRunningPending({
    kind: "audio",
    text: "wrong op",
    position: { x: 100, y: 200 },
  });
  await waitForPendingPicked(jobId);

  const { status, body } = await postMutate({
    request_id: `handoff-wrong-op-${jobId}`,
    op: "addNode",
    pending_job_id: jobId,
    payload: {
      node: {
        type: "note",
        data: { label: "wrong op", body: "addNode doesn't carry handoff" },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const newId = body.assigned?.node_id;
  assert.ok(newId);

  await new Promise((r) => setTimeout(r, 250));
  const positions = await readPositions();
  assert.equal(
    positions.positions[newId],
    undefined,
    "handoff is gated to addBatch op only",
  );
});

// ─── burst-write debounce: 3 parallel sidecars → single pending state ──

test("3 parallel sidecar writes are picked up and exposed via bundle", async () => {
  // Coalescing must not drop entries — all three sidecars surface.
  const seeds = await Promise.all([
    seedRunningPending({ kind: "image" }),
    seedRunningPending({ kind: "image" }),
    seedRunningPending({ kind: "image" }),
  ]);
  const ids = seeds.map((s) => s.jobId);

  const start = Date.now();
  while (Date.now() - start < 3000) {
    const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`);
    if (r.ok) {
      const b = await r.json();
      const pending = Array.isArray(b.pending_generations) ? b.pending_generations : [];
      const have = new Set(pending.map((e) => e.id));
      if (ids.every((id) => have.has(id))) {
        // All three present — pass.
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`bundle did not surface all three pending entries within 3s; ids=${JSON.stringify(ids)}`);
});

// ─── concurrent /positions PATCH after handoff ──────────────────────────

test("handoff write coexists with concurrent /positions PATCH (entry survives)", async () => {
  const { jobId } = await seedRunningPending({
    kind: "audio",
    text: "concurrent",
    position: { x: 700, y: 800 },
  });
  await waitForPendingPicked(jobId);

  const { body } = await postMutate({
    request_id: `handoff-concurrent-${jobId}`,
    op: "addBatch",
    pending_job_id: jobId,
    payload: {
      nodes: [
        {
          type: "audio_result",
          data: {
            subtype: "voice",
            label: "concurrent",
            local_path: "assets/audios/c.mp3",
            text: "concurrent",
            metadata: { source: "test" },
          },
        },
      ],
    },
  });
  const newId = body.assigned?.node_ids?.[0];
  assert.ok(newId);

  // Fire a PATCH /positions on a DIFFERENT id immediately. The lock
  // serializes the two writes; both entries must survive.
  // Need to seed the "different id" as a real node first or PATCH rejects
  // it (positions endpoint validates against canvas nodes).
  await postMutate({
    request_id: `seed-other-${jobId}`,
    op: "addNode",
    payload: { node: { type: "note", data: { label: "other", body: "other" } } },
  });
  const wf = JSON.parse(
    await readFile(join(projectsDir, TEST_PROJECT_ID, "workflow.json"), "utf8"),
  );
  const otherId = wf.nodes[wf.nodes.length - 1].id;
  await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/positions`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [otherId]: { x: 50, y: 60 } }),
  });

  const finalPositions = await waitForPositionsWrite(
    (p) => p.positions[newId] !== undefined && p.positions[otherId] !== undefined,
  );
  assert.deepEqual(finalPositions.positions[newId], { x: 700, y: 800 });
  assert.deepEqual(finalPositions.positions[otherId], { x: 50, y: 60 });
});
