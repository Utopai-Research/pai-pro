// Tests for extract_frames.js. Arg validation runs without ffmpeg; the
// real extraction round-trip is skipped when ffmpeg isn't installed on the
// test box (matching the soft-dep contract in pdf_extract.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(__dirname, "..", "cli", "extract_frames.js");

function runCli(args, cwd) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      process.execPath,
      [CLI, ...args],
      { stdio: ["ignore", "pipe", "ignore"], ...(cwd ? { cwd } : {}) },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

function hasFfmpeg() {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function makeClip(dir) {
  // 2s synthetic test pattern; small and codec-default so it works on any
  // stock ffmpeg build.
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=duration=2:size=320x240:rate=10",
      "-pix_fmt", "yuv420p",
      join(dir, "clip.mp4"),
    ], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg clip generation exit ${code}`));
    });
  });
}

test("extract_frames.js rejects bad arguments as bad_args", async (t) => {
  const cases = [
    { name: "missing --path", args: [], message: /missing --path/ },
    {
      name: "count zero",
      args: ["--path", "x.mp4", "--count", "0"],
      message: /count must be an integer in \[1,10\]/,
    },
    {
      name: "fractional count",
      args: ["--path", "x.mp4", "--count", "2.5"],
      message: /count must be an integer in \[1,10\]/,
    },
    {
      name: "count above max",
      args: ["--path", "x.mp4", "--count", "11"],
      message: /count must be an integer in \[1,10\]/,
    },
    {
      name: "max-width below floor",
      args: ["--path", "x.mp4", "--max-width", "10"],
      message: /max-width must be an integer >= 64/,
    },
    {
      name: "nonexistent input",
      args: ["--path", "definitely_missing.mp4"],
      message: /input not found/,
    },
  ];

  for (const { name, args, message } of cases) {
    await t.test(name, async () => {
      const { code, stdout } = await runCli(args);
      assert.equal(code, 2);
      const reply = parseReply(stdout);
      assert.equal(reply.ok, false);
      assert.equal(reply.klass, "bad_args");
      assert.match(reply.message, message);
    });
  }
});

test("extract_frames.js samples evenly spaced frames from a real clip", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg not installed");
    return;
  }
  const workDir = await mkdtemp(join(tmpdir(), "extract-frames-test-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  await makeClip(workDir);

  const { code, stdout } = await runCli(["--path", "clip.mp4", "--count", "3"], workDir);
  assert.equal(code, 0);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.count, 3);
  assert.equal(reply.frames.length, 3);
  assert.ok(
    Math.abs(reply.duration_seconds - 2) < 0.5,
    `expected ~2s duration, got ${reply.duration_seconds}`,
  );
  for (const frame of reply.frames) {
    assert.equal(isAbsolute(frame), false, `expected cwd-relative path, got ${frame}`);
    const info = await stat(join(workDir, frame));
    assert.ok(info.size > 0, `expected nonempty frame at ${frame}`);
  }

  // Re-run with a smaller count: the per-input dir is cleared, not appended to.
  const rerun = await runCli(["--path", "clip.mp4", "--count", "2"], workDir);
  assert.equal(rerun.code, 0);
  const files = await readdir(join(workDir, "assets", ".tmp", "frames", "clip"));
  assert.equal(files.length, 2);
});
