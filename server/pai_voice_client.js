// PAI raw passthrough → tts.
//
// The wire shape is an OpenAI-compatible /v1/audio/speech body forwarded
// verbatim by PAI; the response is a JSON envelope wrapping the raw
// audio as `body_base64` so it can travel over JSON.
//
// Reference: raw-models.md § "tts".
//
// Field mapping from generate_voice.js args:
//   text   → payload.input         (the line to be spoken)
//   prompt → payload.instructions  (the voice design brief — timbre,
//                                   pace, accent, etc.)

import { callGenerate, err } from "./pai_client.js";

const MODEL = "tts";
const UPSTREAM_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";
const TIMEOUT_MS = 60_000;

/**
 * Generate one MP3 via PAI raw `tts`.
 *
 * @param {Object} opts
 * @param {string} opts.text    line to be spoken
 * @param {string} opts.prompt  voice design brief
 *
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   durationSeconds: number,
 *   costUsd: null,
 *   audioDurationSec: null,
 *   wallClockSec: number,
 *   predictionId: null,
 * }>}
 *
 * @throws  classified Error (.klass): bad_args / content_filtered /
 *          rate_limited / infra / transient / transient_exhausted
 */
export async function generateVoice({ text, prompt, projectId } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw err("bad_args", "generateVoice: empty text");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateVoice: empty prompt (voice design brief required)");
  }

  const payload = {
    model: UPSTREAM_MODEL,
    input: String(text),
    task_type: "VoiceDesign",
    instructions: String(prompt),
    response_format: "mp3",
  };

  const started = Date.now();
  const body = await callGenerate({
    model: MODEL,
    payload,
    timeoutMs: TIMEOUT_MS,
    logTag: "pai-voice",
    projectId,
  });

  const b64 = body?.body_base64;
  if (typeof b64 !== "string" || !b64) {
    throw err(
      "transient",
      `PAI tts returned 200 with no body_base64 (got keys: ${Object.keys(body || {}).join(", ").slice(0, 200)})`,
    );
  }
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) {
    throw err("transient", "Decoded PAI tts bytes are empty");
  }
  const mime = typeof body?.content_type === "string" && body.content_type
    ? body.content_type
    : "audio/mpeg";
  const wallClockSec = (Date.now() - started) / 1000;
  return {
    bytes,
    mime,
    model: UPSTREAM_MODEL,
    durationSeconds: wallClockSec,
    costUsd: null,
    audioDurationSec: null, // envelope doesn't include duration; would need to probe the MP3
    wallClockSec,
    predictionId: null,
  };
}
