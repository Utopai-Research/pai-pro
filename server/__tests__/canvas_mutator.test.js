// Unit tests for canvas_mutator. Uses node:test (no extra deps).
//
// Each test sets up a fresh temp project dir, exercises one op or scenario,
// asserts in-memory state + disk-state agree.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mutate,
  initProjectMutatorState,
} from "../canvas_mutator.js";
import { validateWorkflow, formatErrors } from "../canvas_schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_WORKFLOW_PATH = join(__dirname, "fixtures", "sample_workflow.json");

async function setupProject(initial = null) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-mutator-test-"));
  const workflowPath = join(dir, "workflow.json");
  const mutationLogPath = join(dir, "mutations.jsonl");
  const p = {
    id: "test_project",
    canvasState:
      initial || {
        version: 2,
        workflow_id: "test_project",
        title: "Test",
        nodes: [],
        edges: [],
      },
  };
  initProjectMutatorState(p, { workflowPath, mutationLogPath });
  return { p, dir, workflowPath, mutationLogPath };
}

async function teardown(dir) {
  await rm(dir, { recursive: true, force: true });
}

function newRid() {
  return `t-${Math.random().toString(36).slice(2)}`;
}

async function readWorkflow(workflowPath) {
  const raw = await readFile(workflowPath, "utf8");
  return JSON.parse(raw);
}

// --------------------------------------------------------------------- //

test("addNode: assigns next id, persists to disk, valid doc", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    const reply = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: { node: { type: "note", data: { label: "hi", body: "world" } } },
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.applied, true);
    assert.equal(reply.assigned.node_id, "note_1");
    assert.equal(p.canvasState.nodes.length, 1);
    const onDisk = await readWorkflow(workflowPath);
    assert.equal(onDisk.nodes.length, 1);
    assert.equal(onDisk.nodes[0].id, "note_1");
    assert.ok(validateWorkflow(onDisk), formatErrors(validateWorkflow.errors));
  } finally {
    await teardown(dir);
  }
});

test("addNode: numbering is per-type", async () => {
  const { p, dir } = await setupProject();
  try {
    await mutate(p, { request_id: newRid(), op: "addNode", payload: { node: { type: "note", data: { label: "n1", body: "x" } } } });
    await mutate(p, { request_id: newRid(), op: "addNode", payload: { node: { type: "note", data: { label: "n2", body: "x" } } } });
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          data: { label: "img1", local_path: "assets/images/dummy.png", metadata: { source: "test" } },
        },
      },
    });
    assert.equal(r.assigned.node_id, "image_1"); // not note_3
  } finally {
    await teardown(dir);
  }
});

test("addNode: id collision returns klass:conflict", async () => {
  const { p, dir } = await setupProject();
  try {
    await mutate(p, { request_id: newRid(), op: "addNode", payload: { node: { id: "note_42", type: "note", data: { label: "x", body: "y" } } } });
    const r = await mutate(p, { request_id: newRid(), op: "addNode", payload: { node: { id: "note_42", type: "note", data: { label: "x", body: "y" } } } });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "conflict");
  } finally {
    await teardown(dir);
  }
});

test("addNode: invalid data returns klass:validation, doc unchanged", async () => {
  const { p, dir } = await setupProject();
  try {
    const before = structuredClone(p.canvasState);
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: { node: { type: "note", data: { label: "missing body" } } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "validation");
    assert.deepEqual(p.canvasState, before);
  } finally {
    await teardown(dir);
  }
});

test("updateNode: deep-merge data, nulls delete keys", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "image_1", type: "image_result", data: { label: "a", local_path: "assets/images/dummy_a.png", metadata: { source: "test", model: "old" } } },
    ],
    edges: [],
  });
  try {
    const r1 = await mutate(p, {
      request_id: newRid(),
      op: "updateNode",
      payload: { id: "image_1", patch: { metadata: { model: "new" }, prompt: "p" } },
    });
    assert.equal(r1.ok, true);
    assert.equal(p.canvasState.nodes[0].data.metadata.model, "new");
    assert.equal(p.canvasState.nodes[0].data.metadata.source, "test", "preserves untouched metadata keys");
    assert.equal(p.canvasState.nodes[0].data.prompt, "p");

    const r2 = await mutate(p, {
      request_id: newRid(),
      op: "updateNode",
      payload: { id: "image_1", patch: { prompt: null } },
    });
    assert.equal(r2.ok, true);
    assert.equal("prompt" in p.canvasState.nodes[0].data, false, "null deletes key");
  } finally {
    await teardown(dir);
  }
});

test("updateNode: missing id returns klass:not_found", async () => {
  const { p, dir } = await setupProject();
  try {
    const r = await mutate(p, { request_id: newRid(), op: "updateNode", payload: { id: "image_999", patch: { label: "x" } } });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "not_found");
  } finally {
    await teardown(dir);
  }
});

test("deleteNode: cascades edges and drops legacy workflow groups", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "image_1", type: "image_result", data: { label: "a", local_path: "assets/images/dummy_a.png", metadata: { source: "t" } } },
      { id: "image_2", type: "image_result", data: { label: "b", local_path: "assets/images/dummy_b.png", metadata: { source: "t" } } },
      { id: "image_3", type: "image_result", data: { label: "c", local_path: "assets/images/dummy_c.png", metadata: { source: "t" } } },
    ],
    edges: [
      { from: "image_1", to: "image_2", kind: "derived" },
      { from: "image_2", to: "image_3" },
    ],
    groups: [
      { id: "group_solo", title: "alone", node_ids: ["image_1"], hue: 10 },
      { id: "group_two", title: "two", node_ids: ["image_2", "image_3"], hue: 200 },
    ],
  });
  try {
    const r = await mutate(p, { request_id: newRid(), op: "deleteNode", payload: { id: "image_1" } });
    assert.equal(r.ok, true);
    assert.equal(p.canvasState.nodes.length, 2);
    assert.equal(p.canvasState.edges.length, 1, "edge image_1->image_2 dropped");
    assert.equal("groups" in p.canvasState, false, "legacy workflow groups dropped");
  } finally {
    await teardown(dir);
  }
});

test("addEdge: dedupe is silent no-op", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [],
    edges: [{ from: "a", to: "b", kind: "derived" }],
  });
  try {
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addEdge",
      payload: { edge: { from: "a", to: "b", kind: "derived" } },
    });
    assert.equal(r.ok, true);
    assert.equal(p.canvasState.edges.length, 1);
  } finally {
    await teardown(dir);
  }
});

test("addEdge: rejects missing source or target nodes", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "note_1", type: "note", data: { label: "a", body: "A" } },
      { id: "note_2", type: "note", data: { label: "b", body: "B" } },
    ],
    edges: [],
  });
  try {
    const ok = await mutate(p, {
      request_id: newRid(),
      op: "addEdge",
      payload: { edge: { from: "note_1", to: "note_2", kind: "derived" } },
    });
    assert.equal(ok.ok, true);
    assert.equal(p.canvasState.edges.length, 1);

    const missingSource = await mutate(p, {
      request_id: newRid(),
      op: "addEdge",
      payload: { edge: { from: "note_404", to: "note_2", kind: "derived" } },
    });
    assert.equal(missingSource.ok, false);
    assert.equal(missingSource.klass, "not_found");
    assert.match(missingSource.message, /source node not found/);

    const missingTarget = await mutate(p, {
      request_id: newRid(),
      op: "addEdge",
      payload: { edge: { from: "note_1", to: "note_404", kind: "derived" } },
    });
    assert.equal(missingTarget.ok, false);
    assert.equal(missingTarget.klass, "not_found");
    assert.match(missingTarget.message, /target node not found/);
    assert.equal(p.canvasState.edges.length, 1);
  } finally {
    await teardown(dir);
  }
});

test("deleteEdge: removes; missing returns not_found", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "b", kind: "derived" },
    ],
  });
  try {
    const r1 = await mutate(p, { request_id: newRid(), op: "deleteEdge", payload: { from: "a", to: "b", kind: "derived" } });
    assert.equal(r1.ok, true);
    assert.equal(p.canvasState.edges.length, 1);
    const r2 = await mutate(p, { request_id: newRid(), op: "deleteEdge", payload: { from: "x", to: "y" } });
    assert.equal(r2.ok, false);
    assert.equal(r2.klass, "not_found");
  } finally {
    await teardown(dir);
  }
});

test("setTitle updates title", async () => {
  const { p, dir } = await setupProject();
  try {
    const r = await mutate(p, { request_id: newRid(), op: "setTitle", payload: { title: "New Title" } });
    assert.equal(r.ok, true);
    assert.equal(p.canvasState.title, "New Title");
  } finally {
    await teardown(dir);
  }
});

test("addBatch: nodes + edges with $N, atomic on disk", async () => {
  const { p, dir, workflowPath } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "image_1", type: "image_result", data: { label: "source", local_path: "assets/images/dummy_a.png", metadata: { source: "t" } } },
    ],
    edges: [],
  });
  try {
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addBatch",
      payload: {
        nodes: [
          { type: "image_result", data: { label: "tile_a", local_path: "assets/images/tile_a.png", subtype: "split", source_id: "image_1", grid_position: [1, 1], metadata: { source: "split" } } },
          { type: "image_result", data: { label: "tile_b", local_path: "assets/images/tile_b.png", subtype: "split", source_id: "image_1", grid_position: [1, 2], metadata: { source: "split" } } },
        ],
        edges: [
          { from: "image_1", to: "$0", kind: "derived" },
          { from: "image_1", to: "$1", kind: "derived" },
        ],
      },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.assigned.node_ids, ["image_2", "image_3"]);
    const onDisk = await readWorkflow(workflowPath);
    assert.equal(onDisk.nodes.length, 3);
    assert.equal(onDisk.edges.length, 2);
    assert.deepEqual(onDisk.edges.map((e) => e.to), ["image_2", "image_3"]);
    assert.equal("groups" in onDisk, false);
  } finally {
    await teardown(dir);
  }
});

test("addBatch: missing edge endpoint rolls back the whole batch", async () => {
  const { p, dir, workflowPath } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "image_1", type: "image_result", data: { label: "source", local_path: "assets/images/source.png", metadata: { source: "t" } } },
    ],
    edges: [],
  });
  try {
    const before = structuredClone(p.canvasState);
    await writeFile(workflowPath, JSON.stringify(before, null, 2) + "\n");
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addBatch",
      payload: {
        nodes: [
          { type: "image_result", data: { label: "child", local_path: "assets/images/child.png", metadata: { source: "t" } } },
        ],
        edges: [
          { from: "image_missing", to: "$0", kind: "derived" },
        ],
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "not_found");
    assert.deepEqual(p.canvasState, before);
    assert.deepEqual(await readWorkflow(workflowPath), before);
  } finally {
    await teardown(dir);
  }
});

test("addBatch: archived authorship source does not block result node landing", async () => {
  const { p, dir, workflowPath } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      {
        id: "image_1",
        type: "image_result",
        data: {
          label: "archived source",
          local_path: "assets/images/source.png",
          archived: true,
          metadata: { source: "t" },
        },
      },
    ],
    edges: [],
  });
  try {
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addBatch",
      payload: {
        nodes: [
          {
            type: "image_result",
            data: {
              label: "new image",
              local_path: "assets/images/new.png",
              metadata: { source: "pai" },
            },
          },
        ],
        edges: [{ from: "image_1", to: "$0", kind: "derived" }],
      },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.assigned.node_ids, ["image_2"]);
    const onDisk = await readWorkflow(workflowPath);
    assert.equal(onDisk.nodes.length, 2);
    assert.equal(onDisk.nodes[1].id, "image_2");
    assert.deepEqual(onDisk.edges, [{ from: "image_1", to: "image_2", kind: "derived" }]);
  } finally {
    await teardown(dir);
  }
});

test("updateBatch: N patches land atomically; invalid mid-batch rolls back all", async () => {
  const { p, dir, workflowPath } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "video_1", type: "video_result", data: { label: "a", local_path: "assets/videos/dummy_a.mp4", duration: 5, aspect: "16:9", shot_id: null, metadata: { source: "t" } } },
      { id: "video_2", type: "video_result", data: { label: "b", local_path: "assets/videos/dummy_b.mp4", duration: 5, aspect: "16:9", shot_id: null, metadata: { source: "t" } } },
      { id: "video_3", type: "video_result", data: { label: "c", local_path: "assets/videos/dummy_c.mp4", duration: 5, aspect: "16:9", shot_id: null, metadata: { source: "t" } } },
    ],
    edges: [],
  });
  try {
    const r = await mutate(p, {
      request_id: newRid(),
      op: "updateBatch",
      payload: {
        updates: [
          { id: "video_1", patch: { shot_id: 1 } },
          { id: "video_2", patch: { shot_id: 2 } },
          { id: "video_3", patch: { shot_id: 3 } },
        ],
      },
    });
    assert.equal(r.ok, true);
    assert.equal(p.canvasState.nodes[0].data.shot_id, 1);
    assert.equal(p.canvasState.nodes[1].data.shot_id, 2);
    assert.equal(p.canvasState.nodes[2].data.shot_id, 3);
    const onDisk = await readWorkflow(workflowPath);
    assert.equal(onDisk.nodes[0].data.shot_id, 1);

    // Rollback case: one update references a missing node.
    const before = structuredClone(p.canvasState);
    const r2 = await mutate(p, {
      request_id: newRid(),
      op: "updateBatch",
      payload: {
        updates: [
          { id: "video_1", patch: { shot_id: 99 } },
          { id: "video_does_not_exist", patch: { shot_id: 1 } },
        ],
      },
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.klass, "not_found");
    assert.deepEqual(p.canvasState, before, "first update rolled back when second failed");
  } finally {
    await teardown(dir);
  }
});

test("addBatch: invalid mid-batch leaves state unchanged", async () => {
  const { p, dir } = await setupProject();
  try {
    const before = structuredClone(p.canvasState);
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addBatch",
      payload: {
        nodes: [
          { type: "note", data: { label: "ok", body: "yes" } },
          { type: "note", data: { label: "bad" /* body missing */ } },
        ],
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "validation");
    assert.deepEqual(p.canvasState, before, "first node rolled back");
  } finally {
    await teardown(dir);
  }
});

test("idempotency: same request_id returns cached reply with applied:false", async () => {
  const { p, dir } = await setupProject();
  try {
    const rid = newRid();
    const r1 = await mutate(p, { request_id: rid, op: "addNode", payload: { node: { type: "note", data: { label: "a", body: "b" } } } });
    assert.equal(r1.ok, true);
    assert.equal(r1.applied, true);
    const r2 = await mutate(p, { request_id: rid, op: "addNode", payload: { node: { type: "note", data: { label: "a", body: "b" } } } });
    assert.equal(r2.ok, true);
    assert.equal(r2.applied, false);
    assert.equal(r2.assigned.node_id, r1.assigned.node_id);
    assert.equal(p.canvasState.nodes.length, 1, "no second node added");
  } finally {
    await teardown(dir);
  }
});

test("malformed envelope rejected (no request_id)", async () => {
  const { p, dir } = await setupProject();
  try {
    const r = await mutate(p, { op: "addNode", payload: { node: { type: "note", data: { label: "a", body: "b" } } } });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "validation");
  } finally {
    await teardown(dir);
  }
});

test("hooks.onApply fires once on success", async () => {
  const { p, dir } = await setupProject();
  try {
    let calls = 0;
    let lastVersion = -1;
    await mutate(
      p,
      { request_id: newRid(), op: "addNode", payload: { node: { type: "note", data: { label: "a", body: "b" } } } },
      {
        onApply: (proj) => {
          calls++;
          lastVersion = proj.version;
        },
      }
    );
    assert.equal(calls, 1);
    assert.equal(lastVersion, 1);
  } finally {
    await teardown(dir);
  }
});

test("sample workflow fixture validates against doc schema", async () => {
  const raw = await readFile(SAMPLE_WORKFLOW_PATH, "utf8");
  const doc = JSON.parse(raw);
  const ok = validateWorkflow(doc);
  assert.ok(ok, ok ? "" : formatErrors(validateWorkflow.errors));
});

// --- tmp_path + next_ids -------------------------------------------------

async function stageTmpFile(dir, contents, ext = ".png") {
  const tmpDir = join(dir, "assets", ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const abs = join(tmpDir, `staged_${Math.random().toString(36).slice(2)}${ext}`);
  await writeFile(abs, contents);
  return abs;
}

test("addNode tmp_path: renames file into assets/<bucket>/<id>.<ext>, fills local_path", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    const tmpPath = await stageTmpFile(dir, "PNG-BYTES", ".png");
    const reply = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          tmp_path: tmpPath,
          data: { label: "img", metadata: { source: "test" } },
        },
      },
    });
    assert.equal(reply.ok, true, reply.message);
    const id = reply.assigned.node_id;
    assert.equal(id, "image_1");
    // Source file gone, target file present at <id>.png
    const targetAbs = join(dir, "assets", "images", `${id}.png`);
    const targetStat = await stat(targetAbs);
    assert.ok(targetStat.isFile());
    await assert.rejects(stat(tmpPath));
    // Node has local_path filled by the mutator. The viewer URL is
    // synthesized on the client side from local_path — never stored.
    const onDisk = await readWorkflow(workflowPath);
    const node = onDisk.nodes.find((n) => n.id === id);
    assert.equal(node.data.local_path, `assets/images/${id}.png`);
    assert.equal(node.data.image_url, undefined, "image_url is not persisted");
  } finally {
    await teardown(dir);
  }
});

test("addNode tmp_path: outside .tmp/ rejected with bad_args, no JSON change", async () => {
  const { p, dir } = await setupProject();
  try {
    // Stage a file in a sibling dir (NOT under assets/.tmp/).
    const evilDir = join(dir, "elsewhere");
    await mkdir(evilDir, { recursive: true });
    const evilAbs = join(evilDir, "evil.png");
    await writeFile(evilAbs, "x");
    const reply = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          tmp_path: evilAbs,
          data: { label: "evil", metadata: { source: "test" } },
        },
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.klass, "bad_args");
    // Source file untouched, no node added.
    const s = await stat(evilAbs);
    assert.ok(s.isFile());
    assert.equal(p.canvasState.nodes.length, 0);
  } finally {
    await teardown(dir);
  }
});

test("addNode tmp_path: note type rejected (notes carry no asset)", async () => {
  const { p, dir } = await setupProject();
  try {
    const tmpPath = await stageTmpFile(dir, "x", ".txt");
    const reply = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "note",
          tmp_path: tmpPath,
          data: { label: "n", body: "b" },
        },
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.klass, "validation");
  } finally {
    await teardown(dir);
  }
});

test("next_ids: monotonic across deleteNode + addNode (no reuse)", async () => {
  const { p, dir } = await setupProject();
  try {
    // Add three image nodes (image_1 .. image_3).
    for (let i = 0; i < 3; i++) {
      await mutate(p, {
        request_id: newRid(),
        op: "addNode",
        payload: {
          node: {
            type: "image_result",
            data: { label: `img${i}`, local_path: "assets/images/dummy.png", metadata: { source: "test" } },
          },
        },
      });
    }
    // Delete the most recent one — its file (if any) stays per policy.
    await mutate(p, { request_id: newRid(), op: "deleteNode", payload: { id: "image_3" } });
    // Next mint must be image_4, not image_3.
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          data: { label: "img4", local_path: "assets/images/dummy.png", metadata: { source: "test" } },
        },
      },
    });
    assert.equal(r.assigned.node_id, "image_4");
    assert.equal(p.canvasState.next_ids.image_result, 4);
  } finally {
    await teardown(dir);
  }
});

test("next_ids: backfills from existing nodes when counter absent (legacy doc)", async () => {
  const legacy = {
    version: 2,
    workflow_id: "legacy",
    title: "Legacy",
    nodes: [
      { id: "image_5", type: "image_result", data: { label: "x", local_path: "assets/images/u.png", metadata: { source: "t" } } },
      { id: "image_7", type: "image_result", data: { label: "y", local_path: "assets/images/u.png", metadata: { source: "t" } } },
    ],
    edges: [],
  };
  const { p, dir } = await setupProject(legacy);
  try {
    const r = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          data: { label: "new", local_path: "assets/images/u.png", metadata: { source: "t" } },
        },
      },
    });
    // Backfill should pick up max(5, 7) → 7, then mint 8.
    assert.equal(r.assigned.node_id, "image_8");
    assert.equal(p.canvasState.next_ids.image_result, 8);
  } finally {
    await teardown(dir);
  }
});

test("addNode tmp_path: rename failure rolls back, no node added", async () => {
  const { p, dir } = await setupProject();
  try {
    // Reference a tmp file that doesn't exist on disk.
    const tmpPath = join(dir, "assets", ".tmp", "does_not_exist.png");
    const reply = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: {
        node: {
          type: "image_result",
          tmp_path: tmpPath,
          data: { label: "x", metadata: { source: "test" } },
        },
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.klass, "infra");
    assert.equal(p.canvasState.nodes.length, 0);
  } finally {
    await teardown(dir);
  }
});

test("deleteNode on note: workflow drops node, .md mirror survives on disk", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    const r1 = await mutate(p, {
      request_id: newRid(),
      op: "addNode",
      payload: { node: { type: "note", data: { label: "n", body: "hello world" } } },
    });
    assert.equal(r1.ok, true);
    const noteId = r1.assigned.node_id;
    const mdPath = join(dirname(workflowPath), "assets", "notes", `${noteId}.md`);
    await stat(mdPath); // throws if missing

    const r2 = await mutate(p, {
      request_id: newRid(),
      op: "deleteNode",
      payload: { id: noteId },
    });
    assert.equal(r2.ok, true);
    assert.equal(p.canvasState.nodes.length, 0, "node removed from workflow");
    await stat(mdPath); // throws if the .md was unlinked — we want it to survive
  } finally {
    await teardown(dir);
  }
});

test("updateNode archived: true persists, archived: null deletes the key", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "t",
    title: "T",
    nodes: [
      { id: "image_1", type: "image_result", data: { label: "a", local_path: "assets/images/dummy_a.png", prompt: "p", metadata: { source: "test", model: "m1" } } },
    ],
    edges: [],
  });
  try {
    const r1 = await mutate(p, {
      request_id: newRid(),
      op: "updateNode",
      payload: { id: "image_1", patch: { archived: true } },
    });
    assert.equal(r1.ok, true);
    assert.equal(p.canvasState.nodes[0].data.archived, true);
    assert.equal(p.canvasState.nodes[0].data.prompt, "p", "preserves other fields");
    assert.equal(p.canvasState.nodes[0].data.metadata.model, "m1", "preserves nested metadata");

    const r2 = await mutate(p, {
      request_id: newRid(),
      op: "updateNode",
      payload: { id: "image_1", patch: { archived: null } },
    });
    assert.equal(r2.ok, true);
    assert.equal("archived" in p.canvasState.nodes[0].data, false, "archived key deleted");
    assert.equal(p.canvasState.nodes[0].data.prompt, "p", "still preserves other fields");
  } finally {
    await teardown(dir);
  }
});

test("mutation log appends one line per applied mutation", async () => {
  const { p, dir, mutationLogPath } = await setupProject();
  try {
    await mutate(p, { request_id: newRid(), op: "addNode", payload: { node: { type: "note", data: { label: "a", body: "b" } } } });
    await mutate(p, { request_id: newRid(), op: "setTitle", payload: { title: "Renamed" } });
    // give the best-effort append a tick
    await new Promise((r) => setTimeout(r, 50));
    const log = await readFile(mutationLogPath, "utf8");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].op, "addNode");
    assert.equal(parsed[1].op, "setTitle");
  } finally {
    await teardown(dir);
  }
});
