import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { generateMusic } from "../minimax_music_client.js";

const HEX_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3\x04\x00"

function okEnvelope({ audio, status = 2, statusCode = 0, statusMsg = "success" }) {
  return {
    data: { audio, status },
    base_resp: { status_code: statusCode, status_msg: statusMsg },
  };
}

function makeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/music_generation") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const parsed = raw ? JSON.parse(raw) : {};
        requests.push({ body: parsed, auth: req.headers.authorization });
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

async function withMusicServer(t, handler, { region } = {}) {
  const prior = {
    key: process.env.MINIMAX_API_KEY,
    base: process.env.MINIMAX_API_BASE,
    region: process.env.MINIMAX_REGION,
  };
  const srv = await makeServer(handler);
  process.env.MINIMAX_API_KEY = "mm_test_key";
  process.env.MINIMAX_API_BASE = srv.url;
  if (region === undefined) delete process.env.MINIMAX_REGION;
  else process.env.MINIMAX_REGION = region;
  t.after(() => {
    for (const [envName, envKey] of [
      ["MINIMAX_API_KEY", "key"],
      ["MINIMAX_API_BASE", "base"],
      ["MINIMAX_REGION", "region"],
    ]) {
      if (prior[envKey] === undefined) delete process.env[envName];
      else process.env[envName] = prior[envKey];
    }
    return new Promise((resolve) => srv.server.close(resolve));
  });
  return srv;
}

test("generateMusic defaults to the registry model and url output", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "https://cdn.example/track.mp3" })));
  });

  const result = await generateMusic({ prompt: "warm lofi beat" });

  assert.equal(result.format, "url");
  assert.equal(result.audio, "https://cdn.example/track.mp3");
  assert.equal(result.mime, null);
  assert.equal(result.model, "music-3.0");
  assert.equal(result.region, "global_en");
  assert.equal(result.status, 2);
  assert.equal(result.statusCode, 0);

  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].auth, "Bearer mm_test_key");
  assert.equal(srv.requests[0].body.model, "music-3.0");
  assert.equal(srv.requests[0].body.prompt, "warm lofi beat");
  assert.equal(srv.requests[0].body.output_format, "url");
});

test("generateMusic decodes hex output into bytes with the right mime", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: HEX_BYTES.toString("hex") })));
  });

  const result = await generateMusic({
    prompt: "cinematic build",
    outputFormat: "hex",
    audioSetting: { format: "wav" },
  });

  assert.equal(result.format, "hex");
  assert.deepEqual(result.audio, HEX_BYTES);
  assert.equal(result.mime, "audio/wav");
  assert.equal(srv.requests[0].body.output_format, "hex");
  assert.deepEqual(srv.requests[0].body.audio_setting, { format: "wav" });
});

test("generateMusic forwards lyrics and cover references, dropping unknown keys", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "https://cdn.example/cover.mp3" })));
  });

  await generateMusic({
    lyrics: "[verse] ...",
    audioUrl: "https://cdn.example/ref.mp3",
    coverFeatureId: "feat_123",
    isInstrumental: false,
    lyricsOptimizer: true,
    // Not a recognised request field — must be dropped.
    somethingElse: "nope",
  });

  const body = srv.requests[0].body;
  assert.equal(body.lyrics, "[verse] ...");
  assert.equal(body.audio_url, "https://cdn.example/ref.mp3");
  assert.equal(body.cover_feature_id, "feat_123");
  assert.equal(body.lyrics_optimizer, true);
  assert.equal(body.is_instrumental, false);
  assert.equal(body.somethingElse, undefined);
});

test("generateMusic gates aigc_watermark to the cn_zh region", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "https://cdn.example/cn.mp3" })));
  }, { region: "cn_zh" });

  const result = await generateMusic({ prompt: "guzheng solo", aigcWatermark: true });
  assert.equal(result.region, "cn_zh");
  assert.equal(srv.requests[0].body.aigc_watermark, true);
});

test("generateMusic drops aigc_watermark on the global region", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "https://cdn.example/g.mp3" })));
  });

  await generateMusic({ prompt: "guzheng solo", aigcWatermark: true });
  assert.equal(srv.requests[0].body.aigc_watermark, undefined);
});

test("generateMusic maps base_resp business codes to error classes", async (t) => {
  const cases = [
    [1002, "rate_limited"],
    [1004, "infra"],
    [1008, "infra"],
    [1027, "content_filtered"],
    [2013, "bad_args"],
    [9999, "infra"],
  ];
  for (const [code, klass] of cases) {
    const srv = await withMusicServer(t, ({ res }) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: {},
        base_resp: { status_code: code, status_msg: `code ${code}` },
      }));
    });
    await assert.rejects(
      generateMusic({ prompt: "x" }),
      (e) => e.klass === klass,
      `status_code ${code} should map to ${klass}`,
    );
  }
});

test("generateMusic treats a missing audio field as transient", async (t) => {
  await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "" })));
  });
  await assert.rejects(
    generateMusic({ prompt: "x" }),
    (e) => e.klass === "transient" && /no data\.audio/.test(e.message),
  );
});

test("generateMusic treats an in-progress status as transient (no poll endpoint)", async (t) => {
  await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "hex", status: 1 })));
  });
  await assert.rejects(
    generateMusic({ prompt: "x", outputFormat: "hex" }),
    (e) => e.klass === "transient" && /in progress/.test(e.message),
  );
});

test("generateMusic maps HTTP failures to error classes", async (t) => {
  await withMusicServer(t, ({ res }) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "bad token" } }));
  });
  await assert.rejects(
    generateMusic({ prompt: "x" }),
    (e) => e.klass === "infra" && /401/.test(e.message),
  );
});

test("generateMusic validates arguments before calling the endpoint", async (t) => {
  const srv = await withMusicServer(t, ({ res }) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(okEnvelope({ audio: "https://cdn.example/x.mp3" })));
  });

  await assert.rejects(
    generateMusic({}),
    (e) => e.klass === "bad_args" && /prompt, lyrics, or a cover/.test(e.message),
  );
  await assert.rejects(
    generateMusic({ prompt: "x", outputFormat: "flac" }),
    (e) => e.klass === "bad_args" && /output_format/.test(e.message),
  );
  await assert.rejects(
    generateMusic({ prompt: "x", stream: true, outputFormat: "url" }),
    (e) => e.klass === "bad_args" && /streaming/.test(e.message),
  );
  assert.equal(srv.requests.length, 0);
});

test("generateMusic requires MINIMAX_API_KEY", async (t) => {
  const prior = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  t.after(() => {
    if (prior === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = prior;
  });
  await assert.rejects(
    generateMusic({ prompt: "x" }),
    (e) => e.klass === "infra" && /MINIMAX_API_KEY/.test(e.message),
  );
});
