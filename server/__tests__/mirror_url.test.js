// End-to-end tests for mirror_url.js.
//
// Two helper servers: (1) a "remote" HTTP server serving the bytes the
// CLI fetches via --url; (2) a mock viewer answering /projects/:id/mutate
// and /projects/:id/preupload-asset that the CLI POSTs to. We point the
// CLI at the mock viewer via VIEWER_HOST/VIEWER_PORT env vars, so no
// real local_viewer.js process is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import sharp from "sharp";

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

// Make a tmp project directory and a sibling .active_project file so the
// CLI's readActiveProject() resolves without needing the host's real
// projects/ tree. The CLI computes paths relative to PROJECT_ROOT
// (server/local_mirror.js), which it derives from its own __dirname —
// we don't try to spoof that; the CLI just needs the active project id
// and a place to drop the .tmp bytes.
async function setupProject() {
  const root = await mkdtemp(join(tmpdir(), "mirror-test-"));
  const projectId = "test_proj";
  const projectDir = join(root, "projects", projectId);
  await mkdir(join(projectDir, "assets", ".tmp"), { recursive: true });
  return { root, projectDir, projectId };
}

// Tiny "remote" server that returns predetermined bytes + Content-Type.
function makeRemoteServer({ bytes, contentType, status = 200 }) {
  const server = http.createServer((req, res) => {
    res.statusCode = status;
    if (contentType) res.setHeader("content-type", contentType);
    if (status >= 200 && status < 300) res.end(bytes);
    else res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/asset` });
    });
  });
}

// Mock viewer: captures every POST body it receives so tests can assert
// on the addBatch payload the CLI sent. Always responds with a fake
// assigned node id and bumped version.
function makeMockViewer({ assignedNodeId = "image_1", version = 2 } = {}) {
  const captures = { mutateBodies: [], preuploadBodies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (req.url.includes("/mutate")) {
          captures.mutateBodies.push(parsed);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            ok: true,
            assigned: { node_ids: [assignedNodeId] },
            version,
          }));
          return;
        }
        if (req.url.includes("/preupload-asset")) {
          captures.preuploadBodies.push(parsed);
          res.statusCode = 204;
          res.end();
          return;
        }
        res.statusCode = 404;
        res.end();
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, klass: "infra", message: e.message }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, captures });
    });
  });
}

// 1x1 PNG via sharp so the image classifier + dim measurement both fire.
async function pngBytes() {
  return await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .png().toBuffer();
}

// Tiny payloads that don't need to decode — audio/video tests are about
// classification + persistence, not codec validity.
function audioBytes() { return Buffer.from([0xff, 0xfb, 0x90, 0x00]); }
function videoBytes() { return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); }

// ── happy path: image ────────────────────────────────────────────────
test("mirror_url.js fetches image, mints image_result with subtype=reference", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const png = await pngBytes();
  const remote = await makeRemoteServer({ bytes: png, contentType: "image/png" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const viewer = await makeMockViewer({ assignedNodeId: "image_42" });
  t.after(() => new Promise((r) => viewer.server.close(r)));

  const { code, stdout, stderr } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  assert.strictEqual(code, 0, `expected exit 0; stderr:\n${stderr}`);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.node_id, "image_42");
  assert.strictEqual(reply.kind, "image");
  assert.strictEqual(reply.content_type, "image/png");
  assert.strictEqual(reply.source_url, remote.url);
  assert.strictEqual(reply.size_bytes, png.length);
  assert.strictEqual(reply.canvas_mutation.version, 2);

  // Inspect the addBatch body the CLI sent to the mutator.
  assert.strictEqual(viewer.captures.mutateBodies.length, 1);
  const env = viewer.captures.mutateBodies[0];
  assert.strictEqual(env.op, "addBatch");
  assert.strictEqual(env.actor, "cli:mirror_url");
  const node = env.payload.nodes[0];
  assert.strictEqual(node.type, "image_result");
  assert.strictEqual(node.data.subtype, "reference");
  assert.strictEqual(node.data.metadata.source, "user_upload");
  assert.strictEqual(node.data.metadata.source_url, remote.url);
  assert.strictEqual(node.data.metadata.task_type, "upload");
  assert.strictEqual(node.data.metadata.content_type, "image/png");
  assert.strictEqual(node.data.metadata.size_bytes, png.length);
  assert.ok(node.data.attachment_id, "attachment_id auto-generated");
  assert.match(node.data.attachment_id, /^[0-9a-f-]{36}$/, "attachment_id is a UUID");
  assert.ok(node.tmp_path, "tmp_path passed to mutator");
  assert.match(node.tmp_path, /\.tmp\/tmp_/);

  // Preupload was fired once.
  assert.strictEqual(viewer.captures.preuploadBodies.length, 1);
  assert.strictEqual(viewer.captures.preuploadBodies[0].mime_type, "image/png");
});

// ── happy path: audio ────────────────────────────────────────────────
test("mirror_url.js fetches audio, mints audio_result with subtype=upload", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const remote = await makeRemoteServer({ bytes: audioBytes(), contentType: "audio/mpeg" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const viewer = await makeMockViewer({ assignedNodeId: "audio_3" });
  t.after(() => new Promise((r) => viewer.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.kind, "audio");
  assert.strictEqual(reply.node_id, "audio_3");

  const node = viewer.captures.mutateBodies[0].payload.nodes[0];
  assert.strictEqual(node.type, "audio_result");
  assert.strictEqual(node.data.subtype, "upload");
  assert.strictEqual(node.data.metadata.source, "user_upload");
  assert.strictEqual(node.data.metadata.source_url, remote.url);
});

// ── happy path: video ────────────────────────────────────────────────
test("mirror_url.js fetches video, mints video_result (no subtype)", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const remote = await makeRemoteServer({ bytes: videoBytes(), contentType: "video/mp4" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const viewer = await makeMockViewer({ assignedNodeId: "video_5" });
  t.after(() => new Promise((r) => viewer.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.kind, "video");
  assert.strictEqual(reply.node_id, "video_5");

  const node = viewer.captures.mutateBodies[0].payload.nodes[0];
  assert.strictEqual(node.type, "video_result");
  // upload_payload.buildUploadedNodePayload omits subtype for video uploads.
  assert.strictEqual(node.data.subtype, undefined);
  assert.strictEqual(node.data.duration, 0);
  assert.strictEqual(node.data.aspect, "16:9");
  assert.strictEqual(node.data.metadata.source, "user_upload");
  assert.strictEqual(node.data.metadata.source_url, remote.url);
});

// ── kind override ────────────────────────────────────────────────────
test("mirror_url.js --kind override forces the chosen kind", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  // Server returns generic octet-stream; sniffing alone would classify as note.
  // --kind image forces image classification (and sharp will read the PNG bytes).
  const png = await pngBytes();
  const remote = await makeRemoteServer({ bytes: png, contentType: "application/octet-stream" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const viewer = await makeMockViewer({ assignedNodeId: "image_7" });
  t.after(() => new Promise((r) => viewer.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--kind", "image", "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.kind, "image");
  const node = viewer.captures.mutateBodies[0].payload.nodes[0];
  assert.strictEqual(node.type, "image_result");
});

// ── --label override ─────────────────────────────────────────────────
test("mirror_url.js --label overrides the auto-derived label", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await makeRemoteServer({ bytes: await pngBytes(), contentType: "image/png" });
  t.after(() => new Promise((r) => remote.server.close(r)));
  const viewer = await makeMockViewer();
  t.after(() => new Promise((r) => viewer.server.close(r)));

  await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--label", "ref pose", "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  const node = viewer.captures.mutateBodies[0].payload.nodes[0];
  assert.strictEqual(node.data.label, "ref pose");
});

// ── --no-canvas-write ────────────────────────────────────────────────
test("mirror_url.js --no-canvas-write skips mutation", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await makeRemoteServer({ bytes: await pngBytes(), contentType: "image/png" });
  t.after(() => new Promise((r) => remote.server.close(r)));
  const viewer = await makeMockViewer();
  t.after(() => new Promise((r) => viewer.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--no-canvas-write", "--project-id", projectId],
    cwd: projectDir,
    env: { VIEWER_HOST: "127.0.0.1", VIEWER_PORT: String(viewer.port) },
  });

  assert.strictEqual(code, 0);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.kind, "image");
  assert.strictEqual(reply.node_id, undefined, "no node minted");
  assert.strictEqual(viewer.captures.mutateBodies.length, 0, "viewer not called");
});

// ── failure cases ────────────────────────────────────────────────────
test("mirror_url.js without --url → bad_args", async (t) => {
  const { root, projectDir } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: [],
    cwd: projectDir,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.ok, false);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /--url/);
});

test("mirror_url.js with invalid --kind → bad_args", async (t) => {
  const { root, projectDir } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", "http://127.0.0.1:1/x", "--kind", "garbage"],
    cwd: projectDir,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /invalid --kind/);
});

test("mirror_url.js with 404 → bad_args", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await makeRemoteServer({ bytes: Buffer.alloc(0), status: 404 });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--project-id", projectId],
    cwd: projectDir,
  });
  assert.strictEqual(code, 1);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /404/);
});

test("mirror_url.js with text/html mime → bad_args (media-only)", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await makeRemoteServer({ bytes: Buffer.from("<html>"), contentType: "text/html" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", remote.url, "--project-id", projectId],
    cwd: projectDir,
  });
  assert.strictEqual(code, 2);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /note/);
});

test("mirror_url.js with unreachable URL → bad_args", async (t) => {
  const { root, projectDir, projectId } = await setupProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await runCli({
    script: "mirror_url.js",
    args: ["--url", "http://127.0.0.1:1/never", "--project-id", projectId],
    cwd: projectDir,
  });
  assert.strictEqual(code, 1);
  const reply = parseReply(stdout);
  assert.strictEqual(reply.klass, "bad_args");
  assert.match(reply.message, /fetch failed/);
});
