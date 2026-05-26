import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PROJECT_ID = "recover_project";

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value) + "\n");
}

test("recoverPendingResults resolves running pending sidecars on boot", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "recover-orphans-"));
  t.after(() => rm(projectsDir, { recursive: true, force: true }));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(() => {
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;

  const projectDir = join(projectsDir, TEST_PROJECT_ID);
  const pendingDir = join(projectDir, ".pending");
  const resultsDir = join(projectDir, ".results");
  await mkdir(pendingDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  await writeJson(join(pendingDir, "pending_draft.json"), {
    id: "pending_draft",
    stage: "draft",
    kind: "image",
    prompt: "draft",
  });
  await writeJson(join(pendingDir, "pending_running.json"), {
    id: "pending_running",
    stage: "running",
    kind: "video",
    prompt: "running",
  });
  await writeJson(join(pendingDir, "pending_done.json"), {
    id: "pending_done",
    stage: "running",
    kind: "image",
    prompt: "done",
  });
  await writeJson(join(resultsDir, "pending_done.json"), {
    ok: true,
    job_id: "pending_done",
    kind: "image",
    output_url: "/done.png",
  });

  const { recoverPendingResults } = await import(`../services/projects.js?recover=${Date.now()}`);
  await recoverPendingResults(TEST_PROJECT_ID);

  await stat(join(pendingDir, "pending_draft.json"));
  await assert.rejects(stat(join(pendingDir, "pending_running.json")), /ENOENT/);
  await assert.rejects(stat(join(pendingDir, "pending_done.json")), /ENOENT/);

  const aborted = JSON.parse(await readFile(join(resultsDir, "pending_running.json"), "utf8"));
  assert.equal(aborted.ok, false);
  assert.equal(aborted.kind, "video");
  assert.equal(aborted.klass, "aborted");
  assert.equal(aborted.message, "viewer restart");
  assert.ok(aborted.completed_at);

  const existing = JSON.parse(await readFile(join(resultsDir, "pending_done.json"), "utf8"));
  assert.equal(existing.ok, true);
  assert.equal(existing.output_url, "/done.png");

  const { writeResult } = await import("../lib/writers.js");
  const first = await writeResult(TEST_PROJECT_ID, "pending_once", {
    ok: false,
    kind: "image",
    klass: "infra",
    message: "first",
  });
  const second = await writeResult(TEST_PROJECT_ID, "pending_once", {
    ok: true,
    kind: "image",
    output_url: "/second.png",
  });

  assert.equal(first, true);
  assert.equal(second, false);
  const result = JSON.parse(
    await readFile(join(projectsDir, TEST_PROJECT_ID, ".results", "pending_once.json"), "utf8"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, "first");
  assert.equal(result.output_url, undefined);
});
