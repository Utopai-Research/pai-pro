// PAI raw passthrough -> image-generation-pro / image-edit-pro.
//
// The user-facing capability and returned metadata.model are always
// `image-generation-pro`. Internally, refs route to `image-edit-pro`
// because the raw-model contract separates text-to-image from edits.
//
// Source: raw-models.md sections "image-generation-pro" and
// "image-edit-pro". Both accept `size`, `quality`, `n`, and
// `output_format`; edit additionally accepts `image` as a URL string
// for one ref or URL array for two or more refs. Successful sync calls
// return the generated asset URL in outcome.media_urls[0].url.

import { callGenerate, downloadUrlToBuffer, err } from "./pai_client.js";
import { getDefault } from "./model_registry.js";
import {
  IMAGE_PRO_DEFAULT_SIZE,
  IMAGE_PRO_MAX_IMAGE_REFS,
  aspectRatioForImageProSize,
  imageProSizeTier,
  mimeForImageProOutputFormat,
  normalizeImageProOutputFormat,
} from "./image_pro_sizes.js";

const GENERATE_MODEL = "image-generation-pro";
const EDIT_MODEL = "image-edit-pro";
const TIMEOUT_MS = 600_000;

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw err("bad_args", "generateImagePro: prompt required");
  }
  return prompt;
}

function validateSize(size) {
  const value = String(size || IMAGE_PRO_DEFAULT_SIZE);
  const tier = imageProSizeTier(value);
  if (!tier) {
    throw err("bad_args", `generateImagePro: unsupported size "${value}"`);
  }
  return { size: value, imageSize: tier, aspectRatio: aspectRatioForImageProSize(value) };
}

function validateOutputFormat(outputFormat) {
  const normalized = normalizeImageProOutputFormat(outputFormat || "png");
  if (!normalized) {
    throw err("bad_args", `generateImagePro: unsupported output_format "${outputFormat}"`);
  }
  return normalized;
}

function validateRefUrls(refImageUrls) {
  const refs = Array.isArray(refImageUrls)
    ? refImageUrls.filter((u) => typeof u === "string" && u.trim() !== "").map((u) => u.trim())
    : [];
  if (refs.length > IMAGE_PRO_MAX_IMAGE_REFS) {
    throw err("bad_args", `generateImagePro: reference cap exceeded ${refs.length} > ${IMAGE_PRO_MAX_IMAGE_REFS}`);
  }
  for (const refUrl of refs) {
    if (refUrl.startsWith("data:")) {
      throw err("bad_args", "generateImagePro expects URL refs only; use --ref-source-id so local files are tunnel URLs");
    }
    if (!/^https?:\/\//i.test(refUrl)) {
      throw err("bad_args", `generateImagePro ref is not an HTTP(S) URL: ${refUrl}`);
    }
  }
  return refs;
}

function buildPayload({ prompt, size, outputFormat, refs }) {
  const payload = {
    prompt,
    size,
    quality: "high",
    n: 1,
    output_format: outputFormat,
  };
  if (refs.length === 1) payload.image = refs[0];
  else if (refs.length > 1) payload.image = refs;
  return payload;
}

function extractMediaUrl(body) {
  const media = body?.outcome?.media_urls;
  if (Array.isArray(media) && media.length > 0) {
    const first = media[0];
    if (typeof first === "string" && first) return first;
    if (typeof first?.url === "string" && first.url) return first.url;
  }
  if (typeof body?.output_url === "string" && body.output_url) return body.output_url;
  if (typeof body?.outcome?.output_url === "string" && body.outcome.output_url) {
    return body.outcome.output_url;
  }
  return null;
}

function textFragments(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textFragments(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) textFragments(item, out);
  }
  return out;
}

function looksContentFiltered(value) {
  const text = textFragments(value).join(" ").toLowerCase();
  return /\b(content|safety|policy|moderation|moderated|blocked|prohibited|sensitive)\b/.test(text)
    || text.includes("refus");
}

/**
 * Generate one image via PAI raw image pro.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt
 * @param {string}   [opts.size="1024x1024"] exact provider size
 * @param {string}   [opts.outputFormat="png"] "png" or "jpeg"
 * @param {string[]} [opts.refImageUrls] public URL refs from buildProviderRefs
 * @returns {Promise<{
 *   bytes: Buffer,
 *   mime: string,
 *   model: string,
 *   size: string,
 *   imageSize: string,
 *   aspectRatio: string,
 *   durationSeconds: number,
 *   costUsd: null
 * }>}
 */
export async function generateImagePro({
  prompt,
  size = IMAGE_PRO_DEFAULT_SIZE,
  outputFormat = "png",
  refImageUrls = [],
} = {}) {
  const promptText = validatePrompt(prompt);
  const sizeInfo = validateSize(size);
  const normalizedFormat = validateOutputFormat(outputFormat);
  const refs = validateRefUrls(refImageUrls);
  const rawModel = refs.length > 0 ? EDIT_MODEL : GENERATE_MODEL;
  const payload = buildPayload({
    prompt: promptText,
    size: sizeInfo.size,
    outputFormat: normalizedFormat,
    refs,
  });

  const started = Date.now();
  let body;
  try {
    body = await callGenerate({
      model: rawModel,
      payload,
      timeoutMs: TIMEOUT_MS,
      logTag: "pai-image-pro",
    });
  } catch (e) {
    if (looksContentFiltered(e?.message)) {
      throw err("content_filtered", `image-generation-pro content filter: ${e.message}`);
    }
    throw e;
  }

  const mediaUrl = extractMediaUrl(body);
  if (!mediaUrl) {
    if (looksContentFiltered(body)) {
      throw err("content_filtered", "image-generation-pro response indicates a content filter and returned no image URL");
    }
    throw err("transient", "image-generation-pro returned 200 with no media URL");
  }

  const bytes = await downloadUrlToBuffer(mediaUrl, { timeoutMs: 120_000 });
  if (!bytes.length) throw err("transient", "Downloaded image bytes are empty");

  return {
    bytes,
    mime: mimeForImageProOutputFormat(normalizedFormat),
    model: getDefault("image_pro").id,
    size: sizeInfo.size,
    imageSize: sizeInfo.imageSize,
    aspectRatio: sizeInfo.aspectRatio,
    durationSeconds: (Date.now() - started) / 1000,
    costUsd: null,
  };
}

export const __imageProClientInternals = {
  buildPayload,
  extractMediaUrl,
  looksContentFiltered,
};
