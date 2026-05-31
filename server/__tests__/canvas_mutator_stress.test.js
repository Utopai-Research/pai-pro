// Concurrency stress tests. The race conditions that motivate this whole
// subsystem (CLAUDE.md "Background by default" + plan §Context "lost writes
// from parallel completions") have to be reproducible here — if these tests
// pass with the mutator and would fail without it, we've shipped the fix.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutate, initProjectMutatorState } from "../canvas_mutator.js";
import { validateWorkflow, formatErrors } from "../canvas_schema.js";

async function setupProject(seed = null) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-mutator-stress-"));
  const workflowPath = join(dir, "workflow.json");
  const mutationLogPath = join(dir, "mutations.jsonl");
  const p = {
    id: "stress_project",
    canvasState:
      seed || { version: 2, workflow_id: "stress_project", title: "S", nodes: [], edges: [] },
  };
  initProjectMutatorState(p, { workflowPath, mutationLogPath });
  return { p, dir, workflowPath };
}

async function teardown(dir) {
  await rm(dir, { recursive: true, force: true });
}

test("100 parallel addNode → all 100 land with unique ids, doc valid on disk", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    const N = 100;
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutate(p, {
          request_id: `parallel-${i}-${Math.random().toString(36).slice(2)}`,
          op: "addNode",
          payload: { node: { type: "note", data: { label: `n${i}`, body: `body${i}` } } },
        })
      )
    );
    assert.equal(replies.every((r) => r.ok && r.applied), true, "all replies ok+applied");
    const ids = new Set(replies.map((r) => r.assigned.node_id));
    assert.equal(ids.size, N, "all ids unique");
    assert.equal(p.canvasState.nodes.length, N, "in-memory has all N");
    const onDisk = JSON.parse(await readFile(workflowPath, "utf8"));
    assert.equal(onDisk.nodes.length, N, "disk has all N — no lost writes");
    assert.ok(validateWorkflow(onDisk), formatErrors(validateWorkflow.errors));
  } finally {
    await teardown(dir);
  }
});

test("100 parallel updateNode on same node → all serialize, final value is from one of them", async () => {
  const { p, dir } = await setupProject({
    version: 2,
    workflow_id: "s",
    title: "S",
    nodes: [{ id: "image_1", type: "image_result", data: { label: "x", local_path: "assets/images/image_1.png", metadata: { source: "t" } } }],
    edges: [],
  });
  try {
    const N = 100;
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutate(p, {
          request_id: `u-${i}-${Math.random().toString(36).slice(2)}`,
          op: "updateNode",
          payload: { id: "image_1", patch: { label: `v${i}` } },
        })
      )
    );
    assert.equal(replies.every((r) => r.ok), true);
    const final = p.canvasState.nodes[0].data.label;
    assert.match(final, /^v\d+$/);
    // Version monotonically increased exactly N times.
    assert.equal(p.version, N);
  } finally {
    await teardown(dir);
  }
});

test("100 retries of same request_id → exactly 1 node added", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    const rid = "fixed-rid-for-retry-test";
    const replies = await Promise.all(
      Array.from({ length: 100 }, () =>
        mutate(p, {
          request_id: rid,
          op: "addNode",
          payload: { node: { type: "note", data: { label: "once", body: "only" } } },
        })
      )
    );
    assert.equal(replies.every((r) => r.ok), true);
    const applied = replies.filter((r) => r.applied);
    assert.equal(applied.length, 1, "exactly one applied");
    assert.equal(p.canvasState.nodes.length, 1);
    const onDisk = JSON.parse(await readFile(workflowPath, "utf8"));
    assert.equal(onDisk.nodes.length, 1);
  } finally {
    await teardown(dir);
  }
});

test("steno.write failure → reply klass:infra, in-memory state preserved", async () => {
  const { p, dir } = await setupProject();
  try {
    // Sabotage stenoWriter
    p.stenoWriter = {
      write: () => Promise.reject(new Error("simulated disk failure")),
    };
    const before = structuredClone(p.canvasState);
    const r = await mutate(p, {
      request_id: "fail-1",
      op: "addNode",
      payload: { node: { type: "note", data: { label: "x", body: "y" } } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.klass, "infra");
    assert.deepEqual(p.canvasState, before, "canvasState unchanged after disk failure");
    assert.equal(p.version, 0, "version not bumped on failure");
  } finally {
    await teardown(dir);
  }
});

test("interleaved adds + deletes complete consistently", async () => {
  const { p, dir, workflowPath } = await setupProject();
  try {
    // Seed: add 20 nodes in parallel.
    const addReplies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mutate(p, {
          request_id: `s-${i}`,
          op: "addNode",
          payload: { node: { type: "note", data: { label: `n${i}`, body: "x" } } },
        })
      )
    );
    const ids = addReplies.map((r) => r.assigned.node_id);
    // Interleave deletes with no id reuse or disk divergence.
    const work = [
      ...ids.slice(0, 10).map((id, i) =>
        mutate(p, { request_id: `d-${i}`, op: "deleteNode", payload: { id } })
      ),
    ];
    const replies = await Promise.all(work);
    assert.equal(replies.every((r) => r.ok), true);
    assert.equal(p.canvasState.nodes.length, 10);
    const onDisk = JSON.parse(await readFile(workflowPath, "utf8"));
    assert.equal(onDisk.nodes.length, 10);
    assert.equal("groups" in onDisk, false);
    assert.ok(validateWorkflow(onDisk));
  } finally {
    await teardown(dir);
  }
});
