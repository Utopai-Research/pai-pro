// End-to-end tests for the --stage draft gate.
//
// With --stage, generate_*.js writes a captured-argv
// `.pending/<jobId>.json` draft with a price snapshot, then waits for a
// terminal `.results/<jobId>.json` review result.
//
// We spawn the CLI as a subprocess with cwd set to a tmp dir so the
// sidecar lands under a controlled tree, independent of the user's real
// .active_project. No API keys are needed — the --stage branch exits
// after the test harness writes the result sidecar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

async function writeTerminalResult(cwd, staged, result = {}) {
  await mkdir(join(cwd, ".results"), { recursive: true });
  const target = join(cwd, ".results", `${staged.job_id}.json`);
  const body = JSON.stringify({
    ok: true,
    job_id: staged.job_id,
    model: staged.model,
    cost_usd: staged.cost_usd,
    ...result,
  }) + "\n";
  // Atomic write (tmp + rename) — see note in generate_url_removal.test.js:
  // the staged CLI polls this sidecar with JSON.parse, so a bare writeFile's
  // truncate-to-0 window makes a poll parse "" -> terminal ok:false -> exit 1.
  await writeFile(`${target}.tmp`, body);
  await rename(`${target}.tmp`, target);
}

function parseJsonLines(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
}

function stagedReply(stdout) {
  return parseJsonLines(stdout).find((r) => r.stage === "draft");
}

function runCli({ script, args, cwd, resolveStage = true }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const resolved = new Set();
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, script), ...args],
      { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!resolveStage) return;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed?.stage !== "draft" || typeof parsed.job_id !== "string") continue;
        if (resolved.has(parsed.job_id)) continue;
        resolved.add(parsed.job_id);
        writeTerminalResult(cwd, parsed).catch((e) => {
          stderr += `\n[test harness result write failed: ${e.message}]`;
          try { child.kill("SIGTERM"); } catch {}
        });
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function setupCwd() {
  const dir = await mkdtemp(join(tmpdir(), "pending-stage-"));
  await mkdir(join(dir, ".pending"), { recursive: true });
  await mkdir(join(dir, ".results"), { recursive: true });
  return dir;
}

// CLIs emit one `{...}` line on stdout; take the last one in case dotenv
// or a provider client surfaces a warning.
function parseReply(stdout) {
  const replies = parseJsonLines(stdout);
  return replies[replies.length - 1];
}

async function readSidecar(cwd, jobId) {
  return JSON.parse(await readFile(join(cwd, ".pending", `${jobId}.json`), "utf8"));
}

test("generate_image.js --stage writes a draft sidecar then exits after result", async (t) => {
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

  const reply = stagedReply(stdout);
  assert.ok(reply);
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

test("generate_image.js --stage --draft-only exits after writing the draft", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--stage",
      "--draft-only",
      "--prompt", "batch cat",
      "--aspect-ratio", "1:1",
      "--image-size", "1K",
    ],
    cwd,
    resolveStage: false,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const replies = parseJsonLines(stdout);
  assert.strictEqual(replies.length, 1);
  const reply = replies[0];
  assert.strictEqual(reply.stage, "draft");
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.prompt, "batch cat");
  assert.ok(!sidecar.argv.includes("--stage"));
  assert.ok(!sidecar.argv.includes("--draft-only"));
});

test("generate_image_pro.js --stage --draft-only writes a draft sidecar", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_image_pro.js",
    args: [
      "--stage",
      "--draft-only",
      "--prompt", "a crisp storyboard frame",
      "--size", "1024x1024",
      "--ref-source-id", "image_42",
    ],
    cwd,
    resolveStage: false,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);

  const reply = stagedReply(stdout);
  assert.ok(reply);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.stage, "draft");
  assert.strictEqual(reply.model, "image-generation-pro");
  assert.ok(reply.cost_usd > 0);

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.stage, "draft");
  assert.strictEqual(sidecar.kind, "image");
  assert.strictEqual(sidecar.prompt, "a crisp storyboard frame");
  assert.strictEqual(sidecar.script, "generate_image_pro.js");
  assert.strictEqual(sidecar.model, "image-generation-pro");
  assert.strictEqual(sidecar.size, "1024x1024");
  assert.strictEqual(sidecar.image_size, "1K");
  assert.strictEqual(sidecar.aspect_ratio, "1:1");
  assert.deepEqual(sidecar.reference_source_ids, ["image_42"]);
  assert.ok(Array.isArray(sidecar.argv));
  assert.ok(!sidecar.argv.includes("--stage"));
  assert.ok(sidecar.argv.includes("--size"));
  assert.ok(sidecar.argv.includes("1024x1024"));
});

test("generate_video.js --stage --draft-only defaults to 720p in the sidecar", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_video.js",
    args: [
      "--stage",
      "--draft-only",
      "--prompt", "wide-angle desert at golden hour",
      "--duration", "10",
    ],
    cwd,
    resolveStage: false,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const reply = stagedReply(stdout);
  assert.ok(reply);
  assert.strictEqual(reply.stage, "draft");
  assert.ok(reply.cost_usd > 0);

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.kind, "video");
  assert.strictEqual(sidecar.script, "generate_video.js");
  assert.strictEqual(sidecar.resolution, "720p");
  assert.strictEqual(sidecar.duration, 10);
});

test("generate_voice.js --stage --draft-only writes a draft sidecar", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli({
    script: "generate_voice.js",
    args: [
      "--stage",
      "--draft-only",
      "--text", "I've been working this beat for twenty years.",
      "--prompt", "Mid-50s man, gravelly baritone, measured pace.",
    ],
    cwd,
    resolveStage: false,
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const reply = stagedReply(stdout);
  assert.ok(reply);
  assert.strictEqual(reply.stage, "draft");

  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.strictEqual(sidecar.kind, "audio");
  assert.strictEqual(sidecar.script, "generate_voice.js");
  assert.strictEqual(sidecar.text, "I've been working this beat for twenty years.");
});

test("generate_voice.js --stage fails when draft sidecar cannot be written", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await rm(join(cwd, ".pending"), { recursive: true, force: true });
  await writeFile(join(cwd, ".pending"), "not a directory");

  const { code, stdout } = await runCli({
    script: "generate_voice.js",
    args: [
      "--stage",
      "--draft-only",
      "--text", "This should not stage.",
      "--prompt", "Neutral voice.",
    ],
    cwd,
    resolveStage: false,
  });

  assert.strictEqual(code, 1);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "infra");
  assert.match(reply.message, /draft sidecar/);
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

test("generate_image_pro.js rejects unsupported provider sizing flags", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  for (const flag of ["--aspect-ratio", "--image-size"]) {
    const { code, stdout } = await runCli({
      script: "generate_image_pro.js",
      args: ["--stage", "--prompt", "x", flag, "16:9"],
      cwd,
    });
    assert.strictEqual(code, 2);
    const reply = parseReply(stdout);
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.klass, "bad_args");
    assert.match(reply.message, /argv|unknown option/i);
  }
});

test("generate_image_pro.js rejects unsupported exact size", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout } = await runCli({
    script: "generate_image_pro.js",
    args: ["--stage", "--prompt", "x", "--size", "1920x1080"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /unsupported --size/);
});

// --- isBypassEnabled + writePending -------------------------------------

import {
  defaultWaitTimeoutMsForKind,
  isBypassEnabled,
  writePending,
} from "../cli/_pending.js";

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
      "--stage", "--draft-only", "--prompt", "x",
      "--source-node-id", "note_5",
      "--ref-source-id", "image_3",
      "--ref-source-id", "image_4",
    ],
    cwd,
    resolveStage: false,
  });
  assert.strictEqual(code, 0);
  const reply = stagedReply(stdout);
  assert.ok(reply);
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
      "--draft-only",
      "--source-node-id", "note_2",
      "--ref-source-id", "image_3",
      "--ref-audio-source-id", "audio_7",
    ],
    cwd,
    resolveStage: false,
  });
  assert.strictEqual(code, 0);
  const reply = stagedReply(stdout);
  assert.ok(reply);
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
      "--draft-only",
      "--text", "Hello there.",
      "--prompt", "Calm tenor.",
      "--source-node-id", "image_1",
    ],
    cwd,
    resolveStage: false,
  });
  assert.strictEqual(code, 0);
  const reply = stagedReply(stdout);
  assert.ok(reply);
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

  assert.strictEqual(await writePending({
    jobId: "test_job_1",
    kind: "image",
    prompt: "x",
    sourceNodeId: "note_5",
    referenceSourceIds: ["image_3", "image_4"],
    model: "image-generation",
  }), true);

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

  assert.strictEqual(await writePending({
    jobId: "test_job_2",
    kind: "image",
    prompt: "x",
    stage: "draft",
    sourceNodeId: "note_99",
    referenceSourceIds: ["image_1"],
    model: "image-generation",
  }), true);

  // Running call re-writes without re-passing sourceNodeId — sticky
  // preservation pulls it from the prior sidecar.
  assert.strictEqual(await writePending({
    jobId: "test_job_2",
    kind: "image",
    prompt: "x",
    model: "image-generation",
  }), true);

  const sidecar = await readSidecar(cwd, "test_job_2");
  assert.strictEqual(sidecar.source_node_id, "note_99");
  assert.deepEqual(sidecar.reference_source_ids, ["image_1"]);
  assert.strictEqual(sidecar.stage, "running");
});

test("writePending returns false when the pending path cannot be written", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await rm(join(cwd, ".pending"), { recursive: true, force: true });
  await writeFile(join(cwd, ".pending"), "not a directory");
  const originalCwd = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(originalCwd));

  const wrote = await writePending({
    jobId: "test_job_3",
    kind: "image",
    prompt: "x",
    model: "image-generation",
  });

  assert.strictEqual(wrote, false);
});

// --- running-flow smoke (regression: catches stray refs in the
// non-stage branch that --stage tests don't exercise) -----------------

test("generate_image.js running flow emits structured failure (no stray refs)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--prompt", "x",
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
  const { code, stdout, stderr } = await runCli({
    script: "generate_video.js",
    args: [
      "--prompt", "x",
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
