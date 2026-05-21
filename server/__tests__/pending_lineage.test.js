// Phase 4 — pending sidecar parity (Lever A).
//
// The pending pad's dashed edges must match the solid edges the final
// node will end up with. We capture `source_node_id` and
// `reference_source_ids` at writePending time so the projection has
// everything it needs to draw the wiring before the CLI finishes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "scripts");

function runCli({ script, args, cwd, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(SCRIPTS_DIR, script), ...args],
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

async function setupCwd() {
  const dir = await mkdtemp(join(tmpdir(), "pending-lineage-"));
  await mkdir(join(dir, ".pending"), { recursive: true });
  return dir;
}

async function readSidecar(cwd, jobId) {
  return JSON.parse(await readFile(join(cwd, ".pending", `${jobId}.json`), "utf8"));
}

// ── sidecar capture (integration via --stage) ───────────────────────

test("generate_image.js --stage captures source_node_id + reference_source_ids", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage", "--prompt", "x",
      "--source-node-id", "note_5",
      "--ref-source-id", "image_3",
      "--ref-source-id", "image_4",
    ],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.source_node_id, "note_5");
  assert.deepEqual(sidecar.reference_source_ids, ["image_3", "image_4"]);
});

test("generate_video.js --stage captures source_node_id + merged refs (audio included)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: [
      "--stage", "--prompt", "x",
      "--source-node-id", "note_2",
      "--ref-source-id", "image_3",
      "--ref-audio-source-id", "audio_7",
    ],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.source_node_id, "note_2");
  assert.deepEqual(sidecar.reference_source_ids, ["image_3", "audio_7"]);
});

test("generate_voice.js --stage source_node_id lives in its own field", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_voice.js",
    args: [
      "--stage",
      "--text", "Hello there.",
      "--prompt", "Calm tenor.",
      "--source-node-id", "image_1",
    ],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.source_node_id, "image_1");
  // Voice's source_node_id used to be stuffed into reference_source_ids
  // (a pre-Lever-A hack). Lives in its own field now; refs is empty
  // because voice has no --ref-source-id flag.
  assert.deepEqual(sidecar.reference_source_ids, []);
});

// ── writePending unit (covers the running-branch sidecar shape) ─────

import { writePending } from "../scripts/_pending.js";

test("writePending persists source_node_id + reference_source_ids", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(originalCwd));

  await writePending({
    jobId: "test_job_1",
    kind: "image",
    prompt: "x",
    sourceNodeId: "note_5",
    referenceSourceIds: ["image_3", "image_4"],
    model: "image-generation",
  });

  const sidecar = JSON.parse(
    await readFile(join(cwd, ".pending", "test_job_1.json"), "utf8"),
  );
  assert.strictEqual(sidecar.source_node_id, "note_5");
  assert.deepEqual(sidecar.reference_source_ids, ["image_3", "image_4"]);
  assert.strictEqual(sidecar.stage, "running");
});

test("writePending sticky-preserves source_node_id across draft → running", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(originalCwd));

  await writePending({
    jobId: "test_job_2",
    kind: "image",
    prompt: "x",
    stage: "draft",
    sourceNodeId: "note_99",
    referenceSourceIds: ["image_1"],
    model: "image-generation",
  });

  // Running call re-writes without re-passing sourceNodeId — sticky
  // preservation pulls it from the prior sidecar.
  await writePending({
    jobId: "test_job_2",
    kind: "image",
    prompt: "x",
    model: "image-generation",
  });

  const sidecar = JSON.parse(
    await readFile(join(cwd, ".pending", "test_job_2.json"), "utf8"),
  );
  assert.strictEqual(sidecar.source_node_id, "note_99");
  assert.deepEqual(sidecar.reference_source_ids, ["image_1"]);
  assert.strictEqual(sidecar.stage, "running");
});
