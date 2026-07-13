// Unit tests for pai_video_client. Mocks globalThis.fetch for both the
// submit POST and the status-poll GETs, and uses node:test mock timers to
// fast-forward pollStatus's 5s interval sleeps (same pattern as
// pai_assets_client.test.js).

import test from "node:test";
import assert from "node:assert/strict";

import { submitVideo, pollVideo } from "../pai_video_client.js";

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

// pollStatus sleeps 5s (setTimeout) before every poll. Mock timers skip the
// wait without making each test take 5s per poll; setImmediate /
// queueMicrotask etc are left alone so awaited fetch responses still resolve.
function withFakeTimers(fn) {
  return async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      // Eagerly drain any setTimeout that the code under test schedules;
      // process.nextTick lets awaited promises chain before we tick.
      const drain = setInterval(() => {
        process.nextTick(() => {
          try { t.mock.timers.tick(10_000); } catch { /* timers may be reset by t */ }
        });
      }, 5);
      try {
        await fn(t);
      } finally {
        clearInterval(drain);
      }
    } finally {
      t.mock.timers.reset();
    }
  };
}

const SUBMIT_OK = { code: 0, job_id: "job_1", model: "video-generation", status: "QUEUED" };

test("submitVideo sends the raw video-generation payload with defaults and returns the job id", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(SUBMIT_OK));

  const result = await submitVideo({ prompt: "a slow dolly across the harbor" });

  assert.equal(result.taskId, "job_1");
  assert.deepEqual(result.raw, SUBMIT_OK);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pai.test/api/v1/submit");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    model: "video-generation",
    payload: {
      model: "pai-pro-video-endpoint-01",
      content: [{ type: "text", text: "a slow dolly across the harbor" }],
      generate_audio: true,
      ratio: "16:9",
      duration: 15,
      resolution: "720p",
      watermark: false,
    },
  });
});

test("submitVideo orders reference parts after the prompt with the right roles", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(SUBMIT_OK));

  await submitVideo({
    prompt: "animate the storyboard",
    duration: "8", // CLI flags arrive as strings — Number() coercion is load-bearing
    aspectRatio: "9:16",
    resolution: "1080p",
    generateAudio: false,
    imageAssetIds: ["img-1", "img-2"],
    audioAssetIds: ["aud-1"],
    videoAssetIds: ["vid-1"],
  });

  const payload = calls[0].body.payload;
  assert.equal(payload.duration, 8);
  assert.equal(payload.ratio, "9:16");
  assert.equal(payload.resolution, "1080p");
  assert.equal(payload.generate_audio, false);
  assert.deepEqual(payload.content, [
    { type: "text", text: "animate the storyboard" },
    { type: "image_url", image_url: { url: "asset://img-1" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "asset://img-2" }, role: "reference_image" },
    { type: "audio_url", audio_url: { url: "asset://aud-1" }, role: "reference_audio" },
    { type: "video_url", video_url: { url: "asset://vid-1" }, role: "reference_video" },
  ]);
});

test("submitVideo rejects an empty prompt before the provider call", async (t) => {
  const calls = installPaiFetch(t, () => jsonResponse(SUBMIT_OK));

  await assert.rejects(
    submitVideo({ prompt: "   " }),
    (e) => e.klass === "bad_args" && /empty prompt/.test(e.message),
  );
  await assert.rejects(
    submitVideo(),
    (e) => e.klass === "bad_args" && /empty prompt/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test("submitVideo classifies a non-zero submit envelope (queue full → rate_limited)", async (t) => {
  installPaiFetch(t, () => jsonResponse({ code: 1004, message: "queue is full", retry_after: 30 }));

  await assert.rejects(
    submitVideo({ prompt: "x" }),
    (e) => e.klass === "rate_limited" && /queue full/.test(e.message) && e.retryAfterSec === 30,
  );
});

test("pollVideo polls to SUCCESS and surfaces the rehosted output_url", withFakeTimers(async (t) => {
  const statuses = [
    { status: "QUEUED" },
    { status: "PROCESSING" },
    {
      status: "SUCCESS",
      output_url: "https://cdn.pai.test/final.mp4",
      raw_response: { video_url: "https://upstream.test/signed.mp4" },
    },
  ];
  let poll = 0;
  const calls = installPaiFetch(t, () => jsonResponse(statuses[Math.min(poll++, statuses.length - 1)]));

  const progress = [];
  const result = await pollVideo("job_1", { onProgress: (p) => progress.push(p.status) });

  // output_url (PAI's long-lived rehost) wins over the upstream signed URL.
  assert.equal(result.videoUrl, "https://cdn.pai.test/final.mp4");
  assert.deepEqual(result.raw, statuses[2]);
  assert.equal(typeof result.durationSeconds, "number");
  assert.ok(result.durationSeconds >= 0);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://pai.test/api/v1/task/status/job_1");
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(progress, ["QUEUED", "PROCESSING", "SUCCESS"]);
}));

test("pollVideo falls back to raw_response video URLs when output_url is missing", withFakeTimers(async (t) => {
  const byJob = {
    job_flat: { status: "SUCCESS", raw_response: { video_url: "https://upstream.test/flat.mp4" } },
    job_nested: { status: "SUCCESS", raw_response: { content: { video_url: "https://upstream.test/nested.mp4" } } },
  };
  installPaiFetch(t, ({ url }) => jsonResponse(byJob[url.split("/").pop()]));

  assert.equal((await pollVideo("job_flat")).videoUrl, "https://upstream.test/flat.mp4");
  assert.equal((await pollVideo("job_nested")).videoUrl, "https://upstream.test/nested.mp4");
}));

test("pollVideo throws infra when SUCCESS carries no video URL", withFakeTimers(async (t) => {
  installPaiFetch(t, () => jsonResponse({ status: "SUCCESS", raw_response: { note: "no url anywhere" } }));

  await assert.rejects(
    pollVideo("job_nourl"),
    (e) => e.klass === "infra" && /no video URL/.test(e.message) && /job_nourl/.test(e.message),
  );
}));

test("pollVideo classifies a FAILED content moderation status as content_filtered", withFakeTimers(async (t) => {
  installPaiFetch(t, () => jsonResponse({
    status: "FAILED",
    error_category: "content",
    error_message: "output flagged by moderation",
  }));

  await assert.rejects(
    pollVideo("job_1"),
    (e) => e.klass === "content_filtered"
      && /content moderation/.test(e.message)
      && /output flagged by moderation/.test(e.message),
  );
}));

test("pollVideo classifies FAILED_REJECTED client_input as bad_args", withFakeTimers(async (t) => {
  installPaiFetch(t, () => jsonResponse({
    status: "FAILED_REJECTED",
    error_category: "client_input",
    error_message: "unsupported ratio",
  }));

  await assert.rejects(
    pollVideo("job_1"),
    (e) => e.klass === "bad_args" && /client_input/.test(e.message) && /unsupported ratio/.test(e.message),
  );
}));
