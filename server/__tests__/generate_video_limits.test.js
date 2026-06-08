// Preflight enforcement for VIDEO_LIMITS in generate_video.js (audit N13).
//
// generate_video.js documented per-file / aggregate duration caps and the
// "audio needs a visual anchor" rule in _limits.js but only enforced the
// three COUNT caps. Aggregate-duration overruns and audio-only ref sets used
// to sail past the local check: the user paid ~$0.01/ref to upload assets and
// the job ran for minutes before the provider rejected it.
//
// These tests build a real project under PAI_REPO_ROOT/projects/<id> (the
// path readNodeFromWorkflow reads from) with ref nodes carrying durations,
// then run the CLI's non-stage flow. Each case must fail bad_args (exit 2)
// BEFORE any asset upload or video submit. We point PAI_API_BASE at a capture
// server with PAI_KEY set, so any upload/submit that did fire would be
// recorded — and assert the capture stays empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { PAI_REPO_ROOT } from "../lib/paths.js";
import { VIDEO_LIMITS } from "../cli/_limits.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

function runCli({ args, cwd, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, "generate_video.js"), ...args],
      { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

// Any request reaching this server means a paid upload (video-generation-assets)
// or a video submit fired — the preflight failed to short-circuit.
function makeCaptureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "capture server should never be hit in a preflight test" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

// Build projects/<id>/ under the real PAI_REPO_ROOT (gitignored) with a
// workflow.json whose nodes carry local_path + duration so the preflight can
// read them. video_result keeps duration on data.duration; audio_result keeps
// it on metadata.duration_sec — matching the canvas schema.
async function setupProject(t, nodes) {
  const projectId = `vid_limits_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(PAI_REPO_ROOT, "projects", projectId);
  await mkdir(join(dir, "assets", ".tmp"), { recursive: true });
  await mkdir(join(dir, "assets", "videos"), { recursive: true });
  await writeFile(
    join(dir, "workflow.json"),
    JSON.stringify({ version: 2, workflow_id: projectId, title: "T", nodes, edges: [] }) + "\n",
  );
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id: projectId, title: "T", created_at: new Date().toISOString() }) + "\n",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { projectId, dir };
}

function videoNode(id, durationSec, localPath) {
  return {
    id,
    type: "video_result",
    data: {
      label: id,
      local_path: localPath ?? `assets/videos/${id}.mp4`,
      duration: durationSec,
      aspect: "16:9",
      metadata: { source: "pai", duration_sec: durationSec },
    },
  };
}

function imageNode(id) {
  return {
    id,
    type: "image_result",
    data: { label: id, local_path: `assets/images/${id}.png`, metadata: { source: "pai" } },
  };
}

function audioNode(id, durationSec) {
  return {
    id,
    type: "audio_result",
    data: {
      label: id,
      local_path: `assets/audios/${id}.mp3`,
      subtype: "voice",
      metadata: { source: "pai", duration_sec: durationSec },
    },
  };
}

async function runPreflightCase(t, { nodes, args }) {
  const pai = await makeCaptureServer();
  t.after(() => new Promise((resolve) => pai.server.close(resolve)));
  const { projectId, dir } = await setupProject(t, nodes);

  const { code, stdout, stderr } = await runCli({
    args: ["--prompt", "a test clip", "--project-id", projectId, ...args],
    cwd: dir,
    env: { PAI_KEY: "PAI_test", PAI_API_BASE: pai.url },
  });

  return { code, reply: parseReply(stdout), stderr, hits: pai.hits };
}

test("aggregate video duration over max_total_video_sec → bad_args, no upload", async (t) => {
  // 3 clips at 12s each = 36s total, well over max_total_video_sec (15s),
  // while each clip is within the per-file 1.8–15.2s window.
  const { code, reply, hits } = await runPreflightCase(t, {
    nodes: [videoNode("video_1", 12), videoNode("video_2", 12), videoNode("video_3", 12)],
    args: ["--ref-source-id", "video_1", "--ref-source-id", "video_2", "--ref-source-id", "video_3"],
  });

  assert.equal(code, 2);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  // The message echoes the offending limit.
  assert.match(reply.message, /max_total_video_sec/);
  assert.match(reply.message, new RegExp(String(VIDEO_LIMITS.max_total_video_sec)));
  // Nothing reached the provider — no paid upload, no submit.
  assert.deepEqual(hits, []);
});

test("per-clip video duration over max_video_sec → bad_args, no upload", async (t) => {
  // One clip at 30s exceeds max_video_sec (15.2s).
  const { code, reply, hits } = await runPreflightCase(t, {
    nodes: [videoNode("video_1", 30)],
    args: ["--ref-source-id", "video_1"],
  });

  assert.equal(code, 2);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /video ref video_1 is 30s/);
  assert.deepEqual(hits, []);
});

test("per-audio duration under min_audio_sec → bad_args, no upload", async (t) => {
  // A 0.5s audio is below min_audio_sec (1.8s). Paired with an image so the
  // anchor rule is satisfied and the duration rule is what trips.
  const { code, reply, hits } = await runPreflightCase(t, {
    nodes: [imageNode("image_1"), audioNode("audio_1", 0.5)],
    args: ["--ref-source-id", "image_1", "--ref-audio-source-id", "audio_1"],
  });

  assert.equal(code, 2);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /audio ref audio_1 is 0\.5s/);
  assert.deepEqual(hits, []);
});

test("audio-only ref set → bad_args (needs visual anchor), no upload", async (t) => {
  // Audio ref with no image / video anchor. Duration is in range so the
  // anchor rule is the sole failure.
  const { code, reply, hits } = await runPreflightCase(t, {
    nodes: [audioNode("audio_1", 5)],
    args: ["--ref-audio-source-id", "audio_1"],
  });

  assert.equal(code, 2);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /reference_audio cannot be the only reference input/);
  assert.deepEqual(hits, []);
});

test("in-range refs pass the preflight and proceed to the upload (capture hit)", async (t) => {
  // Two 5s clips (10s total, each in range) + a 5s audio anchored by them.
  // The preflight passes, so the flow advances to buildProviderRefs /
  // uploadReferences — which fails here (no tunnel / capture 500), but the
  // point is that it got PAST the duration guard. A bad_args from the guard
  // would name a limit; this failure must not.
  const { code, reply } = await runPreflightCase(t, {
    nodes: [videoNode("video_1", 5), videoNode("video_2", 5), audioNode("audio_1", 5)],
    args: [
      "--ref-source-id", "video_1",
      "--ref-source-id", "video_2",
      "--ref-audio-source-id", "audio_1",
    ],
  });

  assert.notEqual(code, 0);
  assert.equal(reply.ok, false);
  // Whatever the downstream failure is, it is NOT the duration / anchor guard.
  assert.doesNotMatch(reply.message ?? "", /max_total_video_sec|outside per-file|cannot be the only reference/);
});
