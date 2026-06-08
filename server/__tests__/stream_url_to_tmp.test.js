// Unit tests for local_mirror.js's streamUrlToTmp — the streaming
// download path that replaced the buffer-the-whole-asset-in-RAM code
// (audit N22). Stands up a local HTTP server on an ephemeral port (same
// idiom as mirror_url.test.js / pai_image_pro_client.test.js) and asserts
// the bytes land on disk byte-for-byte, plus that a mid-stream failure
// leaves no half-written tmp file behind.
//
// streamUrlToTmp computes its output path under PAI_REPO_ROOT/projects/
// <projectId>/ (PAI_REPO_ROOT is derived from the module's __dirname and
// isn't env-overridable). We pass an explicit, unique projectId and
// rm -rf that project dir in t.after, so the test never touches a real
// project's tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { readFile, rm, access } from "node:fs/promises";
import path from "node:path";

import { streamUrlToTmp } from "../local_mirror.js";
import { PAI_REPO_ROOT } from "../lib/paths.js";

// Serves a fixed body for GET /asset; everything else 404s. `status`
// lets a test force a non-2xx so streamUrlToTmp rejects before writing.
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

// Sends a Content-Length larger than the bytes it actually writes, then
// destroys the socket — the client sees a truncated body and pipeline
// rejects, exercising the partial-file unlink path.
function makeTruncatingServer({ head, declaredLength }) {
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "video/mp4");
    res.setHeader("content-length", String(declaredLength));
    res.write(head);
    // Drop the connection mid-body without ending the response.
    res.socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/asset` });
    });
  });
}

function uniqueProjectId() {
  return `streamtest_${crypto.randomBytes(6).toString("hex")}`;
}

function cleanupProject(projectId) {
  return rm(path.join(PAI_REPO_ROOT, "projects", projectId), {
    recursive: true,
    force: true,
  });
}

test("streamUrlToTmp streams the response body to a tmp file byte-for-byte", async (t) => {
  const projectId = uniqueProjectId();
  t.after(() => cleanupProject(projectId));

  // ~3 MB of random bytes so we're clearly exercising the streamed path,
  // not a trivially-small single-chunk payload.
  const payload = crypto.randomBytes(3 * 1024 * 1024);
  const remote = await makeRemoteServer({ bytes: payload, contentType: "video/mp4" });
  t.after(() => new Promise((r) => remote.server.close(r)));

  const staged = await streamUrlToTmp({
    url: remote.url,
    mimeType: "video/mp4",
    projectId,
  });

  assert.match(staged.local_path, /^assets\/\.tmp\/tmp_[0-9a-f]+\.mp4$/, "mp4 ext from mimeType");
  assert.ok(staged.absolute_path.endsWith(staged.filename));

  const onDisk = await readFile(staged.absolute_path);
  assert.equal(onDisk.length, payload.length, "full payload landed");
  assert.ok(onDisk.equals(payload), "bytes match the served payload exactly");
});

test("streamUrlToTmp falls back to the URL extension when mimeType is unknown", async (t) => {
  const projectId = uniqueProjectId();
  t.after(() => cleanupProject(projectId));

  const payload = Buffer.from("hello");
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const staged = await streamUrlToTmp({
    url: `http://127.0.0.1:${port}/clip.webm`,
    mimeType: "application/octet-stream",
    projectId,
  });
  assert.match(staged.local_path, /\.webm$/, "ext taken from the URL path");
  const onDisk = await readFile(staged.absolute_path);
  assert.ok(onDisk.equals(payload));
});

test("streamUrlToTmp rejects on a non-2xx response and writes no file", async (t) => {
  const projectId = uniqueProjectId();
  t.after(() => cleanupProject(projectId));

  const remote = await makeRemoteServer({ bytes: Buffer.alloc(0), status: 500 });
  t.after(() => new Promise((r) => remote.server.close(r)));

  await assert.rejects(
    () => streamUrlToTmp({ url: remote.url, mimeType: "video/mp4", projectId }),
    (e) => {
      assert.equal(e.klass, "transient");
      assert.match(e.message, /stream download failed \(500/);
      return true;
    },
  );
  // No project dir / tmp file should have been created — the throw happens
  // before mkdir + the write stream open.
  await assert.rejects(
    () => access(path.join(PAI_REPO_ROOT, "projects", projectId, "assets", ".tmp")),
    "tmp dir not created on a failed fetch",
  );
});

test("streamUrlToTmp unlinks the partial tmp file when the stream errors mid-body", async (t) => {
  const projectId = uniqueProjectId();
  t.after(() => cleanupProject(projectId));

  // Promise the client 1 MB but hang up after 1 KB.
  const remote = await makeTruncatingServer({
    head: crypto.randomBytes(1024),
    declaredLength: 1024 * 1024,
  });
  t.after(() => new Promise((r) => remote.server.close(r)));

  let captured;
  await assert.rejects(async () => {
    // Pin the filename so we can assert it's gone afterward.
    captured = path.join(
      PAI_REPO_ROOT, "projects", projectId, "assets", ".tmp", "partial_clip.mp4",
    );
    await streamUrlToTmp({
      url: remote.url,
      mimeType: "video/mp4",
      projectId,
      filename: "partial_clip.mp4",
    });
  }, (e) => {
    assert.equal(e.klass, "transient");
    assert.match(e.message, /stream download failed/);
    return true;
  });

  await assert.rejects(
    () => access(captured),
    "partial tmp file should have been unlinked after the mid-stream error",
  );
});
