// End-to-end tests for the --stage draft gate.
//
// Each generate_*.js CLI grew one flag: --stage. When set, the CLI writes
// a captured-argv `.pending/<jobId>.json` draft with a price snapshot
// and exits 0 without contacting the provider.
//
// We spawn the CLI as a subprocess with cwd set to a tmp dir so the
// sidecar lands under a controlled tree, independent of the user's real
// .active_project. No API keys are needed — the --stage branch exits
// before any provider client is invoked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

function runCli({ script, args, cwd }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, script), ...args],
      { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function setupCwd() {
  const dir = await mkdtemp(join(tmpdir(), "pending-stage-"));
  await mkdir(join(dir, ".pending"), { recursive: true });
  return dir;
}

// CLIs emit one `{...}` line on stdout; take the last one in case dotenv
// or a provider client surfaces a warning.
function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

async function readSidecar(cwd, jobId) {
  return JSON.parse(await readFile(join(cwd, ".pending", `${jobId}.json`), "utf8"));
}

test("generate_image.js --stage writes a draft sidecar and exits 0", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage",
      "--prompt", "a test cat",
      "--aspect-ratio", "1:1",
      "--image-size", "1K",
    ],
    cwd,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);

  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.stage, "draft");
  assert.match(reply.job_id, /^pending_/);
  assert.ok(reply.cost_usd > 0);

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.stage, "draft");
  assert.strictEqual(sidecar.kind, "image");
  assert.strictEqual(sidecar.prompt, "a test cat");
  assert.strictEqual(sidecar.script, "generate_image.js");
  assert.ok(Array.isArray(sidecar.argv));
  // --stage was stripped from the captured argv; user flags survived.
  assert.ok(!sidecar.argv.includes("--stage"));
  assert.ok(sidecar.argv.includes("--prompt"));
  assert.ok(sidecar.argv.includes("a test cat"));
});

test("generate_video.js --stage writes a draft sidecar and exits 0", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_video.js",
    args: [
      "--stage",
      "--prompt", "wide-angle desert at golden hour",
      "--duration", "10",
      "--resolution", "1080p",
    ],
    cwd,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.stage, "draft");
  assert.ok(reply.cost_usd > 0);

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.kind, "video");
  assert.strictEqual(sidecar.script, "generate_video.js");
  assert.strictEqual(sidecar.resolution, "1080p");
  assert.strictEqual(sidecar.duration, 10);
});

test("generate_voice.js --stage writes a draft sidecar and exits 0", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_voice.js",
    args: [
      "--stage",
      "--text", "I've been working this beat for twenty years.",
      "--prompt", "Mid-50s man, gravelly baritone, measured pace.",
    ],
    cwd,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.stage, "draft");

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.kind, "audio");
  assert.strictEqual(sidecar.script, "generate_voice.js");
  assert.strictEqual(sidecar.text, "I've been working this beat for twenty years.");
});

test("generate_image.js --stage without --prompt fails bad_args", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout } = await runCli({
    script: "generate_image.js",
    args: ["--stage", "--aspect-ratio", "1:1"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
});

// --- isBypassEnabled + writePending -------------------------------------

import {
  defaultWaitTimeoutMsForKind,
  isBypassEnabled,
  writePending,
} from "../cli/_pending.js";
import { writeFile } from "node:fs/promises";

test("isBypassEnabled true when meta.json has dangerously_skip_draft_gate=true", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "meta.json"),
    JSON.stringify({ id: "x", title: "x", dangerously_skip_draft_gate: true }),
  );
  assert.strictEqual(await isBypassEnabled(cwd), true);
});

test("isBypassEnabled false when flag missing, false, or meta absent", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // No meta.json at all → false.
  assert.strictEqual(await isBypassEnabled(cwd), false);
  // meta.json without the flag → false.
  await writeFile(join(cwd, "meta.json"), JSON.stringify({ id: "x", title: "x" }));
  assert.strictEqual(await isBypassEnabled(cwd), false);
  // Flag explicitly false → false.
  await writeFile(
    join(cwd, "meta.json"),
    JSON.stringify({ id: "x", title: "x", dangerously_skip_draft_gate: false }),
  );
  assert.strictEqual(await isBypassEnabled(cwd), false);
});

test("default wait timeout is longer for video", () => {
  assert.equal(defaultWaitTimeoutMsForKind("image"), 10 * 60 * 1000);
  assert.equal(defaultWaitTimeoutMsForKind("audio"), 10 * 60 * 1000);
  assert.equal(defaultWaitTimeoutMsForKind("video"), 35 * 60 * 1000);
});

// --- sidecar lineage capture (source_node_id + reference_source_ids) ---
//
// The pending pad's dashed edges must match the solid edges the final
// node will end up with. Both fields are captured at writePending time
// so the projection has everything it needs to draw the wiring before
// the CLI finishes.

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
  // Voice's source_node_id lives in its own field — refs is empty
  // because voice has no --ref-source-id flag.
  assert.deepEqual(sidecar.reference_source_ids, []);
});

// --- writePending unit (covers the running-branch sidecar shape) -------

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

  const sidecar = await readSidecar(cwd, "test_job_1");
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

  const sidecar = await readSidecar(cwd, "test_job_2");
  assert.strictEqual(sidecar.source_node_id, "note_99");
  assert.deepEqual(sidecar.reference_source_ids, ["image_1"]);
  assert.strictEqual(sidecar.stage, "running");
});

// --- running-flow smoke (regression: catches stray refs in the
// non-stage branch that --stage tests don't exercise) -----------------

async function enableBypass(cwd) {
  await writeFile(
    join(cwd, "meta.json"),
    JSON.stringify({ id: "x", title: "x", dangerously_skip_draft_gate: true }),
  );
}

test("generate_image.js running flow emits structured failure (no stray refs)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await enableBypass(cwd);
  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage", "--prompt", "x",
      "--ref-source-id", "image_nonexistent",
      "--project-id", "nonexistent_project_for_test_image",
    ],
    cwd,
  });
  // Must emit a JSON line on stdout — proves the running-branch
  // writePending executed without throwing (e.g. ReferenceError on a
  // stale symbol from a half-applied refactor).
  assert.strictEqual(code, 1, `expected exit 1; stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /local_path/);

  // A direct/bypass run persists its own durable result so the feed sees
  // generations the agent fired without staging through the viewer route.
  // job_id is stamped at the write site (like the fire route does), not in
  // the failure stdout, so verify the record by scanning .results/.
  const resultFiles = await readdir(join(cwd, ".results"));
  assert.strictEqual(resultFiles.length, 1, "one durable result written");
  const result = JSON.parse(
    await readFile(join(cwd, ".results", resultFiles[0]), "utf8"),
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.job_id, /^pending_/);
  assert.strictEqual(result.kind, "image");
  assert.strictEqual(result.klass, "bad_args");
});

test("generate_video.js running flow emits structured failure (no stray refs)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await enableBypass(cwd);
  const { code, stdout, stderr } = await runCli({
    script: "generate_video.js",
    args: [
      "--stage", "--prompt", "x",
      "--ref-source-id", "video_nonexistent",
      "--project-id", "nonexistent_project_for_test_video",
    ],
    cwd,
  });
  assert.strictEqual(code, 2, `expected exit 2 (bad_args); stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
});
