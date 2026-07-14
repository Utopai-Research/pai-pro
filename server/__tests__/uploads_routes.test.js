// HTTP integration tests for the multipart upload route:
//   POST /projects/:id/upload  (routes/uploads.js → addBatch mutation)
//
// Spawns the viewer in a subprocess against a tmp PROJECTS_DIR (same
// pattern as canvas_mutator_http.test.js / pending_routes.test.js) and
// drives real multipart requests through fetch + FormData.
//
// Network safety: the viewer is spawned with PAI_KEY="" — an explicitly
// empty value blocks dotenv from backfilling the repo .env key, and
// pai_assets_client.preuploadCanvasUrl() returns before any cache or
// network work when PAI_KEY is falsy. PAI_API_BASE additionally points
// at an unroutable local port so no code path can reach the real API.
// No test here spawns a CLI or touches ffmpeg/ffprobe.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");

const PROJECT_ID = "up_main";
const NO_STATE_PROJECT_ID = "up_nostate";
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let viewerProc = null;
let viewerStderr = "";
let projectsDir = null;
let port = 0;
let baseUrl = "";
let pngBytes = null; // real 2x1 PNG so sharp can measure dimensions

async function freePort() {
  // Pick a port unlikely to collide; default 7488 is the real viewer.
  return 17800 + Math.floor(Math.random() * 400);
}

async function setupProjectWithWorkflow(id, { title = "T" } = {}) {
  const dir = join(projectsDir, id);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  await mkdir(join(dir, "assets/notes"), { recursive: true });
  const workflow = { version: 2, workflow_id: id, title, nodes: [], edges: [] };
  await writeFile(join(dir, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
  const now = new Date().toISOString();
  const meta = { id, title, created_at: now, last_active_at: now, agent_id: "codex" };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

// meta.json but NO workflow.json → the viewer loads the project with
// canvasState === null, which is the upload route's 409 precondition.
async function setupProjectWithoutWorkflow(id) {
  const dir = join(projectsDir, id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta = { id, title: "T", created_at: now, last_active_at: now, agent_id: "codex" };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

async function startViewer() {
  projectsDir = await mkdtemp(join(tmpdir(), "uploads-routes-"));
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await setupProjectWithWorkflow(PROJECT_ID);
  await setupProjectWithoutWorkflow(NO_STATE_PROJECT_ID);
  const env = {
    ...process.env,
    VIEWER_PORT: String(port),
    PAI_PROJECTS_DIR: projectsDir,
    PAI_ACTIVE_FILE: join(projectsDir, ".active_project"),
    PAI_ROOT_LINK: join(projectsDir, "workflow.json"),
    WEB_ORIGIN: "http://localhost:0",
    // Explicitly empty: dotenv never overrides an existing (even empty)
    // env var, and preuploadCanvasUrl no-ops without a key — so uploads
    // can never trigger a PAI asset upload from this test.
    PAI_KEY: "",
    // Paranoia: even if something ignored the key guard, this address is
    // connection-refused instantly.
    PAI_API_BASE: "http://127.0.0.1:9",
  };
  viewerProc = spawn(process.execPath, [VIEWER_PATH], { env, stdio: ["ignore", "pipe", "pipe"] });
  viewerProc.stderr.on("data", (d) => { viewerStderr += d; });
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`viewer did not start in 10s; stderr:\n${viewerStderr}`);
}

async function stopViewer() {
  if (viewerProc) {
    viewerProc.kill("SIGTERM");
    await new Promise((r) => viewerProc.once("exit", r));
    viewerProc = null;
  }
  if (projectsDir) {
    await rm(projectsDir, { recursive: true, force: true });
    projectsDir = null;
  }
}

async function readWorkflow(id = PROJECT_ID) {
  return JSON.parse(await readFile(join(projectsDir, id, "workflow.json"), "utf8"));
}

async function readPositions(id = PROJECT_ID) {
  return JSON.parse(await readFile(join(projectsDir, id, "canvas_positions.json"), "utf8"));
}

// files: [{ bytes, type, name, field? }], fields: { x: "10", ... }
async function upload(projectId, files, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) {
    fd.append(f.field ?? "file", new Blob([f.bytes], { type: f.type }), f.name);
  }
  const r = await fetch(`${baseUrl}/projects/${projectId}/upload`, {
    method: "POST",
    body: fd,
  });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  pngBytes = await sharp({
    create: { width: 2, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  await startViewer();
});
test.after(async () => {
  await stopViewer();
});

// --- happy path per accepted kind ---------------------------------------

test("image upload → image_result node, staged file renamed into assets/images, drop position honored", async () => {
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes: pngBytes, type: "image/png", name: "tiny sample.png" }],
    { x: "120.5", y: "-33" },
  );
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.nodes.length, 1);

  const node = body.nodes[0];
  assert.match(node.id, /^image_\d+$/);
  assert.equal(node.type, "image_result");
  assert.equal(node.data.subtype, "reference");
  assert.equal(node.data.label, "tiny sample.png");
  assert.equal(node.data.source_filename, "tiny sample.png");
  assert.match(node.data.attachment_id, UUID_RE);
  assert.equal(node.data.local_path, `assets/images/${node.id}.png`);
  assert.equal(node.data.metadata.source, "user_upload");
  assert.equal(node.data.metadata.task_type, "upload");
  assert.equal(node.data.metadata.content_type, "image/png");
  assert.equal(node.data.metadata.size_bytes, pngBytes.length);
  // sharp measured the real 2x1 shape — not a 1:1 / 16:9 fallback.
  assert.equal(node.data.metadata.aspect_ratio, "2:1");
  assert.ok(typeof node.data.metadata.generated_at === "string");

  // Bytes were staged into assets/.tmp then renamed by the mutator.
  const onDisk = await readFile(join(projectsDir, PROJECT_ID, node.data.local_path));
  assert.deepEqual(onDisk, pngBytes);

  // The node landed in workflow.json.
  const wf = await readWorkflow();
  const stored = wf.nodes.find((n) => n.id === node.id);
  assert.ok(stored, "uploaded node persisted to workflow.json");
  assert.equal(stored.type, "image_result");

  // Single-file drop coords land in the positions sidecar before the reply.
  const positions = await readPositions();
  assert.deepEqual(positions.positions[node.id], { x: 120.5, y: -33 });

  // The mutation was audit-logged with the viewer:upload actor.
  const log = (await readFile(join(projectsDir, PROJECT_ID, "mutations.jsonl"), "utf8"))
    .trim().split("\n").map((l) => JSON.parse(l));
  const entry = log.find((l) => l.reply?.assigned?.node_ids?.includes(node.id));
  assert.ok(entry, "upload mutation appears in mutations.jsonl");
  assert.equal(entry.op, "addBatch");
  assert.equal(entry.actor, "viewer:upload");
});

test("video upload → video_result node with duration 0, shot_id null, file persisted", async () => {
  const bytes = Buffer.from("not really an mp4 but bytes are bytes");
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes, type: "video/mp4", name: "clip.mp4" }],
  );
  assert.equal(status, 200);
  const node = body.nodes[0];
  assert.match(node.id, /^video_\d+$/);
  assert.equal(node.type, "video_result");
  assert.equal(node.data.label, "clip.mp4");
  assert.equal(node.data.duration, 0);
  assert.equal(node.data.aspect, "16:9");
  assert.equal(node.data.shot_id, null);
  assert.equal(node.data.source_filename, "clip.mp4");
  assert.match(node.data.attachment_id, UUID_RE);
  assert.equal(node.data.local_path, `assets/videos/${node.id}.mp4`);
  assert.equal(node.data.metadata.source, "user_upload");
  assert.equal(node.data.metadata.content_type, "video/mp4");
  assert.equal(node.data.metadata.size_bytes, bytes.length);
  const onDisk = await readFile(join(projectsDir, PROJECT_ID, node.data.local_path));
  assert.deepEqual(onDisk, bytes);
});

test("audio upload → audio_result node with subtype 'upload', filename metadata inside metadata bag", async () => {
  const bytes = Buffer.from("mp3-ish bytes");
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes, type: "audio/mpeg", name: "song.mp3" }],
  );
  assert.equal(status, 200);
  const node = body.nodes[0];
  assert.match(node.id, /^audio_\d+$/);
  assert.equal(node.type, "audio_result");
  assert.equal(node.data.subtype, "upload");
  assert.equal(node.data.label, "song.mp3");
  assert.equal(node.data.local_path, `assets/audios/${node.id}.mp3`);
  // Unlike image/video, audio keeps source_filename + attachment_id in
  // the metadata bag (see upload_payload.js).
  assert.equal(node.data.metadata.source_filename, "song.mp3");
  assert.match(node.data.metadata.attachment_id, UUID_RE);
  assert.equal(node.data.metadata.content_type, "audio/mpeg");
  assert.equal(node.data.metadata.size_bytes, bytes.length);
  const onDisk = await readFile(join(projectsDir, PROJECT_ID, node.data.local_path));
  assert.deepEqual(onDisk, bytes);
});

test("text upload → inline note with verbatim body, no file persisted, .md mirror written", async () => {
  const text = "Hello note\nsecond line";
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes: Buffer.from(text, "utf8"), type: "text/plain", name: "notes.txt" }],
  );
  assert.equal(status, 200);
  const node = body.nodes[0];
  assert.match(node.id, /^note_\d+$/);
  assert.equal(node.type, "note");
  assert.equal(node.data.label, "notes.txt");
  assert.equal(node.data.body, text);
  assert.equal(node.data.source_filename, "notes.txt");
  assert.match(node.data.attachment_id, UUID_RE);
  assert.equal(node.data.local_path, undefined, "notes are inline — no asset file");
  assert.equal(node.data.metadata.content_type, "text/plain");
  assert.equal(node.data.metadata.size_bytes, Buffer.byteLength(text));
  // The mutator's notes mirror (awaited inside mutate) derives the .md.
  const md = await readFile(join(projectsDir, PROJECT_ID, "assets/notes", `${node.id}.md`), "utf8");
  assert.equal(md, text);
});

test("unknown binary mime → note with '[name] uploaded (...)' placeholder body", async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes, type: "application/octet-stream", name: "data.bin" }],
  );
  assert.equal(status, 200);
  const node = body.nodes[0];
  assert.equal(node.type, "note");
  assert.equal(node.data.body, "[data.bin] uploaded (5 B, application/octet-stream)");
  assert.equal(node.data.local_path, undefined);
  assert.equal(node.data.metadata.content_type, "application/octet-stream");
});

test("multi-file upload → one addBatch, nodes in submission order, drop coords ignored", async () => {
  const txt = Buffer.from("batch note");
  const { status, body } = await upload(
    PROJECT_ID,
    [
      { bytes: pngBytes, type: "image/png", name: "a.png" },
      { bytes: txt, type: "text/plain", name: "b.txt" },
    ],
    { x: "77", y: "88" },
  );
  assert.equal(status, 200);
  assert.equal(body.nodes.length, 2);
  const [first, second] = body.nodes;
  assert.equal(first.type, "image_result");
  assert.equal(first.data.source_filename, "a.png");
  assert.equal(second.type, "note");
  assert.equal(second.data.body, "batch note");

  // Both landed in workflow.json.
  const wf = await readWorkflow();
  assert.ok(wf.nodes.some((n) => n.id === first.id));
  assert.ok(wf.nodes.some((n) => n.id === second.id));

  // x/y are single-file only: multi-file batches defer placement to the
  // client's gridPackBatch, so neither node gets a sidecar position.
  const positions = await readPositions();
  assert.equal(first.id in positions.positions, false);
  assert.equal(second.id in positions.positions, false);
});

// --- error paths ---------------------------------------------------------

test("upload to unknown project → 404", async () => {
  const { status, body } = await upload(
    "no_such_project",
    [{ bytes: Buffer.from("x"), type: "text/plain", name: "x.txt" }],
  );
  assert.equal(status, 404);
  assert.deepEqual(body, { ok: false, error: "not found" });
});

test("form without a 'file' entry → 400 missing 'file' field", async () => {
  const { status, body } = await upload(PROJECT_ID, [], { x: "1", y: "2" });
  assert.equal(status, 400);
  assert.deepEqual(body, { ok: false, error: "missing 'file' field" });
});

test("file under an unexpected field name → 400 bad_args (multer LIMIT_UNEXPECTED_FILE)", async () => {
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes: Buffer.from("x"), type: "text/plain", name: "x.txt", field: "nope" }],
  );
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.klass, "bad_args");
  assert.match(body.error, /unexpected field/i);
});

test("oversize file (> 100MB) → 413 with bad_args klass", async () => {
  const big = Buffer.alloc(UPLOAD_LIMIT_BYTES + 1);
  const { status, body } = await upload(
    PROJECT_ID,
    [{ bytes: big, type: "application/octet-stream", name: "big.bin" }],
  );
  assert.equal(status, 413);
  assert.equal(body.ok, false);
  assert.equal(body.klass, "bad_args");
  assert.equal(body.error, `file exceeds ${UPLOAD_LIMIT_BYTES} bytes`);
  // Nothing was appended to the canvas.
  const wf = await readWorkflow();
  assert.equal(wf.nodes.some((n) => n.data?.source_filename === "big.bin"), false);
});

test("malformed multipart body → 500 with error message", async () => {
  // NOTE: documents current behavior. busboy's parse errors ("Unexpected
  // end of form") are plain Errors, not MulterErrors, so the route's error
  // middleware falls through to the generic 500 branch rather than a 400.
  const boundary = "----uploadsroutetestboundary";
  const truncated =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    "hello"; // no closing boundary
  const r = await fetch(`${baseUrl}/projects/${PROJECT_ID}/upload`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: truncated,
  });
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unexpected end of form/i);
});

test("project loaded without canvas state → 409", async () => {
  const { status, body } = await upload(
    NO_STATE_PROJECT_ID,
    [{ bytes: Buffer.from("x"), type: "text/plain", name: "x.txt" }],
  );
  assert.equal(status, 409);
  assert.deepEqual(body, { ok: false, error: "no canvas state to append to" });
  // No stray staged file left behind: notes never stage, so .tmp should
  // not even exist for this project.
  await assert.rejects(stat(join(projectsDir, NO_STATE_PROJECT_ID, "assets/.tmp")), /ENOENT/);
});
