// PAI raw passthrough → image-generation.
//
// The wire shape is the upstream image model's native REST contract; PAI
// forwards `payload` byte-for-byte. Returns
// { bytes, mime, model, durationSeconds, costUsd } for the CLI.
//
// Reference: raw-models.md § "image-generation".
//
// Refs are URL-only — every entry in `refImageUrls` is sent as a
// `fileData.fileUri` part. The upstream model fetches each URL
// server-side. data: URIs are rejected at the boundary; if the caller
// needs to pass a canvas-local file, they should route through
// buildProviderRefs() with `providerRequiresPublicUrl: true` so the
// tunnel-rewrite step runs first. Inline data has a ~5-ref cap upstream;
// URL refs are validated to 16.
//
// Safety blocks come back inside the 200 body (not as a 4xx). We detect
// them by inspecting candidates[0].finishReason and
// promptFeedback.blockReason and surface as content_filtered.

import { callGenerate, err } from "./pai_client.js";
import { getDefault } from "./model_registry.js";

const MODEL = "image-generation";
const TIMEOUT_MS = 120_000; // PAI sync ceiling is 120s; typical return is 10-30s.

// BLOCK_ONLY_HIGH on every safety category — the loosest the upstream
// model allows. Tighter thresholds would unexpectedly filter prompts the
// agent considers benign.
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",         threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_ONLY_HIGH" },
];

function buildContents(prompt, refImageUrls) {
  const promptStr = String(prompt);
  const refs = Array.isArray(refImageUrls) ? refImageUrls.filter((u) => typeof u === "string" && u) : [];
  const parts = [];
  // Refs first so the model sees them before the instructional text.
  for (const ref of refs) {
    if (ref.startsWith("data:")) {
      throw err(
        "bad_args",
        "pai_image_client expects URL refs only — got a data: URI. Route through "
        + "buildProviderRefs({ providerRequiresPublicUrl: true }) so local files "
        + "get rewritten to the cloudflared tunnel URL first.",
      );
    }
    parts.push({ fileData: { fileUri: ref } });
  }
  parts.push({ text: promptStr });
  return [{ role: "user", parts }];
}

function buildImageConfig(aspectRatio, imageSize) {
  const config = {};
  if (aspectRatio) config.aspectRatio = aspectRatio;
  if (imageSize) config.imageSize = imageSize;
  return config;
}

// Walk the response and pull every inline image. Returns array of
// { mimeType, data } so callers can pick the first or report all.
function extractInlineImages(body) {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  const out = [];
  for (const cand of candidates) {
    const parts = cand?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part?.inlineData;
      if (!inline || typeof inline.data !== "string" || !inline.data) continue;
      out.push({
        mimeType: typeof inline.mimeType === "string" && inline.mimeType
          ? inline.mimeType
          : "image/png",
        data: inline.data,
      });
    }
  }
  return out;
}

// Detect upstream safety / policy blocks. Returns a string reason
// when the response indicates a block, or null when it looks healthy.
function detectSafetyBlock(body) {
  const promptBlock = body?.promptFeedback?.blockReason;
  if (typeof promptBlock === "string" && promptBlock) return `promptFeedback.blockReason=${promptBlock}`;
  const cand = body?.candidates?.[0];
  if (cand) {
    const reason = String(cand.finishReason || "").toUpperCase();
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "IMAGE_SAFETY") {
      return `candidates[0].finishReason=${cand.finishReason}`;
    }
    if (reason === "BLOCKLIST" || reason === "RECITATION" || reason === "SPII") {
      return `candidates[0].finishReason=${cand.finishReason}`;
    }
  }
  return null;
}

/**
 * Generate one image via PAI raw `image-generation`.
 *
 * @param {Object}    opts
 * @param {string}    opts.prompt        text-to-image prompt
 * @param {string}    [opts.aspectRatio="16:9"]
 * @param {string}    [opts.imageSize="2K"]   "1K" or "2K"
 * @param {string[]}  [opts.refImageUrls]  parallel to provider-side refs;
 *                                         each entry MUST be a publicly-
 *                                         fetchable HTTPS URL (data: URIs
 *                                         are rejected at the boundary)
 *
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   durationSeconds: number,
 *   costUsd: null
 * }>}
 *
 * @throws  classified Error (.klass): bad_args / content_filtered /
 *          rate_limited / infra / transient / transient_exhausted
 */
export async function generateImage({ prompt, aspectRatio, imageSize, refImageUrls, projectId } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateImage: prompt required");
  }
  const payload = {
    contents: buildContents(prompt, refImageUrls),
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: buildImageConfig(aspectRatio, imageSize),
    },
    safetySettings: SAFETY_SETTINGS,
  };

  const started = Date.now();
  const body = await callGenerate({
    model: MODEL,
    payload,
    timeoutMs: TIMEOUT_MS,
    logTag: "pai-image",
    projectId,
  });

  // Upstream safety blocks land as 200 OK with no image. Check before
  // diving into extractInlineImages — the message is more actionable when
  // it names the block reason.
  const block = detectSafetyBlock(body);
  if (block) {
    throw err("content_filtered", `image-generation safety block: ${block}`);
  }

  const images = extractInlineImages(body);
  if (!images.length) {
    // 200 OK with no images: usually silent moderation, but unfetchable
    // refs produce the same shape. Name the refs so the caller can tell
    // the two apart.
    const refHint = (refImageUrls?.length ?? 0) > 0
      ? ` (with refs: ${refImageUrls.join(", ")} — verify these are publicly fetchable)`
      : "";
    throw err(
      "content_filtered",
      `image-generation returned 200 with no inline image${refHint} — silent moderation or unfetchable refs; reword the prompt or check the refs`,
    );
  }

  const { mimeType, data } = images[0];
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) {
    throw err("transient", "Decoded image bytes are empty");
  }
  return {
    bytes,
    mime: mimeType || "image/png",
    model: getDefault("image").id,
    durationSeconds: (Date.now() - started) / 1000,
    costUsd: null, // PAI raw passthrough doesn't echo cost; agent shows model_registry's estimate
  };
}
