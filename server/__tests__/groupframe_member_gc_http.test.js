// Regression for audit N45: deleting a node must also evict its id from
// the canvas_positions sidecar — both positions{} and every
// groupFrames[*].memberIds — so a scene/group frame stops sizing a node
// that no longer exists. workflow.json and canvas_positions.json are
// separate stores under separate locks; the mutator's onApply hook is
// what bridges them.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const TEST_PROJECT_ID = "test_gc";

let viewerProc = null;
let projectsDir = null;
let baseUrl = "";

function freePort() {
  return 18200 + Math.floor(Math.random() * 1000);
}

async function setupTestProject(root, id) {
  const dir = join(root, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  const workflow = {
    version: 2,
    workflow_id: id,
    title: "GC",
    nodes: [
      { id: "note_1", type: "note", data: { label: "one", body: "A" } },
      { id: "note_2", type: "note", data: { label: "two", body: "B" } },
      { id: "note_3", type: "note", data: { label: "three", body: "C" } },
      { id: "note_4", type: "note", data: { label: "four", body: "D" } },
      { id: "note_5", type: "note", data: { label: "five", body: "E" } },
      { id: "note_6", type: "note", data: { label: "six", body: "F" } },
    ],
    edges: [],
  };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: "GC", created_at: now, last_active_at: now }, null, 2) + "\n",
  );
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "groupframe-gc-http-"));
  const port = freePort();
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
    await new Promise((r) => setTimeout(r, 100));
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

async function deleteNode(id) {
  const res = await fetch(`${baseUrl}/projects/${TEST_PROJECT_ID}/mutate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: `del-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      op: "deleteNode",
      payload: { id },
    }),
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

test("deleteNode evicts the id from positions and surviving group frames", async () => {
  // frame_scene keeps 3 members (survives losing one); frame_pair has
  // exactly 2 (drops below the render minimum when one is deleted).
  // A node may live in only one upserted frame, so the two frames use
  // disjoint members.
  const layout = await postLayout({
    positions: {
      note_1: { x: 100, y: 100 },
      note_2: { x: 400, y: 100 },
      note_3: { x: 700, y: 100 },
      note_4: { x: 1000, y: 100 },
      note_5: { x: 100, y: 600 },
      note_6: { x: 400, y: 600 },
    },
    groupFrames: {
      upsert: {
        frame_scene: {
          memberIds: ["note_1", "note_2", "note_3"],
          x: 76, y: 76, width: 960, height: 468, hue: 200, title: "Scene",
        },
        frame_pair: {
          memberIds: ["note_5", "note_6"],
          x: 80, y: 576, width: 648, height: 468, hue: 30, title: "Pair",
        },
      },
    },
  });
  assert.equal(layout.status, 200, "layout seeded");

  // Sanity: the members are present in both stores before deletion.
  const before = await readPositions();
  assert.ok(before.positions.note_1, "note_1 has a drag position");
  assert.ok(before.groupFrames.frame_scene.memberIds.includes("note_1"));
  assert.ok(before.groupFrames.frame_pair.memberIds.includes("note_5"));

  // Delete a member of the 3-member frame: the frame survives, minus the ghost.
  const delScene = await deleteNode("note_1");
  assert.equal(delScene.status, 200, "deleteNode note_1 ok");
  assert.deepEqual(delScene.body.assigned, { deleted_node_ids: ["note_1"] });

  // Delete a member of the 2-member frame: it drops below two and is removed.
  const delPair = await deleteNode("note_5");
  assert.equal(delPair.status, 200, "deleteNode note_5 ok");

  const after = await readPositions();
  // positions{} no longer references either dead id.
  assert.equal(after.positions.note_1, undefined, "note_1 drag position pruned");
  assert.equal(after.positions.note_5, undefined, "note_5 drag position pruned");
  // The surviving frame keeps its other members, minus the ghost.
  assert.deepEqual(
    after.groupFrames.frame_scene.memberIds,
    ["note_2", "note_3"],
    "ghost member pruned from surviving frame",
  );
  // The frame that fell below two members is removed wholesale.
  assert.equal(after.groupFrames.frame_pair, undefined, "sub-2-member frame deleted");
  // Untouched nodes are left alone.
  assert.ok(after.positions.note_2, "unrelated position retained");
  assert.ok(after.positions.note_6, "unrelated position retained");
});
