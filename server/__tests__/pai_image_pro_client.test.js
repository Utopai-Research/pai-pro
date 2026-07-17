import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { generateImagePro } from "../pai_image_pro_client.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/out.png") {
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/generate") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const parsed = raw ? JSON.parse(raw) : {};
        requests.push(parsed);
        handler({ req, res, body: parsed, requests });
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

async function withPaiServer(t, handler) {
  const priorKey = process.env.PAI_KEY;
  const priorBase = process.env.PAI_API_BASE;
  const srv = await makeServer(handler);
  process.env.PAI_KEY = "PAI_test";
  process.env.PAI_API_BASE = srv.url;
  t.after(() => {
    if (priorKey === undefined) delete process.env.PAI_KEY;
    else process.env.PAI_KEY = priorKey;
    if (priorBase === undefined) delete process.env.PAI_API_BASE;
    else process.env.PAI_API_BASE = priorBase;
    return new Promise((resolve) => srv.server.close(resolve));
  });
  return srv;
}

function successBody(baseUrl) {
  return {
    outcome: {
      media_urls: [{ url: `${baseUrl}/out.png` }],
    },
  };
}

test("generateImagePro uses image-generation-pro without refs", async (t) => {
  const srv = await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(successBody(srv.url)));
  });

  const result = await generateImagePro({
    prompt: "a clean product render",
    size: "1024x1024",
  });

  assert.equal(result.model, "image-generation-pro");
  assert.equal(result.size, "1024x1024");
  assert.equal(result.imageSize, "1K");
  assert.equal(result.aspectRatio, "1:1");
  assert.equal(result.mime, "image/png");
  assert.deepEqual(result.bytes, PNG_BYTES);

  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].model, "image-generation-pro");
  assert.equal(srv.requests[0].payload.prompt, "a clean product render");
  assert.equal(srv.requests[0].payload.size, "1024x1024");
  assert.equal(srv.requests[0].payload.quality, "high");
  assert.equal(srv.requests[0].payload.n, 1);
  assert.equal(srv.requests[0].payload.output_format, "png");
  assert.equal(srv.requests[0].payload.image, undefined);
});

test("generateImagePro uses image-edit-pro with one ref as a string", async (t) => {
  const srv = await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(successBody(srv.url)));
  });

  const result = await generateImagePro({
    prompt: "preserve the source",
    size: "1280x720",
    outputFormat: "jpeg",
    refImageUrls: ["https://example.com/ref.png"],
  });

  assert.equal(result.model, "image-generation-pro");
  assert.equal(result.mime, "image/jpeg");
  assert.equal(srv.requests[0].model, "image-edit-pro");
  assert.equal(srv.requests[0].payload.image, "https://example.com/ref.png");
  assert.equal(srv.requests[0].payload.output_format, "jpeg");
});

test("generateImagePro uses image-edit-pro with multiple refs as an array", async (t) => {
  const srv = await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(successBody(srv.url)));
  });

  await generateImagePro({
    prompt: "combine references",
    size: "2560x1440",
    refImageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
  });

  assert.equal(srv.requests[0].model, "image-edit-pro");
  assert.deepEqual(srv.requests[0].payload.image, [
    "https://example.com/a.png",
    "https://example.com/b.png",
  ]);
});

test("generateImagePro validates size, output format, and ref cap before provider call", async (t) => {
  const srv = await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(successBody(srv.url)));
  });

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1920x1080" }),
    (e) => e.klass === "bad_args" && /unsupported size/.test(e.message),
  );
  await assert.rejects(
    generateImagePro({ prompt: "x", outputFormat: "webp" }),
    (e) => e.klass === "bad_args" && /output_format/.test(e.message),
  );
  await assert.rejects(
    generateImagePro({
      prompt: "x",
      refImageUrls: Array.from({ length: 33 }, (_, i) => `https://example.com/${i}.png`),
    }),
    (e) => e.klass === "bad_args" && /reference cap/.test(e.message),
  );
  assert.equal(srv.requests.length, 0);
});

test("generateImagePro classifies policy-shaped empty success as content_filtered", async (t) => {
  await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "blocked by safety policy" } }));
  });

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1024x1024" }),
    (e) => e.klass === "content_filtered" && /content filter/.test(e.message),
  );
});

test("generateImagePro classifies policy-shaped HTTP failures as content_filtered", async (t) => {
  await withPaiServer(t, ({ res }) => {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ detail: "blocked by moderation policy" }));
  });

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1024x1024" }),
    (e) => e.klass === "content_filtered" && /moderation policy/.test(e.message),
  );
});

test("generateImagePro keeps non-bad_args klasses even with policy wording", async (t) => {
  // A 402 classifies as infra ("insufficient balance") — policy wording in
  // the upstream message must NOT re-tag it content_filtered, or the agent
  // rewords the prompt instead of surfacing the billing problem.
  await withPaiServer(t, ({ res }) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ detail: "insufficient balance under current usage policy" }));
  });

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1024x1024" }),
    (e) => e.klass === "infra" && /insufficient balance/.test(e.message),
  );
});

test("generateImagePro treats missing media URL as transient", async (t) => {
  await withPaiServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ outcome: { media_urls: [] } }));
  });

  await assert.rejects(
    generateImagePro({ prompt: "x", size: "1024x1024" }),
    (e) => e.klass === "transient" && /no media URL/.test(e.message),
  );
});
