import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAIT_CLI = resolve(__dirname, "..", "cli", "wait_for_generation.js");

function runWait({ cwd, jobId, env = {} }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [WAIT_CLI, jobId],
      { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

test("wait_for_generation prints existing success result and exits 0", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "wait-generation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".results"), { recursive: true });
  await writeFile(
    join(cwd, ".results", "pending_ok.json"),
    JSON.stringify({ ok: true, job_id: "pending_ok", kind: "image", output_url: "/x.png" }) + "\n",
  );

  const { code, stdout, stderr } = await runWait({ cwd, jobId: "pending_ok" });
  assert.equal(code, 0, stderr);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.job_id, "pending_ok");
  assert.equal(reply.output_url, "/x.png");
});

test("wait_for_generation prints existing failure result and exits 1", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "wait-generation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".results"), { recursive: true });
  await writeFile(
    join(cwd, ".results", "pending_fail.json"),
    JSON.stringify({ ok: false, job_id: "pending_fail", kind: "image", klass: "bad_args", message: "nope" }) + "\n",
  );

  const { code, stdout, stderr } = await runWait({ cwd, jobId: "pending_fail" });
  assert.equal(code, 1, stderr);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
});

test("wait_for_generation times out with structured failure", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "wait-generation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runWait({
    cwd,
    jobId: "pending_missing",
    env: { PAI_WAIT_TIMEOUT_MS: "30" },
  });
  assert.equal(code, 1, stderr);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.job_id, "pending_missing");
  assert.equal(reply.klass, "timeout");
});
