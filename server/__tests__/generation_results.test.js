import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIST_CLI = resolve(__dirname, "..", "cli", "list_generation_results.js");

const projectsRoot = await mkdtemp(join(tmpdir(), "generation-results-"));
process.env.PAI_PROJECTS_DIR = projectsRoot;
const readers = await import(`../lib/readers.js?generation=${Date.now()}`);

test.after(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
});

async function setupProject(id) {
  const dir = join(projectsRoot, id);
  await mkdir(join(dir, ".results"), { recursive: true });
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: id }, null, 2) + "\n",
  );
  return dir;
}

async function writeResultFile(projectId, jobId, payload) {
  await writeFile(
    join(projectsRoot, projectId, ".results", `${jobId}.json`),
    JSON.stringify({ job_id: jobId, ...payload }) + "\n",
  );
}

function runList({ cwd, args }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [LIST_CLI, ...args], {
      cwd,
      env: { ...process.env, PAI_PROJECTS_DIR: projectsRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

test("readResultDir returns newest-first compact summaries", async () => {
  const id = "reader_summaries";
  await setupProject(id);
  await writeResultFile(id, "pending_old", {
    ok: true,
    kind: "image",
    completed_at: "2026-01-01T00:00:00.000Z",
    output_url: "/old.png",
    local_path: "assets/images/image_1.png",
    canvas_mutation: { node_id: "image_1" },
    raw_response: { large: "provider payload should not leak" },
  });
  await writeResultFile(id, "pending_new", {
    ok: false,
    kind: "video",
    klass: "aborted",
    message: "viewer restart",
    completed_at: "2026-01-02T00:00:00.000Z",
  });

  const results = await readers.readResultDir(id, { limit: 10 });
  assert.deepEqual(results.map((r) => r.job_id), ["pending_new", "pending_old"]);
  assert.equal(results[0].status, "aborted");
  assert.equal(results[1].status, "succeeded");
  assert.equal(results[1].node_id, "image_1");
  assert.equal(results[1].raw_response, undefined);
});

test("readResultDir filters failures, since, and exact job ids", async () => {
  const id = "reader_filters";
  await setupProject(id);
  await writeResultFile(id, "pending_ok", {
    ok: true,
    kind: "image",
    completed_at: "2026-02-01T00:00:00.000Z",
  });
  await writeResultFile(id, "pending_bad", {
    ok: false,
    kind: "image",
    klass: "bad_args",
    message: "bad ref",
    completed_at: "2026-02-02T00:00:00.000Z",
    sent: { ref_source_ids: ["image_1"] },
  });
  await writeResultFile(id, "pending_timeout", {
    ok: false,
    kind: "video",
    klass: "timeout",
    message: "too slow",
    completed_at: "2026-02-03T00:00:00.000Z",
  });

  const failed = await readers.readResultDir(id, { failedOnly: true });
  assert.deepEqual(failed.map((r) => r.job_id), ["pending_timeout", "pending_bad"]);
  assert.equal(failed[0].status, "timeout");
  assert.deepEqual(failed[1].sent, { ref_source_ids: ["image_1"] });

  const since = await readers.readResultDir(id, { since: "2026-02-02T12:00:00.000Z" });
  assert.deepEqual(since.map((r) => r.job_id), ["pending_timeout"]);

  const exact = await readers.readResultDir(id, { jobIds: ["pending_bad", "missing"] });
  assert.deepEqual(exact.map((r) => r.job_id), ["pending_bad"]);
});

test("list_generation_results lists recent and reports missing ids", async () => {
  const id = "cli_list";
  const cwd = await setupProject(id);
  await writeResultFile(id, "pending_a", {
    ok: true,
    kind: "image",
    completed_at: "2026-03-01T00:00:00.000Z",
  });
  await writeResultFile(id, "pending_b", {
    ok: false,
    kind: "image",
    klass: "bad_args",
    message: "archived ref",
    completed_at: "2026-03-02T00:00:00.000Z",
  });

  const recent = await runList({ cwd, args: ["--recent", "1"] });
  assert.equal(recent.code, 0, recent.stderr);
  const recentBody = parseJsonLine(recent.stdout);
  assert.equal(recentBody.ok, true);
  assert.equal(recentBody.count, 1);
  assert.equal(recentBody.results[0].job_id, "pending_b");

  const exact = await runList({
    cwd,
    args: ["--job-id", "pending_a", "--job-id", "missing"],
  });
  assert.equal(exact.code, 0, exact.stderr);
  const exactBody = parseJsonLine(exact.stdout);
  assert.equal(exactBody.count, 1);
  assert.deepEqual(exactBody.missing_job_ids, ["missing"]);
});

test("list_generation_results rejects invalid since", async () => {
  const id = "cli_bad_since";
  const cwd = await setupProject(id);
  const result = await runList({ cwd, args: ["--since", "not-a-date"] });
  assert.equal(result.code, 2);
  const body = parseJsonLine(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.klass, "bad_args");
});
