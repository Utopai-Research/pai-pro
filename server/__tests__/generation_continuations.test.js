import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const priorProjectsDir = process.env.PAI_PROJECTS_DIR;
const projectsRoot = await mkdtemp(join(tmpdir(), "generation-continuations-"));
process.env.PAI_PROJECTS_DIR = projectsRoot;

const events = await import(`../lib/continuation_events.js?test=${Date.now()}`);
const continuations = await import(`../lib/generation_continuations.js?test=${Date.now()}`);

test.after(async () => {
  continuations.resetGenerationContinuationStateForTests();
  await rm(projectsRoot, { recursive: true, force: true });
  if (priorProjectsDir === undefined) delete process.env.PAI_PROJECTS_DIR;
  else process.env.PAI_PROJECTS_DIR = priorProjectsDir;
});

test.afterEach(() => {
  continuations.resetGenerationContinuationStateForTests();
});

async function writeJson(abs, payload) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(payload, null, 2) + "\n");
}

async function setupProject(projectId, { agentId = "claude" } = {}) {
  const dir = join(projectsRoot, projectId);
  await mkdir(join(dir, ".results"), { recursive: true });
  const now = new Date().toISOString();
  const workflow = {
    version: 2,
    workflow_id: projectId,
    title: "Test",
    nodes: [{
      id: "image_1",
      type: "image_result",
      data: {
        label: "Character",
        local_path: "assets/images/image_1.png",
        prompt: "hero character",
        metadata: { source: "pai", task_type: "image_generation", generated_at: now },
      },
    }],
    edges: [],
  };
  const meta = { id: projectId, title: "Test", agent_id: agentId, created_at: now, last_active_at: now };
  await writeJson(join(dir, "workflow.json"), workflow);
  await writeJson(join(dir, "meta.json"), meta);
  return {
    dir,
    project: {
      id: projectId,
      meta,
      canvasState: workflow,
      agentContinuations: new Map(),
    },
  };
}

async function writeResult(projectId, jobId, payload) {
  await writeJson(join(projectsRoot, projectId, ".results", `${jobId}.json`), {
    job_id: jobId,
    ...payload,
  });
}

async function readEvent(projectId, eventId) {
  return JSON.parse(
    await readFile(join(projectsRoot, projectId, ".continuation_events", `${eventId}.json`), "utf8"),
  );
}

function assertStrictObjectRequired(schema, path = "schema") {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(schema.properties).sort(),
      `${path}.required must include every property for Codex structured output`,
    );
  }
  if (schema.type === "array") assertStrictObjectRequired(schema.items, `${path}.items`);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[key])) continue;
    schema[key].forEach((entry, idx) => assertStrictObjectRequired(entry, `${path}.${key}[${idx}]`));
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    assertStrictObjectRequired(value, `${path}.properties.${key}`);
  }
}

test("continuation schema satisfies Codex strict object required rules", () => {
  assertStrictObjectRequired(continuations.CONTINUATION_SCHEMA);
});

test("continuation event enqueue is write-once by job id", async () => {
  const projectId = "project_enqueue";
  await setupProject(projectId);
  await events.enqueueContinuationEvent(projectId, {
    job_id: "pending_once",
    status: "succeeded",
  });
  await events.enqueueContinuationEvent(projectId, {
    job_id: "pending_once",
    status: "failed",
  });

  const records = await events.readContinuationEvents(projectId);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "generation_result");
  assert.equal(records[0].job_id, "pending_once");
  assert.equal(records[0].status, "succeeded");
  assert.equal(records[0].consumed_at, null);
});

test("flush runs provider worker, writes continuation record, and stages draft-only follow-up", async () => {
  const projectId = "project_flush";
  const { project } = await setupProject(projectId);
  await writeResult(projectId, "pending_ok", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_1" },
    local_path: "assets/images/image_1.png",
    prompt: "hero character",
    aspect_ratio: "1:1",
  });

  const projects = new Map([[projectId, project]]);
  const broadcasts = [];
  continuations.configureGenerationContinuations({
    projects,
    enabled: false,
    broadcasters: {
      broadcastAgentContinuations: (id) => broadcasts.push(id),
    },
    workerRunner: async ({ providerId, prompt }) => {
      assert.equal(providerId, "claude");
      assert.match(prompt, /pending_ok/);
      return {
        output: {
          summary: "Image is ready; staging a 3-view turnaround draft.",
          diagnostics: [{ job_id: "pending_ok", severity: "info", message: "Generated image_1." }],
          suggested_next_steps: [{
            kind: "stage_image",
            label: "3-view character turnaround",
            prompt: "Create a front, side, and back turnaround of the same character.",
            ref_source_ids: ["image_1"],
          }],
        },
        usage: { test: true },
      };
    },
  });

  const enqueued = await continuations.enqueueGenerationContinuation(projectId, {
    job_id: "pending_ok",
    status: "succeeded",
  });
  assert.equal(enqueued.ok, true);

  const flushed = await continuations.flushProjectContinuations(projectId);
  assert.equal(flushed.ok, true);
  assert.equal(flushed.processed, 1);
  assert.equal(flushed.applied.staged_job_ids.length, 1);
  assert.ok(broadcasts.length >= 2, "running and applied records should broadcast");

  const recordFiles = await readdir(join(projectsRoot, projectId, ".agent_continuations"));
  assert.equal(recordFiles.length, 1);
  const record = JSON.parse(
    await readFile(join(projectsRoot, projectId, ".agent_continuations", recordFiles[0]), "utf8"),
  );
  assert.equal(record.status, "applied");
  assert.equal(record.job_ids[0], "pending_ok");
  assert.equal(record.applied.staged_job_ids[0], flushed.applied.staged_job_ids[0]);

  const staged = JSON.parse(
    await readFile(join(projectsRoot, projectId, ".pending", `${flushed.applied.staged_job_ids[0]}.json`), "utf8"),
  );
  assert.equal(staged.stage, "draft");
  assert.equal(staged.script, "generate_image.js");
  assert.equal(staged.origin.kind, "agent_continuation");
  assert.deepEqual(staged.reference_source_ids, ["image_1"]);

  const event = await readEvent(projectId, "continuation_event_pending_ok");
  assert.equal(event.continuation_id, record.id);
  assert.ok(event.consumed_at);
});

test("worker failure writes failed continuation and leaves event retryable", async () => {
  const projectId = "project_failed";
  const { project } = await setupProject(projectId);
  await writeResult(projectId, "pending_bad", {
    ok: false,
    kind: "image",
    klass: "bad_args",
    message: "unsupported image size",
  });

  continuations.configureGenerationContinuations({
    projects: new Map([[projectId, project]]),
    enabled: false,
    retryDelayMs: 1000,
    workerRunner: async () => {
      const err = new Error("budget reached");
      err.reason = "budget";
      throw err;
    },
  });
  await continuations.enqueueGenerationContinuation(projectId, {
    job_id: "pending_bad",
    status: "failed",
  });

  const flushed = await continuations.flushProjectContinuations(projectId);
  assert.equal(flushed.ok, false);
  assert.equal(flushed.reason, "budget");

  const records = await readdir(join(projectsRoot, projectId, ".agent_continuations"));
  const record = JSON.parse(
    await readFile(join(projectsRoot, projectId, ".agent_continuations", records[0]), "utf8"),
  );
  assert.equal(record.status, "failed");
  assert.equal(record.error.reason, "budget");

  const event = await readEvent(projectId, "continuation_event_pending_bad");
  assert.equal(event.consumed_at, null);
  assert.equal(event.attempt_count, 1);
  assert.ok(event.next_retry_at);
});

test("invalid paid/unknown worker action is rejected", () => {
  assert.throws(
    () => continuations.normalizeContinuationOutput({
      summary: "Bad output",
      diagnostics: [],
      suggested_next_steps: [{ kind: "fire_image", prompt: "spend money now" }],
    }),
    /invalid suggested_next_steps action/,
  );
});
