// Integration tests for the URL-passthrough removal:
//
// - The legacy --ref-image-url / --reference-{image,audio,video}-url
//   flags are gone; parseArgs (strict mode) rejects them with bad_args.
//   External URLs are mirrored onto the canvas first via mirror_url.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

function runCli({ script, args, cwd, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, script), ...args],
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
  const dir = await mkdtemp(join(tmpdir(), "url-removal-"));
  await mkdir(join(dir, ".pending"), { recursive: true });
  return dir;
}

// ── removed flags reject at argv parse time ──────────────────────────

test("generate_image.js rejects --ref-image-url (flag removed)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_image.js",
    args: ["--stage", "--prompt", "x", "--ref-image-url", "https://example.com/a.png"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /argv|--ref-image-url|unknown option/i);
});

test("generate_image_pro.js rejects --ref-image-url (flag removed)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_image_pro.js",
    args: ["--stage", "--prompt", "x", "--ref-image-url", "https://example.com/a.png"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /argv|--ref-image-url|unknown option/i);
});

test("generate_video.js rejects --reference-image-url (flag removed)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: ["--stage", "--prompt", "x", "--reference-image-url", "https://example.com/a.png"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
});

test("generate_video.js rejects --reference-audio-url (flag removed)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: ["--stage", "--prompt", "x", "--reference-audio-url", "https://example.com/a.mp3"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
});

test("generate_video.js rejects --reference-video-url (flag removed)", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: ["--stage", "--prompt", "x", "--reference-video-url", "https://example.com/a.mp4"],
    cwd,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
});

// ── --stage sidecar captures source-id refs (no more URL refs) ──────

import { readFile } from "node:fs/promises";
async function readSidecar(cwd, jobId) {
  return JSON.parse(await readFile(join(cwd, ".pending", `${jobId}.json`), "utf8"));
}

test("generate_image.js --stage captures --ref-source-id in sidecar", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_image.js",
    args: ["--stage", "--prompt", "x", "--ref-source-id", "image_42"],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.stage, "draft");
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.deepEqual(sidecar.reference_source_ids, ["image_42"]);
  // references[] is gone — projection resolves via reference_source_ids only.
  assert.strictEqual(sidecar.references, undefined);
});

test("generate_image_pro.js --stage captures --ref-source-id in sidecar", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_image_pro.js",
    args: ["--stage", "--prompt", "x", "--size", "1024x1024", "--ref-source-id", "image_42"],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.stage, "draft");
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.deepEqual(sidecar.reference_source_ids, ["image_42"]);
  assert.strictEqual(sidecar.references, undefined);
});

test("generate_video.js --stage merges --ref-source-id + --ref-audio-source-id", async (t) => {
  const cwd = await setupCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { code, stdout } = await runCli({
    script: "generate_video.js",
    args: [
      "--stage", "--prompt", "x",
      "--ref-source-id", "image_3",
      "--ref-source-id", "video_1",
      "--ref-audio-source-id", "audio_5",
    ],
    cwd,
  });
  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  const sidecar = await readSidecar(cwd, reply.job_id);
  assert.deepEqual(sidecar.reference_source_ids, ["image_3", "video_1", "audio_5"]);
  assert.strictEqual(sidecar.references, undefined);
});
