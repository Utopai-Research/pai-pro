// HTTP integration tests for the draft-gate fire-path routes:
//   PATCH  /projects/:id/pending/:jobId
//   POST   /projects/:id/pending/:jobId/generate
//   DELETE /projects/:id/pending/:jobId
//
// Spawns the viewer in a subprocess against a tmp PROJECTS_DIR (same
// pattern as canvas_mutator_http.test.js), seeds a draft sidecar on
// disk, and exercises each route. POST /generate spawns the real CLI;
// these tests use bad args / missing refs so the child settles quickly,
// and the route must persist that terminal result.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writePending } from "../cli/_pending.js";
import { markSidecarRunning, runningTimeoutMsForEntry } from "../routes/pending.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const TEST_PROJECT_ID = "test_pending";
const DAY_MS = 24 * 60 * 60 * 1000;

let viewerProc = null;
let projectsDir = null;
let port = 0;
let baseUrl = "";

async function freePort() {
  return 17600 + Math.floor(Math.random() * 1000);
}

async function setupTestProject(projectsDir, id) {
  const dir = join(projectsDir, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  await mkdir(join(dir, ".pending"), { recursive: true });
  const workflow = { version: 2, workflow_id: id, title: "T", nodes: [], edges: [] };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: "T", created_at: now, last_active_at: now, agent_id: "codex" }, null, 2) + "\n",
  );
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "pending-routes-"));
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

function projectPath(...parts) {
  return join(projectsDir, TEST_PROJECT_ID, ...parts);
}

function resultPath(jobId) {
  return projectPath(".results", `${jobId}.json`);
}

async function waitForResult(jobId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(resultPath(jobId), "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`result sidecar did not appear for ${jobId}`);
}

async function waitForPendingInBundle(jobId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bundle = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`).then((res) => res.json());
    const found = bundle.pending_generations?.find((p) => p.id === jobId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pending entry did not appear in bundle for ${jobId}`);
}

async function seedDraft({ jobId, overrides = {} } = {}) {
  const id = jobId || `pending_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    id,
    kind: "image",
    stage: "draft",
    prompt: "a test cat",
    aspect_ratio: "1:1",
    references: [],
    created_at: new Date().toISOString(),
    model: "image-generation",
    image_size: "1K",
    cost_usd: 0.07,
    script: "generate_image.js",
    argv: [
      "--prompt", "a test cat",
      "--aspect-ratio", "1:1",
      "--image-size", "1K",
    ],
    ...overrides,
  };
  await writeFile(sidecarPath(id), JSON.stringify(payload) + "\n");
  return { jobId: id, payload };
}

async function readSidecar(jobId) {
  return JSON.parse(await readFile(sidecarPath(jobId), "utf8"));
}

function runCli({ script, args }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(__dirname, "..", "cli", script), ...args],
      {
        cwd: projectPath(),
        env: {
          ...process.env,
          VIEWER_HOST: "127.0.0.1",
          VIEWER_PORT: String(port),
          PAI_WAIT_TIMEOUT_MS: "5000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

function parseReplies(stdout) {
  return stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).map((line) => JSON.parse(line));
}

test.before(async () => { await startViewer(); });
test.after(async () => { await stopViewer(); });

test("markSidecarRunning refreshes the running clock", () => {
  const prior = "2026-01-01T00:00:00.000Z";
  const now = "2026-01-02T03:04:05.000Z";
  const running = markSidecarRunning({
    id: "pending_old",
    kind: "image",
    stage: "draft",
    prompt: "x",
    created_at: prior,
  }, now);
  assert.equal(running.stage, "running");
  assert.equal(running.created_at, now);
});

test("runningTimeoutMsForEntry keeps worker timeouts separate from 24h pending visibility", () => {
  assert.equal(runningTimeoutMsForEntry({ kind: "image", script: "generate_image.js" }), 10 * 60 * 1000);
  assert.equal(runningTimeoutMsForEntry({ kind: "image", script: "generate_image_pro.js" }), 30 * 60 * 1000);
  assert.equal(runningTimeoutMsForEntry({ kind: "audio", script: "generate_voice.js" }), 5 * 60 * 1000);
  assert.equal(runningTimeoutMsForEntry({ kind: "video", script: "generate_video.js" }), 40 * 60 * 1000);
  assert.equal(runningTimeoutMsForEntry({ kind: "video", script: "upscaler.js" }), 40 * 60 * 1000);
});

test("running pending sidecars remain visible for nearly 24h", async () => {
  const createdAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  const { jobId } = await seedDraft({
    overrides: {
      stage: "running",
      created_at: createdAt,
    },
  });

  const pending = await waitForPendingInBundle(jobId);
  assert.equal(pending.stage, "running");
  assert.equal(pending.created_at, createdAt);
  await rm(sidecarPath(jobId), { force: true });
});

test("POST /generate rejects drafts older than the 24h pending window", async () => {
  const { jobId } = await seedDraft({
    overrides: {
      created_at: new Date(Date.now() - DAY_MS - 1000).toISOString(),
    },
  });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, {
    method: "POST",
  });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error, "draft not found");
  const sidecar = await readSidecar(jobId);
  assert.equal(sidecar.stage, "draft");
});

test("PATCH prompt-only updates sidecar + argv; cost_usd untouched", async () => {
  const { jobId } = await seedDraft();
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a different cat" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const after = await readSidecar(jobId);
  assert.equal(after.prompt, "a different cat");
  assert.equal(after.cost_usd, 0.07, "prompt edits must not move the price");
  const idx = after.argv.indexOf("--prompt");
  assert.ok(idx >= 0);
  assert.equal(after.argv[idx + 1], "a different cat");
});

test("PATCH image_size recomputes cost and rewrites argv", async () => {
  const { jobId, payload } = await seedDraft();
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_size: "4K" }),
  });
  assert.equal(r.status, 200);
  const after = await readSidecar(jobId);
  assert.equal(after.image_size, "4K");
  const idx = after.argv.indexOf("--image-size");
  assert.equal(after.argv[idx + 1], "4K");
  assert.notEqual(after.cost_usd, payload.cost_usd, "4K should not match 1K price");
  assert.ok(after.cost_usd > 0);
});

test("PATCH image_size is not editable for image pro drafts", async () => {
  const { jobId } = await seedDraft({
    overrides: {
      model: "image-generation-pro",
      image_size: "1K",
      cost_usd: 0.26,
      script: "generate_image_pro.js",
      argv: ["--prompt", "a test cat", "--size", "1024x1024"],
    },
  });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_size: "4K" }),
  });
  assert.equal(r.status, 400);
  const after = await readSidecar(jobId);
  assert.equal(after.image_size, "1K");
  assert.deepEqual(after.argv, ["--prompt", "a test cat", "--size", "1024x1024"]);
});

test("PATCH on a running entry → 409", async () => {
  const { jobId } = await seedDraft({ overrides: { stage: "running" } });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  assert.equal(r.status, 409);
});

test("POST /generate writes durable result sidecar and removes pending", async () => {
  const { jobId } = await seedDraft({
    overrides: { argv: ["--definitely-unknown-flag"] },
  });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, {
    method: "POST",
  });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.job_id, jobId);
  assert.ok(typeof body.pid === "number");

  const result = await waitForResult(jobId);
  assert.equal(result.ok, false);
  assert.equal(result.job_id, jobId);
  assert.equal(result.kind, "image");
  assert.equal(result.klass, "bad_args");
  assert.equal(result.prompt, "a test cat");
  assert.equal(result.aspect_ratio, "1:1");
  assert.ok(result.completed_at);
  const bundle = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}`).then((res) => res.json());
  const summary = bundle.generation_results.find((r) => r.job_id === jobId);
  assert.ok(summary, "bundle exposes durable generation result summary");
  assert.equal(summary.status, "failed");
  assert.equal(summary.klass, "bad_args");
  await assert.rejects(stat(sidecarPath(jobId)), /ENOENT/);
});

test("POST /generate accepts generate_image_pro.js sidecars", async () => {
  const { jobId } = await seedDraft({
    overrides: {
      model: "image-generation-pro",
      image_size: "1K",
      cost_usd: 0.26,
      script: "generate_image_pro.js",
      argv: ["--definitely-unknown-flag"],
    },
  });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, {
    method: "POST",
  });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.job_id, jobId);

  const result = await waitForResult(jobId);
  assert.equal(result.ok, false);
  assert.equal(result.job_id, jobId);
  assert.equal(result.kind, "image");
  assert.equal(result.model, "image-generation-pro");
  assert.equal(result.klass, "bad_args");
  await assert.rejects(stat(sidecarPath(jobId)), /ENOENT/);
});

test("POST /generate with non-whitelisted script → 400", async () => {
  const { jobId } = await seedDraft({
    overrides: { script: "rm -rf /" },
  });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, {
    method: "POST",
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /unknown script/);
});

test("POST /generate claims the draft before spawning", async () => {
  const { jobId } = await seedDraft({
    overrides: { argv: ["--definitely-unknown-flag"] },
  });
  const [r1, r2] = await Promise.all([
    fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, { method: "POST" }),
    fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}/generate`, { method: "POST" }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [202, 409]);

  const result = await waitForResult(jobId);
  assert.equal(result.ok, false);
  assert.equal(result.klass, "bad_args");
  await assert.rejects(stat(sidecarPath(jobId)), /ENOENT/);
});

test("new-project bypass mode fires through viewer and waits on result sidecar", async () => {
  const now = new Date().toISOString();
  await writeFile(
    projectPath("meta.json"),
    JSON.stringify({
      id: TEST_PROJECT_ID,
      title: "T",
      created_at: now,
      last_active_at: now,
      agent_id: "codex",
      dangerously_skip_draft_gate: true,
    }, null, 2) + "\n",
  );

  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage",
      "--prompt", "x",
      "--ref-source-id", "image_missing",
      "--project-id", TEST_PROJECT_ID,
    ],
  });
  assert.equal(code, 1, `stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.match(reply.job_id, /^pending_/);
  assert.equal(reply.kind, "image");
  assert.equal(reply.klass, "bad_args");

  const result = await waitForResult(reply.job_id);
  assert.deepEqual(result, reply);
  await assert.rejects(stat(sidecarPath(reply.job_id)), /ENOENT/);
});

test("new-project bypass mode with --draft-only fires and lets a batch waiter own the result", async () => {
  const now = new Date().toISOString();
  await writeFile(
    projectPath("meta.json"),
    JSON.stringify({
      id: TEST_PROJECT_ID,
      title: "T",
      created_at: now,
      last_active_at: now,
      agent_id: "codex",
      dangerously_skip_draft_gate: true,
    }, null, 2) + "\n",
  );

  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage",
      "--draft-only",
      "--prompt", "x",
      "--ref-source-id", "image_missing",
      "--project-id", TEST_PROJECT_ID,
    ],
  });
  assert.equal(code, 0, `stderr:\n${stderr}`);
  const replies = parseReplies(stdout);
  const staged = replies.find((r) => r.stage === "draft");
  const fired = replies[replies.length - 1];
  assert.match(staged.job_id, /^pending_/);
  assert.equal(fired.ok, true);
  assert.equal(fired.job_id, staged.job_id);
  assert.equal(fired.stage, "running");
  assert.equal(fired.fired, true);

  const result = await waitForResult(staged.job_id);
  assert.equal(result.ok, false);
  assert.equal(result.klass, "bad_args");
  await assert.rejects(stat(sidecarPath(staged.job_id)), /ENOENT/);
});

test("DELETE writes cancelled result, unlinks sidecar, and is idempotent", async () => {
  const { jobId } = await seedDraft();
  const r1 = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "DELETE",
  });
  assert.equal(r1.status, 200);
  const result = await waitForResult(jobId);
  assert.equal(result.ok, false);
  assert.equal(result.job_id, jobId);
  assert.equal(result.kind, "image");
  assert.equal(result.klass, "cancelled");
  assert.equal(result.message, "cancelled by user");
  assert.equal(result.prompt, "a test cat");
  await assert.rejects(stat(sidecarPath(jobId)));
  const r2 = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "DELETE",
  });
  assert.equal(r2.status, 200, "DELETE on missing sidecar is idempotent");
});

test("DELETE refuses to cancel a running entry", async () => {
  const { jobId } = await seedDraft({ overrides: { stage: "running" } });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "DELETE",
  });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.match(body.error, /cannot cancel running/);
  const sidecar = await readSidecar(jobId);
  assert.equal(sidecar.stage, "running");
  await assert.rejects(stat(resultPath(jobId)), /ENOENT/);
});

test("PATCH on unknown project → 404", async () => {
  const r = await fetch(`${baseUrl}/projects/no_such_project/pending/anything`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  assert.equal(r.status, 404);
});

test("PATCH on unknown jobId → 404", async () => {
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/pending_doesnotexist`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  assert.equal(r.status, 404);
});

test("PATCH position is allowed on running entries (drag persists across stages)", async () => {
  const { jobId } = await seedDraft({ overrides: { stage: "running" } });
  const r = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ position: { x: 120, y: 240 } }),
  });
  assert.equal(r.status, 200);
  const after = await readSidecar(jobId);
  assert.deepEqual(after.position, { x: 120, y: 240 });
  // Stage and argv untouched.
  assert.equal(after.stage, "running");
});

test("writePending preserves position across stage transitions", async () => {
  const { jobId } = await seedDraft({
    overrides: { position: { x: 50, y: 60 } },
  });
  // The route-owned replay path calls writePending against the existing
  // job id. It overwrites the sidecar but should copy `position` forward
  // from the draft sidecar (sticky field semantics).
  const originalCwd = process.cwd();
  process.chdir(projectPath());
  try {
    await writePending({
      jobId,
      kind: "image",
      prompt: "still the same cat",
      aspectRatio: "1:1",
      model: "image-generation",
      imageSize: "1K",
    });
  } finally {
    process.chdir(originalCwd);
  }
  const after = await readSidecar(jobId);
  assert.deepEqual(after.position, { x: 50, y: 60 }, "position must survive writePending");
});

test("5x concurrent position PATCHes serialize cleanly under the project lock", async () => {
  // Spiral-persist + drag can both PATCH the same id within ms; the
  // lock must produce a well-formed sidecar with one of the writes won.
  const { jobId } = await seedDraft();
  const positions = [
    { x: 10, y: 10 },
    { x: 20, y: 20 },
    { x: 30, y: 30 },
    { x: 40, y: 40 },
    { x: 50, y: 50 },
  ];
  const results = await Promise.all(
    positions.map((position) =>
      fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/pending/${jobId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position }),
      }).then((r) => r.status),
    ),
  );
  for (const s of results) {
    assert.equal(s, 200, "every concurrent PATCH must succeed under the lock");
  }
  const after = await readSidecar(jobId);
  const candidates = positions.map((p) => JSON.stringify(p));
  assert.ok(
    candidates.includes(JSON.stringify(after.position)),
    `final position must be one of the writes; got ${JSON.stringify(after.position)}`,
  );
  // Sidecar must still be well-formed: prompt, stage, argv all intact.
  assert.equal(after.stage, "draft");
  assert.equal(after.prompt, "a test cat");
  assert.ok(Array.isArray(after.argv));
});
