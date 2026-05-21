// Single source of truth for the models pai-pro uses, indexed by
// kind. Adding a model is one edit here; the provider clients import
// getDefault(kind).id rather than inlining the string. The renderer
// reads MODELS as JSON via the viewer's GET /models route — adding a
// model auto-flows its label to canvas card chrome and the expand
// overlay, no separate UI edit.
//
// Every capability routes through PAI Lite raw passthrough; the
// `provider` field is therefore always `"pai"` and is kept only so
// routes/system.js + web/lib/useModels.tsx don't need a schema change.
//
// Schema per entry:
//   id              PAI raw model name (what we pass as `model` on
//                   POST /api/v1/generate or /submit). Also stamped
//                   onto canvas node metadata.model.
//   provider        always "pai" in this codebase.
//   kind            "image" | "video" | "voice" | "asset"
//   label           human-readable name (UI-friendly).
//   cost_approx_usd number, function(params) -> number, or null when
//                   unknown. Display-only; the actual freeze/charge
//                   amount is whatever PAI bills. Used by the agent
//                   for stage-gate cost previews.
//   capabilities    tags for future routing / UI filters.
//   default_params  sane defaults (informational; CLI parseArgs owns
//                   runtime defaults).
//   notes           one-liner for humans skimming the file.
//   hidden          optional bool. true → omitted from GET /models
//                   so it doesn't render as a card. Used by the
//                   "asset" internal pricing row.
//
// v1 invariant: exactly one model per kind. getDefault() looks it up
// directly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

// Load .env defensively. local_viewer.js calls config() after it has
// already imported this module (ES modules evaluate imports before the
// importer's body), so without this the env overrides below would be
// undefined when MODELS initializes. dotenv.config() does not overwrite
// already-set vars, so re-loading is safe.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

// ── Cost functions ──────────────────────────────────────────────────

// Image standard tier. Per-image pricing keyed off the imageSize
// dimension.
function imageCostBySize(params = {}) {
  const size = String(params.image_size || params.imageSize || "2K").toLowerCase();
  if (size === "1k") return 0.07;
  if (size === "2k") return 0.10;
  if (size === "4k") return 0.15;
  return 0.10; // 2K default
}

// Video tier. Per-second pricing scaled by resolution.
function videoCostByResAndDuration(params = {}) {
  const res = String(params.resolution || "720p").toLowerCase();
  const dur = Number(params.duration) || 15;
  const perSec = res === "1080p" ? 0.44 : res === "480p" ? 0.08 : 0.20;
  return +(dur * perSec).toFixed(3);
}

// Voice tier. Charged per 500 characters of input, rounded up
// (100 chars → $0.01, 501 chars → $0.02). Caller passes `text` or
// `text_chars` so this function works both at stage time (before the
// CLI knows the audio duration) and at re-quote time.
function voiceCostByChars(params = {}) {
  const chars = typeof params.text_chars === "number"
    ? params.text_chars
    : (typeof params.text === "string" ? params.text.length : 0);
  if (chars <= 0) return 0.01; // minimum charge — even empty / 1-char buys one block
  return +(Math.ceil(chars / 500) * 0.01).toFixed(2);
}

// ── Registry ────────────────────────────────────────────────────────

export const MODELS = [
  // ───────────── image (standard tier) ─────────────
  {
    id: "image-generation",
    provider: "pai",
    kind: "image",
    label: "Image (image-generation)",
    cost_approx_usd: imageCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref"],
    default_params: { aspect_ratio: "16:9", image_size: "2K" },
    notes: "Sync image generation via PAI raw passthrough. Drafts, illustrative, stylized. ~10-30s.",
  },

  // ───────────── video ─────────────
  {
    id: "video-generation",
    provider: "pai",
    kind: "video",
    label: "Video (video-generation)",
    cost_approx_usd: videoCostByResAndDuration,
    capabilities: ["text-to-video", "image-to-video", "video-to-video", "audio"],
    default_params: { duration: 15, aspect_ratio: "16:9", resolution: "720p", generate_audio: true },
    notes: "Async video generation via PAI raw passthrough. Refs require public URLs (tunnel). ~2-4 min. Real money.",
  },

  // ───────────── voice ─────────────
  {
    id: "tts",
    provider: "pai",
    kind: "voice",
    label: "Voice (tts)",
    cost_approx_usd: voiceCostByChars,
    capabilities: ["voice-design", "tts"],
    default_params: {},
    notes: "Sync TTS via PAI raw passthrough. ~5-15s. $0.01 per 500 input characters.",
  },

  // ───────────── asset preupload (internal) ─────────────
  {
    id: "video-generation-assets",
    provider: "pai",
    kind: "asset",
    label: "Asset preupload (video-generation-assets)",
    cost_approx_usd: 0.01,
    capabilities: ["asset-upload"],
    default_params: {},
    notes: "Reference preupload via PAI raw passthrough. ~$0.01 per ref. Internal; hidden from /models.",
    hidden: true,
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const BY_KIND = new Map(MODELS.map((m) => [m.kind, m]));

export function getModel(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Resolve the default model for a capability.
 *
 * The optional second arg is accepted but ignored — v1 has exactly one
 * provider per kind. Single-arg form is preferred: getDefault("image").
 */
export function getDefault(kind, _provider) {
  const m = BY_KIND.get(kind);
  if (!m) {
    throw new Error(`model_registry: no model registered for kind="${kind}"`);
  }
  return m;
}

export function getModelsByKind(kind) {
  return MODELS.filter((m) => m.kind === kind);
}

export function getCost(modelOrId, params = {}) {
  const m = typeof modelOrId === "string" ? getModel(modelOrId) : modelOrId;
  if (!m) return null;
  const c = m.cost_approx_usd;
  if (typeof c === "function") return c(params);
  return typeof c === "number" ? c : null;
}
