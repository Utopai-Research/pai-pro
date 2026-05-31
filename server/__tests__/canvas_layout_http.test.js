import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const TEST_PROJECT_ID = "test_layout";

let viewerProc = null;
let projectsDir = null;
let port = 0;
let baseUrl = "";

async function freePort() {
  return 18100 + Math.floor(Math.random() * 1000);
}

async function setupTestProject(root, id) {
  const dir = join(root, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  const workflow = {
    version: 2,
    workflow_id: id,
    title: "Layout",
    nodes: [
      { id: "note_1", type: "note", data: { label: "one", body: "A" } },
      { id: "note_2", type: "note", data: { label: "two", body: "B" } },
      { id: "note_3", type: "note", data: { label: "three", body: "C" } },
    ],
    edges: [],
  };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: "Layout", created_at: now, last_active_at: now }, null, 2) + "\n",
  );
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "canvas-layout-http-"));
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
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("viewer did not start in 10s");
}

async function stopViewer() {
  if (viewerProc) {
    viewerProc.kill("SIGTERM");
    await new Promise((resolve) => viewerProc.once("exit", resolve));
    viewerProc = null;
  }
  if (projectsDir) {
    await rm(projectsDir, { recursive: true, force: true });
    projectsDir = null;
  }
}

async function postLayout(body) {
  const res = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/canvas-layout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function readPositions() {
  return JSON.parse(
    await readFile(join(projectsDir, TEST_PROJECT_ID, "canvas_positions.json"), "utf8"),
  );
}

test.before(async () => { await startViewer(); });
test.after(async () => { await stopViewer(); });

test("POST /canvas-layout writes positions and a visible group frame atomically", async () => {
  const res = await postLayout({
    positions: {
      note_1: { x: 100, y: 120 },
      note_2: { x: 420, y: 120 },
    },
    groupFrames: {
      upsert: {
        frame_scene: {
          memberIds: ["note_1", "note_2"],
          x: 76,
          y: 96,
          width: 648,
          height: 468,
          hue: 200,
          title: "Scene",
        },
      },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const state = await readPositions();
  assert.deepEqual(state.positions.note_1, { x: 100, y: 120 });
  assert.deepEqual(state.positions.note_2, { x: 420, y: 120 });
  assert.deepEqual(state.groupFrames.frame_scene.memberIds, ["note_1", "note_2"]);
});

test("POST /canvas-layout evicts overlapping members from older frames", async () => {
  const res = await postLayout({
    positions: {
      note_3: { x: 740, y: 120 },
    },
    groupFrames: {
      upsert: {
        frame_refs: {
          memberIds: ["note_2", "note_3"],
          x: 396,
          y: 96,
          width: 648,
          height: 468,
          hue: 30,
          title: "Refs",
        },
      },
    },
  });
  assert.equal(res.status, 200);
  const state = await readPositions();
  assert.equal(state.groupFrames.frame_scene, undefined, "old frame deleted after eviction left one member");
  assert.deepEqual(state.groupFrames.frame_refs.memberIds, ["note_2", "note_3"]);
});

test("POST /canvas-layout rejects unknown frame members", async () => {
  const before = await readPositions();
  const res = await postLayout({
    groupFrames: {
      upsert: {
        frame_bad: {
          memberIds: ["note_1", "note_missing"],
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          hue: 0,
          title: "Bad",
        },
      },
    },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unknown node id/);
  assert.deepEqual(await readPositions(), before);
});

test("POST /canvas-layout allows stale position cleanup", async () => {
  const res = await postLayout({
    positions: {
      note_deleted: null,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});
