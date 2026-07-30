// Music generation client.
//
// Unlike the image / video / voice / asset capabilities, music does not
// route through the shared PAI media API in pai_client.js: that client
// pins authentication (PAI_KEY) and routing (POST /api/v1/generate) to
// the PAI deploy, so it can't reach a music-generation endpoint. This
// module is the media extension boundary for the "music" kind — it owns
// its own base URL selection (global + CN regions), its own Bearer
// authentication, and its own response decoding.
//
// The wire shape is a single synchronous JSON call:
//
//   POST <base>/music_generation
//   Authorization: Bearer <MINIMAX_API_KEY>
//   Content-Type: application/json
//   { model, prompt?, lyrics?, output_format?, ... }
//
// The response is a JSON envelope. Success is signalled by
// base_resp.status_code === 0; the generation state lives in data.status
// (1 = in progress, 2 = completed) and the audio itself in data.audio —
// either a hex-encoded byte string (output_format "hex") or a temporary
// download URL valid ~24h (output_format "url"). There is no async job id
// or status-poll endpoint: a completed sync call returns the audio inline.
//
// Field mapping from the JS options object to the request body:
//   prompt         -> prompt          (style / mood brief)
//   lyrics         -> lyrics          (song text; omit for instrumental)
//   isInstrumental -> is_instrumental
//   outputFormat   -> output_format   ("url" | "hex")
//   audioSetting   -> audio_setting   ({ sample_rate, bitrate, format, ... })
//   lyricsOptimizer-> lyrics_optimizer
//   stream         -> stream          (hex output only)
//   audioUrl       -> audio_url       (cover: reference track by URL)
//   audioBase64    -> audio_base64    (cover: reference track inline)
//   coverFeatureId -> cover_feature_id
//   aigcWatermark  -> aigc_watermark  (cn_zh region only)

import { err } from "./pai_client.js";
import { getDefault } from "./model_registry.js";

// Per-region music_generation base URL. The origin differs between the
// global (.io) and mainland-China (.com) deployments; the path is the
// same. MINIMAX_API_BASE overrides the base for staging / self-hosting,
// mirroring PAI_API_BASE in pai_client.js.
const REGION_BASES = {
  global_en: "https://api.minimax.io/v1",
  cn_zh: "https://api.minimaxi.com/v1",
};
const DEFAULT_REGION = "global_en";
const MUSIC_PATH = "music_generation";
const TIMEOUT_MS = 120_000;

// Request fields accepted by the music_generation endpoint. Anything
// outside this set is dropped rather than forwarded, so a typo in a
// caller can't smuggle an unknown key onto the wire.
const REQUEST_FIELDS = new Set([
  "model",
  "prompt",
  "lyrics",
  "stream",
  "output_format",
  "audio_setting",
  "lyrics_optimizer",
  "is_instrumental",
  "audio_url",
  "audio_base64",
  "cover_feature_id",
]);

// aigc_watermark is only honoured on the cn_zh deployment; the global
// endpoint rejects unknown fields, so it's gated by region.
const REGIONAL_FIELDS = {
  global_en: new Set(),
  cn_zh: new Set(["aigc_watermark"]),
};

const OUTPUT_FORMATS = new Set(["url", "hex"]);
const AUDIO_MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/L16",
};

const STATUS_IN_PROGRESS = 1;
const STATUS_COMPLETED = 2;

export function musicRegion() {
  const raw = String(process.env.MINIMAX_REGION ?? "").trim();
  if (!raw) return DEFAULT_REGION;
  if (!REGION_BASES[raw]) {
    throw err(
      "bad_args",
      `MINIMAX_REGION="${raw}" is not a known region (expected ${Object.keys(REGION_BASES).join(" | ")})`,
    );
  }
  return raw;
}

export function musicBaseUrl(region = musicRegion()) {
  const override = String(process.env.MINIMAX_API_BASE ?? "").trim().replace(/\/+$/, "");
  return override || REGION_BASES[region];
}

function musicToken() {
  const t = process.env.MINIMAX_API_KEY;
  if (!t) throw err("infra", "MINIMAX_API_KEY not set in env");
  return t;
}

// Map a non-zero base_resp.status_code to a failure class. The envelope
// returns HTTP 200 with a business code even on rejection, so this runs
// on otherwise-successful responses. Unknown codes fall back to infra so
// the caller retries the operator rather than the arguments.
function classifyBaseResp(statusCode, statusMsg) {
  const msg = statusMsg || `status_code=${statusCode}`;
  switch (statusCode) {
    case 1002:
      return err("rate_limited", `music generation rate limited: ${msg}`);
    case 1004:
      return err("infra", `music generation auth failed: ${msg}`);
    case 1008:
      return err("infra", `music generation insufficient balance: ${msg}`);
    case 1027:
      return err("content_filtered", `music generation blocked by content policy: ${msg}`);
    case 2013:
      return err("bad_args", `music generation invalid params: ${msg}`);
    default:
      return err("infra", `music generation failed (status_code=${statusCode}): ${msg}`);
  }
}

// Map an HTTP-level failure (non-2xx). Mirrors the class taxonomy the
// PAI clients use so _cli.js failure banners stay consistent.
function classifyHttpFailure(status, errMsg) {
  if (status === 400 || status === 422) return err("bad_args", `music ${status}: ${errMsg}`);
  if (status === 401) return err("infra", `music 401 (auth): ${errMsg}`);
  if (status === 402) return err("infra", `music 402 (insufficient balance): ${errMsg}`);
  if (status === 408) return err("transient", `music 408 (timeout): ${errMsg}`);
  if (status === 429) return err("rate_limited", `music 429: ${errMsg}`);
  if (status === 502 || status === 503) return err("transient", `music ${status}: ${errMsg}`);
  if (status >= 400 && status < 500) return err("bad_args", `music ${status}: ${errMsg}`);
  return err("transient", `music ${status}: ${errMsg}`);
}

function buildBody(region, opts) {
  const body = {};
  const put = (field, value) => {
    if (value === undefined || value === null) return;
    if (!REQUEST_FIELDS.has(field) && !REGIONAL_FIELDS[region].has(field)) return;
    body[field] = value;
  };

  put("model", opts.model || getDefault("music").id);
  put("prompt", opts.prompt);
  put("lyrics", opts.lyrics);
  put("stream", opts.stream);
  put("output_format", opts.outputFormat);
  put("audio_setting", opts.audioSetting);
  put("lyrics_optimizer", opts.lyricsOptimizer);
  put("is_instrumental", opts.isInstrumental);
  put("audio_url", opts.audioUrl);
  put("audio_base64", opts.audioBase64);
  put("cover_feature_id", opts.coverFeatureId);
  // Regional-only; dropped by `put` on global_en.
  put("aigc_watermark", opts.aigcWatermark);

  return body;
}

/**
 * Generate one track via music_generation.
 *
 * @param {Object}  opts
 * @param {string}  [opts.model]          defaults to getDefault("music").id
 * @param {string}  [opts.prompt]         style / mood brief
 * @param {string}  [opts.lyrics]         song text (omit for instrumental)
 * @param {boolean} [opts.isInstrumental]
 * @param {"url"|"hex"} [opts.outputFormat="url"]
 * @param {object}  [opts.audioSetting]   { sample_rate, bitrate, format, ... }
 * @param {boolean} [opts.lyricsOptimizer]
 * @param {boolean} [opts.stream]         hex output only
 * @param {string}  [opts.audioUrl]       cover: reference track by URL
 * @param {string}  [opts.audioBase64]    cover: reference track inline
 * @param {string}  [opts.coverFeatureId]
 * @param {boolean} [opts.aigcWatermark]  cn_zh region only
 *
 * @returns {Promise<{
 *   audio: Buffer|string,   // Buffer when outputFormat "hex", URL string when "url"
 *   format: "hex"|"url",
 *   mime: string|null,      // set for hex output; null for a URL
 *   model: string,
 *   region: string,
 *   status: number,
 *   statusCode: number,
 *   wallClockSec: number,
 * }>}
 *
 * @throws  classified Error (.klass): bad_args / content_filtered /
 *          rate_limited / infra / transient / transient_exhausted
 */
export async function generateMusic(opts = {}) {
  const region = musicRegion();
  const outputFormat = opts.outputFormat ?? "url";
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    throw err("bad_args", `generateMusic: output_format must be one of ${[...OUTPUT_FORMATS].join(" | ")}`);
  }
  if (opts.stream && outputFormat !== "hex") {
    throw err("bad_args", "generateMusic: streaming responses are only available with output_format \"hex\"");
  }

  const hasCoverRef = Boolean(opts.audioUrl || opts.audioBase64 || opts.coverFeatureId);
  const hasBrief = Boolean(
    (typeof opts.prompt === "string" && opts.prompt.trim())
    || (typeof opts.lyrics === "string" && opts.lyrics.trim()),
  );
  if (!hasBrief && !hasCoverRef) {
    throw err("bad_args", "generateMusic: provide a prompt, lyrics, or a cover reference");
  }

  const body = buildBody(region, { ...opts, outputFormat });
  const url = `${musicBaseUrl(region)}/${MUSIC_PATH}`;
  // Resolve the token before the request so a missing key surfaces as
  // its own infra error rather than being swallowed by the network-error
  // catch below.
  const token = musicToken();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw err("transient", `music generation aborted after ${TIMEOUT_MS}ms`);
    }
    throw err("transient", `Network error calling music generation: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const errMsg = parsed?.base_resp?.status_msg || rawBody.slice(0, 300) || `HTTP ${res.status}`;
    throw classifyHttpFailure(res.status, errMsg);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw err("transient", `music generation returned non-JSON 200: ${rawBody.slice(0, 200)}`);
  }

  const statusCode = parsed?.base_resp?.status_code;
  if (statusCode !== 0) {
    throw classifyBaseResp(statusCode, parsed?.base_resp?.status_msg);
  }

  const data = parsed?.data ?? {};
  const status = Number(data.status);
  if (status === STATUS_IN_PROGRESS) {
    // No task id / poll endpoint is exposed for music, so a sync call
    // that is still in progress can't be resumed — surface it as
    // transient so the caller re-runs.
    throw err("transient", "music generation still in progress with no poll endpoint to resume");
  }
  if (status !== STATUS_COMPLETED) {
    throw err("transient", `music generation returned unexpected data.status=${data.status}`);
  }

  const audio = data.audio;
  if (typeof audio !== "string" || !audio) {
    throw err("transient", "music generation completed with no data.audio");
  }

  const wallClockSec = (Date.now() - started) / 1000;
  const model = body.model;

  if (outputFormat === "hex") {
    const bytes = Buffer.from(audio, "hex");
    if (!bytes.length) {
      throw err("transient", "Decoded music hex bytes are empty");
    }
    const fmt = String(body.audio_setting?.format || "mp3").toLowerCase();
    return {
      audio: bytes,
      format: "hex",
      mime: AUDIO_MIME[fmt] ?? "audio/mpeg",
      model,
      region,
      status,
      statusCode,
      wallClockSec,
    };
  }

  return {
    audio,
    format: "url",
    mime: null,
    model,
    region,
    status,
    statusCode,
    wallClockSec,
  };
}
