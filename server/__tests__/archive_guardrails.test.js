// CLI-side guardrails for archived nodes.
//
// Two chokepoints, two tests — covers all four generation CLIs (image,
// video, voice, split) since every one routes through one or
// both helpers.
//
// The helpers read workflow.json from <repo>/projects/<id>/, so each test
// stages a fake project directory under that path with a single archived
// image node, runs the assertion, and cleans up in finally.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderRefs, readNodeArchived } from "../local_mirror.js";
import { postNodeAddBatch } from "../cli/_mutate_helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PROJECTS_DIR = join(REPO_ROOT, "projects");

async function setupArchivedProject(projectId) {
  const projectDir = join(PROJECTS_DIR, projectId);
  await mkdir(projectDir, { recursive: true });
  const workflowPath = join(projectDir, "workflow.json");
  const wf = {
    version: 2,
    workflow_id: projectId,
    title: "Archive guardrail fixture",
    nodes: [
      {
        id: "image_1",
        type: "image_result",
        data: {
          label: "archived",
          image_url: "http://example.invalid/image_1.png",
          local_path: "assets/images/image_1.png",
          prompt: "p",
          archived: true,
          metadata: { source: "test" },
        },
      },
    ],
    edges: [],
  };
  await writeFile(workflowPath, JSON.stringify(wf, null, 2) + "\n", "utf8");
  return projectDir;
}

async function teardown(projectDir) {
  await rm(projectDir, { recursive: true, force: true });
}

// --------------------------------------------------------------------- //

test("readNodeArchived: true for archived node, false for live + missing", async () => {
  const projectId = `test_archive_guard_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await setupArchivedProject(projectId);
  try {
    assert.equal(await readNodeArchived({ nodeId: "image_1", projectId }), true);
    assert.equal(await readNodeArchived({ nodeId: "image_999", projectId }), false, "missing → false");
    assert.equal(await readNodeArchived({ nodeId: "", projectId }), false, "empty id → false");
    assert.equal(await readNodeArchived({ nodeId: "image_1", projectId: "nonexistent_proj" }), false, "missing project → false");
  } finally {
    await teardown(projectDir);
  }
});

test("buildProviderRefs: throws bad_args when --ref-source-id is archived", async () => {
  const projectId = `test_archive_guard_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await setupArchivedProject(projectId);
  try {
    await assert.rejects(
      () => buildProviderRefs({ urls: [], sourceIds: ["image_1"], projectId }),
      (err) => {
        assert.equal(err.klass, "bad_args");
        assert.match(err.message, /archived/i);
        assert.match(err.message, /image_1/);
        return true;
      },
    );
  } finally {
    await teardown(projectDir);
  }
});

test("postNodeAddBatch: returns canvas_mutation_error when --source-node-id is archived", async () => {
  const projectId = `test_archive_guard_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await setupArchivedProject(projectId);
  try {
    // The archived-check short-circuits before postMutation is called,
    // so this test doesn't need the viewer running.
    const result = await postNodeAddBatch({
      args: {
        "source-node-id": "image_1",
        "project-id": projectId,
        "request-id": "test-archived-source",
      },
      type: "image_result",
      data: {
        label: "new",
        image_url: "http://example.invalid/new.png",
        metadata: { source: "test" },
      },
      actor: "test",
    });
    assert.ok(result, "returns a result object");
    assert.ok(result.canvas_mutation_error, "returns canvas_mutation_error");
    assert.equal(result.canvas_mutation_error.klass, "bad_args");
    assert.match(result.canvas_mutation_error.message, /archived/i);
    assert.match(result.canvas_mutation_error.message, /image_1/);
    assert.equal(result.canvas_mutation_error.request_id, "test-archived-source");
  } finally {
    await teardown(projectDir);
  }
});

test("postNodeAddBatch: no-canvas-write short-circuits before archived check", async () => {
  const projectId = `test_archive_guard_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await setupArchivedProject(projectId);
  try {
    const result = await postNodeAddBatch({
      args: {
        "no-canvas-write": true,
        "source-node-id": "image_1",
        "project-id": projectId,
      },
      type: "image_result",
      data: { label: "x", image_url: "http://example.invalid/x.png", metadata: {} },
      actor: "test",
    });
    assert.equal(result, null, "no-canvas-write returns null without any checks");
  } finally {
    await teardown(projectDir);
  }
});
