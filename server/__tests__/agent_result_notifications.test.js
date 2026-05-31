import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const priorProjectsDir = process.env.PAI_PROJECTS_DIR;
const projectsRoot = await mkdtemp(join(tmpdir(), "agent-result-notifications-"));
process.env.PAI_PROJECTS_DIR = projectsRoot;

const notifications = await import(`../lib/agent_result_notifications.js?test=${Date.now()}`);

test.after(async () => {
  notifications.resetAgentResultNotificationStateForTests();
  await rm(projectsRoot, { recursive: true, force: true });
  if (priorProjectsDir === undefined) delete process.env.PAI_PROJECTS_DIR;
  else process.env.PAI_PROJECTS_DIR = priorProjectsDir;
});

test.afterEach(() => {
  notifications.resetAgentResultNotificationStateForTests();
});

async function writeJson(abs, payload) {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(payload, null, 2) + "\n");
}

async function writeResult(projectId, jobId, payload) {
  await writeJson(join(projectsRoot, projectId, ".results", `${jobId}.json`), {
    job_id: jobId,
    ...payload,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("formatter includes ids, statuses, refs, and exact feed command", () => {
  const text = notifications.formatGenerationResultNotification("project_a", [
    {
      job_id: "pending_ok",
      kind: "image",
      status: "succeeded",
      ok: true,
      node_id: "image_1",
      local_path: "assets/images/image_1.png",
    },
    {
      job_id: "pending_bad",
      kind: "video",
      status: "failed",
      ok: false,
      klass: "content_filtered",
      message: "provider rejected the prompt",
    },
  ]);

  assert.match(text, /^\[task-notification\]/);
  assert.match(text, /pending_ok: image succeeded; node=image_1; local_path=assets\/images\/image_1\.png/);
  assert.match(text, /pending_bad: video failed; klass=content_filtered/);
  assert.match(
    text,
    /node "\$PAI_REPO_ROOT\/server\/cli\/list_generation_results\.js" --job-id 'pending_ok' --job-id 'pending_bad'/,
  );
});

test("enqueue is write-once by job id", async () => {
  const projectId = "project_enqueue";
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_once",
    status: "succeeded",
  });
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_once",
    status: "failed",
  });

  const records = await notifications.readAgentResultNotifications(projectId);
  assert.equal(records.length, 1);
  assert.equal(records[0].job_id, "pending_once");
  assert.equal(records[0].status, "succeeded");
  assert.equal(records[0].delivered_at, null);
});

test("flush batches undelivered records and marks them delivered once", async () => {
  const projectId = "project_flush";
  await writeResult(projectId, "pending_ok", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_2" },
    local_path: "assets/images/image_2.png",
  });
  await writeResult(projectId, "pending_bad", {
    ok: false,
    kind: "audio",
    klass: "bad_args",
    message: "missing text",
  });
  await notifications.enqueueGenerationResultNotification(projectId, { job_id: "pending_ok", status: "succeeded" });
  await notifications.enqueueGenerationResultNotification(projectId, { job_id: "pending_bad", status: "failed" });

  const calls = [];
  notifications.configureAgentResultNotifications({
    submitAgentNotification: async (id, text, opts) => {
      calls.push({ id, text, opts });
      return { ok: true };
    },
  });

  const flushed = await notifications.flushProjectNotifications(projectId);
  assert.equal(flushed.ok, true);
  assert.equal(flushed.delivered, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, projectId);
  assert.match(calls[0].text, /--job-id 'pending_ok'/);
  assert.match(calls[0].text, /--job-id 'pending_bad'/);
  assert.equal(calls[0].opts.requireIdleMs, 1500);

  const records = await notifications.readAgentResultNotifications(projectId);
  assert.equal(records.filter((r) => r.delivered_at).length, 2);

  await notifications.flushProjectNotifications(projectId);
  assert.equal(calls.length, 1, "delivered records must not resend");
});

test("busy submit leaves notification undelivered", async () => {
  const projectId = "project_busy";
  await writeResult(projectId, "pending_busy", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_3" },
  });
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_busy",
    status: "succeeded",
  });
  notifications.configureAgentResultNotifications({
    retryDelaysMs: {},
    submitAgentNotification: async () => ({ ok: false, reason: "busy", idleForMs: 20 }),
  });

  const flushed = await notifications.flushProjectNotifications(projectId);
  assert.equal(flushed.ok, false);
  assert.equal(flushed.reason, "busy");

  const records = await notifications.readAgentResultNotifications(projectId);
  assert.equal(records.length, 1);
  assert.equal(records[0].delivered_at, null);
});

test("enqueue during an in-flight flush gets a follow-up delivery", async () => {
  const projectId = "project_inflight";
  await writeResult(projectId, "pending_first", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_first" },
  });
  await writeResult(projectId, "pending_second", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_second" },
  });

  let releaseFirst;
  const firstSubmitted = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  notifications.configureAgentResultNotifications({
    quietWindowMs: 5,
    maxBatchWaitMs: 50,
    retryDelaysMs: {},
    submitAgentNotification: async (_id, text) => {
      calls.push(text);
      if (calls.length === 1) await firstSubmitted;
      return { ok: true };
    },
  });

  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_first",
    status: "succeeded",
  });
  while (calls.length === 0) await sleep(5);

  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_second",
    status: "succeeded",
  });
  await sleep(15);
  releaseFirst();

  const deadline = Date.now() + 1000;
  while (calls.length < 2 && Date.now() < deadline) await sleep(10);

  assert.equal(calls.length, 2);
  assert.match(calls[0], /--job-id 'pending_first'/);
  assert.doesNotMatch(calls[0], /pending_second/);
  assert.match(calls[1], /--job-id 'pending_second'/);

  const records = await notifications.readAgentResultNotifications(projectId);
  assert.equal(records.filter((r) => r.delivered_at).length, 2);
});

test("enqueue uses a trailing quiet window", async () => {
  const projectId = "project_quiet_window";
  await writeResult(projectId, "pending_first", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_first" },
  });
  await writeResult(projectId, "pending_second", {
    ok: true,
    kind: "image",
    canvas_mutation: { node_id: "image_second" },
  });

  const calls = [];
  notifications.configureAgentResultNotifications({
    quietWindowMs: 40,
    maxBatchWaitMs: 200,
    retryDelaysMs: {},
    submitAgentNotification: async (_id, text) => {
      calls.push(text);
      return { ok: true };
    },
  });

  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_first",
    status: "succeeded",
  });
  await sleep(25);
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_second",
    status: "succeeded",
  });
  await sleep(25);
  assert.equal(calls.length, 0, "second enqueue should push the quiet timer back");

  const deadline = Date.now() + 500;
  while (calls.length === 0 && Date.now() < deadline) await sleep(10);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--job-id 'pending_first'/);
  assert.match(calls[0], /--job-id 'pending_second'/);
});

test("quiet window is capped by max batch wait", async () => {
  const projectId = "project_max_wait";
  for (const jobId of ["pending_first", "pending_second", "pending_third"]) {
    await writeResult(projectId, jobId, {
      ok: true,
      kind: "image",
      canvas_mutation: { node_id: jobId.replace("pending_", "image_") },
    });
  }

  const calls = [];
  notifications.configureAgentResultNotifications({
    quietWindowMs: 40,
    maxBatchWaitMs: 70,
    retryDelaysMs: {},
    submitAgentNotification: async (_id, text) => {
      calls.push({ text, at: Date.now() });
      return { ok: true };
    },
  });

  const startedAt = Date.now();
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_first",
    status: "succeeded",
  });
  await sleep(30);
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_second",
    status: "succeeded",
  });
  await sleep(30);
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_third",
    status: "succeeded",
  });

  const deadline = Date.now() + 500;
  while (calls.length === 0 && Date.now() < deadline) await sleep(10);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].at - startedAt < 120, "max wait should prevent unbounded quiet-window extension");
  assert.match(calls[0].text, /--job-id 'pending_first'/);
  assert.match(calls[0].text, /--job-id 'pending_second'/);
  assert.match(calls[0].text, /--job-id 'pending_third'/);
});

test("flush without a pty submitter keeps outbox pending", async () => {
  const projectId = "project_no_submitter";
  await notifications.enqueueGenerationResultNotification(projectId, {
    job_id: "pending_waiting",
    status: "failed",
  });

  const flushed = await notifications.flushProjectNotifications(projectId);
  assert.equal(flushed.ok, false);
  assert.equal(flushed.reason, "no_submitter");
});
