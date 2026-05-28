// Exact-size contract for PAI raw image-generation-pro / image-edit-pro.
// Source: open-pai raw-models.md sections "image-generation-pro" and
// "image-edit-pro". The provider accepts `size` only; aspect_ratio and
// image_size below are derived display metadata for pai-pro.

export const IMAGE_PRO_SIZE_TIERS = Object.freeze({
  "1K": Object.freeze([
    "1024x1024",
    "1280x720",
    "720x1280",
    "1248x832",
    "832x1248",
    "1152x864",
    "864x1152",
    "1120x896",
    "896x1120",
    "1568x672",
  ]),
  "2K": Object.freeze([
    "1920x1920",
    "2560x1440",
    "1440x2560",
    "2352x1568",
    "1568x2352",
    "2240x1680",
    "1680x2240",
    "2160x1728",
    "1728x2160",
    "2912x1248",
  ]),
  "4K": Object.freeze([
    "2880x2880",
    "3840x2160",
    "2160x3840",
    "3504x2336",
    "2336x3504",
    "3264x2448",
    "2448x3264",
    "3200x2560",
    "2560x3200",
    "3808x1632",
  ]),
});

export const IMAGE_PRO_SUPPORTED_SIZES = Object.freeze(
  Object.values(IMAGE_PRO_SIZE_TIERS).flat(),
);

export const IMAGE_PRO_DEFAULT_SIZE = "1024x1024";
export const IMAGE_PRO_OUTPUT_FORMATS = Object.freeze(["png", "jpeg"]);
export const IMAGE_PRO_MAX_IMAGE_REFS = 32;

const SIZE_TO_TIER = new Map();
for (const [tier, sizes] of Object.entries(IMAGE_PRO_SIZE_TIERS)) {
  for (const size of sizes) SIZE_TO_TIER.set(size, tier);
}

const COST_BY_TIER = Object.freeze({
  "1K": 0.26,
  "2K": 0.45,
  "4K": 0.77,
});

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function imageProSizeTier(size) {
  return SIZE_TO_TIER.get(String(size || "")) ?? null;
}

export function imageProCostBySize(params = {}) {
  const size = params.size;
  const tier = imageProSizeTier(size);
  return tier ? COST_BY_TIER[tier] : null;
}

export function aspectRatioForImageProSize(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const div = gcd(width, height);
  return `${width / div}:${height / div}`;
}

export function normalizeImageProOutputFormat(format = "png") {
  const value = String(format || "").trim().toLowerCase();
  return IMAGE_PRO_OUTPUT_FORMATS.includes(value) ? value : null;
}

export function mimeForImageProOutputFormat(format = "png") {
  const normalized = normalizeImageProOutputFormat(format);
  if (normalized === "jpeg") return "image/jpeg";
  if (normalized === "png") return "image/png";
  return null;
}
