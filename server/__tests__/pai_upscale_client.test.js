import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createUpscale,
  acceptUpscale,
  completeUpscale,
  uploadUpscaleSource,
} from "../pai_upscale_client.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installPaiFetch(t, handler) {
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.PAI_KEY;
  const priorBase = process.env.PAI_API_BASE;
  const calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    let body = null;
    try { body = JSON.parse(opts.body || "null"); } catch {}
    const entry = { url: String(url), method: opts.method, body };
    calls.push(entry);
    return handler(entry);
  };
  process.env.PAI_KEY = "PAI_test";
  process.env.PAI_API_BASE = "https://pai.test";

  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.PAI_KEY;
    else process.env.PAI_KEY = priorKey;
    if (priorBase === undefined) delete process.env.PAI_API_BASE;
    else process.env.PAI_API_BASE = priorBase;
  });

  return calls;
}

test("video upscale client sends create, accept, and complete payloads", async (t) => {
  const calls = installPaiFetch(t, ({ url, body }) => {
    assert.match(url, /^https:\/\/pai\.test\/api\/v1\/(?:generate|submit)$/);
    if (body?.model === "upscale-create") {
      return jsonResponse({ requestId: "up_req_123", estimates: { price_usd: 1.23, time_sec: 45 } });
    }
    if (body?.model === "upscale-accept") {
      return jsonResponse({ urls: ["https://upload.test/object"] });
    }
    if (body?.model === "upscale-complete") {
      return jsonResponse({ code: 0, job_id: "job_123", status: "QUEUED" });
    }
    return jsonResponse({ detail: "unexpected model" }, 400);
  });

  const createPayload = {
    source: { resolution: { width: 1280, height: 720 } },
    output: { resolution: { width: 3840, height: 2160 } },
    filters: [{ model: "prob-4" }],
  };
  const created = await createUpscale(createPayload);
  const accepted = await acceptUpscale(created.requestId);
  const completed = await completeUpscale({
    requestId: created.requestId,
    uploadResult: { partNum: 1, eTag: "etag-123" },
  });

  assert.deepEqual(created, {
    requestId: "up_req_123",
    estimates: { price_usd: 1.23, time_sec: 45 },
    raw: { requestId: "up_req_123", estimates: { price_usd: 1.23, time_sec: 45 } },
  });
  assert.equal(accepted.uploadUrl, "https://upload.test/object");
  assert.equal(completed.taskId, "job_123");

  assert.deepEqual(calls.map((c) => c.body.model), [
    "upscale-create",
    "upscale-accept",
    "upscale-complete",
  ]);
  assert.deepEqual(calls[0].body.payload, createPayload);
  assert.deepEqual(calls[1].body.payload, { request_id: "up_req_123" });
  assert.deepEqual(calls[2].body.payload, {
    request_id: "up_req_123",
    payload: { uploadResults: [{ partNum: 1, eTag: "etag-123" }] },
  });
});

function makeUploadServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "PUT" || req.url !== "/upload") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.setHeader("ETag", "\"etag-456\"");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/upload`, requests });
    });
  });
}

test("uploadUpscaleSource sends one PUT and returns one upload result", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pai-upscale-client-"));
  const filePath = path.join(dir, "clip.mp4");
  await writeFile(filePath, Buffer.from("video-bytes"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const srv = await makeUploadServer();
  t.after(() => new Promise((resolve) => srv.server.close(resolve)));

  const result = await uploadUpscaleSource({
    uploadUrl: srv.url,
    filePath,
    contentType: "video/mp4",
  });

  assert.deepEqual(result, { partNum: 1, eTag: "etag-456" });
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].headers["content-type"], "video/mp4");
  assert.equal(srv.requests[0].headers["content-length"], String(Buffer.byteLength("video-bytes")));
  assert.deepEqual(srv.requests[0].body, Buffer.from("video-bytes"));
});
