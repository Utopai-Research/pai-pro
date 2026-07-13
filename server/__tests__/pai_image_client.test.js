// Unit tests for pai_image_client. Mocks globalThis.fetch — the generated
// image comes back base64-encoded inside the JSON body (inlineData), so the
// whole round trip is a single POST /api/v1/generate with no download hop.

import test from "node:test";
import assert from "node:assert/strict";

import { generateImage } from "../pai_image_client.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = PNG_BYTES.toString("base64");

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

function inlineImageBody({ data = PNG_B64, mimeType = "image/png" } = {}) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType, data } }] },
      },
    ],
  };
}

test("generateImage sends the raw image-generation payload and decodes the inline image", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(inlineImageBody()));

  const result = await generateImage({
    prompt: "a foggy harbor at dawn",
    aspectRatio: "16:9",
    imageSize: "2K",
  });

  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.mime, "image/png");
  assert.equal(result.model, "image-generation");
  assert.equal(typeof result.durationSeconds, "number");
  assert.ok(result.durationSeconds >= 0);
  assert.equal(result.costUsd, null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pai.test/api/v1/generate");
  assert.equal(calls[0].method, "POST");
  const { model, payload } = calls[0].body;
  assert.equal(model, "image-generation");
  assert.deepEqual(payload.contents, [
    { role: "user", parts: [{ text: "a foggy harbor at dawn" }] },
  ]);
  assert.deepEqual(payload.generationConfig, {
    responseModalities: ["IMAGE"],
    imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
  });
  assert.deepEqual(payload.safetySettings.map((s) => s.category), [
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ]);
  assert.ok(payload.safetySettings.every((s) => s.threshold === "BLOCK_ONLY_HIGH"));
});

test("generateImage sends URL refs as fileData parts before the prompt text", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(inlineImageBody({ mimeType: "image/jpeg" })));

  const result = await generateImage({
    prompt: "match the reference style",
    refImageUrls: ["https://example.com/a.png", "", 42, "https://example.com/b.png"],
  });

  assert.equal(result.mime, "image/jpeg");
  const parts = calls[0].body.payload.contents[0].parts;
  // Non-string / empty entries are silently dropped; refs precede the text.
  assert.deepEqual(parts, [
    { fileData: { fileUri: "https://example.com/a.png" } },
    { fileData: { fileUri: "https://example.com/b.png" } },
    { text: "match the reference style" },
  ]);
  // aspectRatio / imageSize omitted → imageConfig stays empty. The JSDoc
  // defaults ("16:9" / "2K") are applied by the CLI, not here.
  assert.deepEqual(calls[0].body.payload.generationConfig.imageConfig, {});
});

test("generateImage validates prompt and rejects data: URI refs before the provider call", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(inlineImageBody()));

  await assert.rejects(
    generateImage({}),
    (e) => e.klass === "bad_args" && /prompt required/.test(e.message),
  );
  await assert.rejects(
    generateImage({ prompt: "   " }),
    (e) => e.klass === "bad_args" && /prompt required/.test(e.message),
  );
  await assert.rejects(
    generateImage({ prompt: "x", refImageUrls: ["data:image/png;base64,AAAA"] }),
    (e) => e.klass === "bad_args" && /URL refs only/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test("generateImage classifies promptFeedback.blockReason as content_filtered", async (t) => {
  installPaiFetch(t, () => jsonResponse({
    promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
    candidates: [],
  }));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "content_filtered"
      && /promptFeedback\.blockReason=PROHIBITED_CONTENT/.test(e.message),
  );
});

test("generateImage classifies safety finishReasons as content_filtered (case-insensitive)", async (t) => {
  const reasons = ["IMAGE_SAFETY", "blocklist"];
  let i = 0;
  installPaiFetch(t, () => jsonResponse({
    candidates: [{ finishReason: reasons[i++], content: { parts: [] } }],
  }));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "content_filtered" && /finishReason=IMAGE_SAFETY/.test(e.message),
  );
  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "content_filtered" && /finishReason=blocklist/.test(e.message),
  );
});

test("generateImage treats 200-with-no-image as content_filtered and names unfetchable refs", async (t) => {
  installPaiFetch(t, () => jsonResponse({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "no image for you" }] } }],
  }));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "content_filtered"
      && /no inline image/.test(e.message)
      && !/with refs/.test(e.message),
  );
  await assert.rejects(
    generateImage({ prompt: "x", refImageUrls: ["https://example.com/ref.png"] }),
    (e) => e.klass === "content_filtered"
      && /no inline image/.test(e.message)
      && e.message.includes("https://example.com/ref.png")
      && /publicly fetchable/.test(e.message),
  );
});

test("generateImage surfaces inline data that decodes to zero bytes as transient", async (t) => {
  installPaiFetch(t, () => jsonResponse(inlineImageBody({ data: "!!!" })));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "transient" && /image bytes are empty/.test(e.message),
  );
});

test("generateImage maps HTTP 400 to bad_args", async (t) => {
  installPaiFetch(t, () => jsonResponse({ detail: "payload rejected upstream" }, 400));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "bad_args" && /payload rejected upstream/.test(e.message),
  );
});

test("generateImage maps HTTP 429 to rate_limited and parses Retry-After", async (t) => {
  installPaiFetch(t, () => jsonResponse({ detail: "slow down" }, 429, { "Retry-After": "7" }));

  await assert.rejects(
    generateImage({ prompt: "x" }),
    (e) => e.klass === "rate_limited" && e.retryAfterSec === 7 && /slow down/.test(e.message),
  );
});

test("generateImage picks the first inline image across candidates and mixed parts", async (t) => {
  const SECOND = Buffer.from("second-image");
  installPaiFetch(t, () => jsonResponse({
    candidates: [
      { finishReason: "STOP", content: { parts: [{ text: "thinking…" }] } },
      { content: {} },
      {
        content: {
          parts: [
            { text: "here you go" },
            { inlineData: { data: PNG_B64 } }, // no mimeType → image/png default
            { inlineData: { mimeType: "image/png", data: SECOND.toString("base64") } },
          ],
        },
      },
    ],
  }));

  const result = await generateImage({ prompt: "x" });
  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.mime, "image/png");
});
