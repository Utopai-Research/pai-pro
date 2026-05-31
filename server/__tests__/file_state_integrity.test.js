import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileOnce } from "../lib/atomic_writes.js";
import { writeResultSidecar } from "../cli/_pending.js";

test("writeFileOnce preserves the first writer and removes temp artifacts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "file-state-integrity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "result.json");

  const writes = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      writeFileOnce(target, JSON.stringify({ writer: i }) + "\n"),
    ),
  );

  assert.equal(writes.filter(Boolean).length, 1);
  const parsed = JSON.parse(await readFile(target, "utf8"));
  assert.equal(typeof parsed.writer, "number");
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
});

test("writeResultSidecar uses the shared write-once result helper", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "file-state-integrity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const first = await writeResultSidecar(
    "pending_once",
    { ok: false, kind: "image", klass: "infra", message: "first" },
    { cwd },
  );
  const second = await writeResultSidecar(
    "pending_once",
    { ok: true, kind: "image", output_url: "/second.png" },
    { cwd },
  );

  assert.equal(first, true);
  assert.equal(second, false);
  const result = JSON.parse(await readFile(join(cwd, ".results", "pending_once.json"), "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.message, "first");
});

test("queued title mutations mirror the final workflow title into meta.json", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "file-state-integrity-"));
  const priorProjectsDir = process.env.PAI_PROJECTS_DIR;
  process.env.PAI_PROJECTS_DIR = projectsDir;
  t.after(() => {
    if (priorProjectsDir === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = priorProjectsDir;
  });
  t.after(() => rm(projectsDir, { recursive: true, force: true }));

  const id = "title_race";
  const dir = join(projectsDir, id);
  await mkdir(dir, { recursive: true });
  const initialWorkflow = { version: 2, workflow_id: id, title: "Initial", nodes: [], edges: [] };
  const initialMeta = { id, title: "Initial", created_at: new Date().toISOString() };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(initialWorkflow, null, 2) + "\n");
  await writeFile(join(dir, "meta.json"), JSON.stringify(initialMeta, null, 2) + "\n");

  const cacheBust = `?integrity=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { initProjectMutatorState, mutate } = await import(`../canvas_mutator.js${cacheBust}`);
  const { createBroadcasters } = await import(`../lib/broadcasters.js${cacheBust}`);

  const project = {
    id,
    meta: initialMeta,
    canvasState: initialWorkflow,
    canvasPositions: { positions: {}, groupFrames: {} },
    pendingGenerations: new Map(),
    generationResults: new Map(),
  };
  initProjectMutatorState(project, {
    workflowPath: join(dir, "workflow.json"),
    mutationLogPath: join(dir, "mutations.jsonl"),
  });
  const projects = new Map([[id, project]]);
  const io = { to: () => ({ emit: () => {} }) };
  const { mutatorHooks } = createBroadcasters({ io, projects });

  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      mutate(
        project,
        {
          request_id: `title-${i}`,
          op: "setTitle",
          payload: { title: `Title ${i}` },
          actor: "test",
        },
        mutatorHooks,
      ),
    ),
  );

  const workflow = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  assert.equal(meta.title, workflow.title);
  assert.equal(project.meta.title, workflow.title);
});
