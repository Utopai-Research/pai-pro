// CLI-side guardrails for archived nodes.
//
// Provider references are byte inputs. Archived canvas nodes are hidden
// from the working set, so CLIs must reject them before calling the
// provider.
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
