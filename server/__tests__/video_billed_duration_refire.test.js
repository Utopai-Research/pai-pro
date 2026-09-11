// The --existing-job-id re-measure guard on cli/generate_video.js.
//
// The draft gate's price is a snapshot taken when the job is STAGED and never
// recomputed when it fires. The fire route replays the stored argv, so the CLI
// re-measures the reference video and refuses if that moved the job to a
// different price than the one on the button the user pressed.
//
// This is the only test that executes that block at all. It exists because the
// block referenced an identifier that had been renamed out of the import list
// and nothing noticed: there is no linter in this repo, and every other test
// either stages (which skips the block) or would have to spend real money to
// reach it. A bare ReferenceError there takes down every fire with a prior
// sidecar, on both API versions.
//
// No project, no network, no ffprobe: run from a bare cwd, the reference id
// resolves to nothing and measures 0s, while the sidecar on disk claims 15s.
// That disagreement is the whole point — it is what a regenerated reference
// clip looks like to the fire path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli");

// An id no real canvas mints, so a developer's live .active_project cannot
// accidentally resolve it to a node with bytes ffprobe would measure.
const ABSENT_VIDEO_REF = "video_absent_refire_fixture";

// Neither test is supposed to reach a provider — both refuse first. But the
// repo root's .env carries a LIVE key and cli/ loads it, so the credentials are
// pointed at a dead port rather than left to the ambient environment: an edit
// that drops a refusing argument then fails to connect instead of paying for a
// render. Same shape generate_video_cli.test.js uses.
const DEAD_END_ENV = { PAI_KEY: "PAI_test", PAI_API_BASE: "http://127.0.0.1:9" };

function runCli(args, cwd) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, "generate_video.js"), ...args],
      { cwd, env: { ...process.env, ...DEAD_END_ENV }, stdio: ["ignore", "pipe", "pipe"] },
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

async function setupDraft({ refVideoSeconds, model, duration }) {
  const dir = await mkdtemp(join(tmpdir(), "refire-"));
  await mkdir(join(dir, ".pending"), { recursive: true });
  await mkdir(join(dir, ".results"), { recursive: true });
  await writeFile(
    join(dir, ".pending", "job_refire.json"),
    JSON.stringify({
      id: "job_refire",
      kind: "video",
      stage: "draft",
      prompt: "x",
      model,
      resolution: "720p",
      duration,
      ref_video_seconds: refVideoSeconds,
      script: "generate_video.js",
    }) + "\n",
  );
  return dir;
}

// 2.5 is the version the guard can still act on. Its tier is selected BY the
// billed seconds, so losing a reference moves the price. 2.0 is priced on the
// output clip alone now — see model_registry.js — so its price is the same
// with or without the reference, and this guard is structurally unreachable
// for it. That is the correct outcome, not a gap: a 2.0 draft cannot be
// re-tiered by a reference that changed underneath it.
const FIRE_ARGS_25 = [
  "--existing-job-id", "job_refire",
  "--version", "2.5",
  "--prompt", "x",
  "--duration", "5",
  "--resolution", "720p",
  "--ref-source-id", ABSENT_VIDEO_REF,
];

const FIRE_ARGS_20 = [
  "--existing-job-id", "job_refire",
  "--prompt", "x",
  "--duration", "15",
  "--resolution", "720p",
  "--ref-source-id", ABSENT_VIDEO_REF,
];

test("generate_video.js --existing-job-id refuses a 2.5 draft whose reference video no longer measures the approved seconds", async (t) => {
  // Approved as 5s output + 30s of reference = 35 billed seconds (tier35).
  // The reference no longer resolves, so it now measures 5 (tier20) — a
  // different price for a job the user already approved.
  const cwd = await setupDraft({ refVideoSeconds: 30, model: "video-generation-25", duration: 5 });
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli(FIRE_ARGS_25, cwd);

  // A ReferenceError in the re-measure block exits 1 with a stack and no JSON
  // reply, so assert on the classified refusal rather than just "non-zero".
  assert.ok(
    !/ReferenceError/.test(stderr),
    `re-measure block threw instead of refusing: ${stderr.slice(-600)}`,
  );
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /reference video changed since this draft was approved/);
  assert.match(reply.message, /5s \(was 35s\)/);
});

test("generate_video.js --existing-job-id lets a 2.5 draft through when nothing moved", async (t) => {
  // Same block, agreeing branch: no reference seconds approved, none measured.
  const cwd = await setupDraft({ refVideoSeconds: 0, model: "video-generation-25", duration: 5 });
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { stdout, stderr } = await runCli(FIRE_ARGS_25, cwd);

  assert.ok(
    !/ReferenceError/.test(stderr),
    `re-measure block threw instead of falling through: ${stderr.slice(-600)}`,
  );
  assert.doesNotMatch(stdout, /reference video changed since this draft was approved/);
});

test("a 2.0 draft is NOT re-tiered by a reference that changed, because its price does not depend on one", async (t) => {
  // The mirror of the first test, and the reason 2.0 needs no guard: the
  // backend prices 2.0 on the output clip at the reference-free rate, this
  // file matches it, so 15s costs the same whether the reference measures 30s
  // or nothing. Refusing here would block a job whose price never moved.
  const cwd = await setupDraft({ refVideoSeconds: 30, model: "video-generation", duration: 15 });
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { stdout, stderr } = await runCli(FIRE_ARGS_20, cwd);

  assert.ok(!/ReferenceError/.test(stderr), stderr.slice(-600));
  assert.doesNotMatch(stdout, /reference video changed since this draft was approved/);
});
