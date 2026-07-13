// Unit tests for pai_voice_client. Mocks globalThis.fetch — PAI wraps the
// raw MP3 as body_base64 inside a JSON envelope, so the whole round trip is
// a single POST /api/v1/generate.

import test from "node:test";
import assert from "node:assert/strict";

import { generateVoice } from "../pai_voice_client.js";

const MP3_BYTES = Buffer.from("ID3-tagged-fake-mp3-bytes");
const MP3_B64 = MP3_BYTES.toString("base64");

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

test("generateVoice sends the raw tts payload and decodes body_base64", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse({ body_base64: MP3_B64 }));

  const result = await generateVoice({
    text: "Hello there.",
    prompt: "Warm, low, unhurried narrator",
  });

  assert.deepEqual(result.bytes, MP3_BYTES);
  assert.equal(result.mime, "audio/mpeg"); // no content_type in the envelope → default
  assert.equal(result.model, "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign");
  assert.equal(typeof result.durationSeconds, "number");
  assert.ok(result.durationSeconds >= 0);
  assert.equal(result.wallClockSec, result.durationSeconds);
  assert.equal(result.costUsd, null);
  assert.equal(result.audioDurationSec, null);
  assert.equal(result.predictionId, null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pai.test/api/v1/generate");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    model: "tts",
    payload: {
      model: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
      input: "Hello there.",
      task_type: "VoiceDesign",
      instructions: "Warm, low, unhurried narrator",
      response_format: "mp3",
    },
  });
});

test("generateVoice honors the envelope content_type when present", async (t) => {
  installPaiFetch(t, () => jsonResponse({ body_base64: MP3_B64, content_type: "audio/mp3" }));

  const result = await generateVoice({ text: "hi", prompt: "brief" });
  assert.equal(result.mime, "audio/mp3");
});

test("generateVoice validates text and prompt before the provider call", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse({ body_base64: MP3_B64 }));

  await assert.rejects(
    generateVoice({ prompt: "narrator" }),
    (e) => e.klass === "bad_args" && /empty text/.test(e.message),
  );
  await assert.rejects(
    generateVoice({ text: "   ", prompt: "narrator" }),
    (e) => e.klass === "bad_args" && /empty text/.test(e.message),
  );
  await assert.rejects(
    generateVoice({ text: "hello" }),
    (e) => e.klass === "bad_args" && /voice design brief required/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test("generateVoice treats 200 with no body_base64 as transient and names the keys it got", async (t) => {
  installPaiFetch(t, () => jsonResponse({ content_type: "audio/mpeg", request_id: "req_1" }));

  await assert.rejects(
    generateVoice({ text: "hi", prompt: "brief" }),
    (e) => e.klass === "transient"
      && /no body_base64/.test(e.message)
      && /content_type/.test(e.message),
  );
});

test("generateVoice treats body_base64 that decodes to zero bytes as transient", async (t) => {
  installPaiFetch(t, () => jsonResponse({ body_base64: "!!!" }));

  await assert.rejects(
    generateVoice({ text: "hi", prompt: "brief" }),
    (e) => e.klass === "transient" && /bytes are empty/.test(e.message),
  );
});

test("generateVoice maps HTTP 401 to infra", async (t) => {
  installPaiFetch(t, () => jsonResponse({ detail: "invalid api key" }, 401));

  await assert.rejects(
    generateVoice({ text: "hi", prompt: "brief" }),
    (e) => e.klass === "infra" && /PAI 401/.test(e.message) && /invalid api key/.test(e.message),
  );
});
