// Single source of truth for the models pai-pro uses, indexed by
// kind. Adding a model is one edit here; the provider clients import
// getDefault(kind).id rather than inlining the string. The renderer
// reads MODELS as JSON via the viewer's GET /models route — adding a
// model auto-flows its label to canvas card chrome and the expand
// overlay, no separate UI edit.
//
// Every capability routes through the PAI media API raw passthrough; the
// `provider` field is therefore always `"pai"` and is kept only so
// routes/system.js + web/lib/useModels.tsx don't need a schema change.
//
// Schema per entry:
//   id              PAI raw model name (what we pass as `model` on
//                   POST /api/v1/generate or /submit). Also stamped
//                   onto canvas node metadata.model.
//   provider        always "pai" in this codebase.
//   kind            "image" | "image_pro" | "video" | "video_25" |
//                   "voice" | "asset"
//   api_version     video kinds only. The string --version selects this
//                   entry by, on generate_video.js. One lookup feeds both
//                   the price and the id submitted to PAI, because those
//                   used to be two independent strings (see
//                   videoModelForApiVersion below).
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
import {
  IMAGE_PRO_DEFAULT_SIZE,
  imageProCostBySize,
} from "./image_pro_sizes.js";

// Load .env defensively. local_viewer.js calls config() after it has
// already imported this module (ES modules evaluate imports before the
// importer's body), so without this the env overrides below would be
// undefined when MODELS initializes. dotenv.config() does not overwrite
// already-set vars, so re-loading is safe.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

// ── Cost functions ──────────────────────────────────────────────────

// Image standard tier. Per-image pricing keyed off the imageSize dimension.
//
// These were 7 / 10 / 15 cents until 2026-09. That was not a pricing decision
// — it was upstream's own published figure copied across, which left two of
// the three tiers unsustainable. They were repriced on the same basis as
// everything else in this file.
//
// The tiers are not evenly spaced because a cent is a coarse unit at this
// scale: the arithmetic lands between cents and always rounds up, so the
// smallest tier absorbs the most rounding. The derivation lives with the
// backend pricing rows, not here.
function imageCostBySize(params = {}) {
  const size = String(params.image_size || params.imageSize || "2K").toLowerCase();
  if (size === "1k") return 0.11;
  if (size === "2k") return 0.16;
  if (size === "4k") return 0.23;
  return 0.16; // 2K default
}

// Video tier (2.0). Per-second, on BILLED seconds — the output clip plus every
// second of reference video, the same dimension 2.5 prices on.
//
// Two columns, not one. Upstream discounts the whole job's rate when video
// input is present, so a render carrying references genuinely costs less per
// second than one without. Billing reference seconds at the reference-free
// rate would overcharge that job by ~60%, which is the trap a single price
// walks straight into.
//
// Image and audio references add nothing — only video ones add seconds — so a
// job with no video reference has billed === duration and reads the bare
// column, exactly as it always did.
// 🔴 720p's `ref` is 14c, not the 15c you get by rounding up. It is the one
// rate of the six where two defensible derivations land on opposite sides of a
// cent, and the shortfall being rounded away is under half of one percent of a
// cent. Taking 15 would close that at a single theoretical edge — a minimum
// output carrying a minimum reference — and overcharge every real
// reference-bearing 720p job by about seven percent. It looks like a rounding
// bug and it is not. Do not round it up for consistency.
//
// 🔴 `ref` is currently UNUSED, and deliberately kept. A reference-bearing
// render is genuinely cheaper per second to serve, these three rates reflect
// that, and the backend has the matching rows seeded. Neither side can select
// them until the billed seconds come from somewhere the caller does not
// control. Do not delete them as dead values; the day that changes, both sides
// reconnect rather than re-derive.
const VIDEO_20_PER_SEC = {
  "480p": { plain: 0.11, ref: 0.07 },
  "720p": { plain: 0.23, ref: 0.14 },
  "1080p": { plain: 0.57, ref: 0.35 },
};

// 🔴 This must equal what the backend charges, not what the job costs.
//
// The number this returns is written into the pending sidecar and rendered on
// the Generate button, and it is never recomputed when the job fires. It is
// the number the user APPROVES. So it has exactly one job: agree with the
// backend's `pricing` table. Being closer to the vendor's real cost while
// disagreeing with the charge is not better, it is the bug.
//
// The backend prices 2.0 on the OUTPUT clip at the reference-free rate. It
// cannot do otherwise: billed seconds include the reference clips, those live
// in bytes the service never holds, and the only other source is a number the
// caller reports — which, on an API we sell with an open-source client, is the
// buyer reporting the quantity their own bill is computed from. So the `ref`
// rates below go unused here for the same reason their rows go unread there.
//
// This was briefly not true. Between the backend change and this one, a 4s
// 480p job carrying a 4s reference showed $0.56 and charged $0.44 — the user
// approving one number and being billed another, in the safe direction, which
// is still the failure this whole file exists to prevent.
function videoCostByResAndDuration(params = {}) {
  const res = String(params.resolution || "720p").toLowerCase();
  const rates = VIDEO_20_PER_SEC[res] ?? VIDEO_20_PER_SEC["720p"];
  const dur = Math.ceil(Number(params.duration) || 15);
  return +(dur * rates.plain).toFixed(3);
}

// ── PAI Video 2.5 ───────────────────────────────────────────────────
//
// 🔴 CROSS-REPO CONSTANT. This exact string is the model id the backend
// registers and the key its pricing rows are stored under, so it cannot be
// renamed from this side alone.
export const VIDEO_25_MODEL_ID = "video-generation-25";

// The three exact strings the tier table and the backend both key on. The
// 1080p rows are read by exact match, so this set travels with the prices —
// generate_video.js and routes/pending.js both import it rather than keeping
// their own literal.
export const VIDEO_25_RESOLUTIONS = ["480p", "720p", "1080p"];

// 2.5 is flat per call INSIDE a tier, and the tier is keyed on BILLED
// seconds: the clip we ask for plus every second of reference video upstream
// has to read. That "plus reference seconds" is measured, not assumed — the
// same render with and without a reference of equal length bills exactly
// double, which is how the rule was confirmed.
//
// Serving cost is affine in billed seconds — a fixed setup charge plus a
// per-second rate that scales with pixel count — so each resolution reads its
// own rows rather than a multiplier off 720p.
//
// Each price is the worst case inside its tier, rounded UP to the cent so the
// floor holds exactly. No .99 ending on purpose: a psychological price would
// scatter the nine above the target by varying amounts for a reason nobody
// could reconstruct later, while a flat rule is re-derivable.
//
// The prices also carry three costs that the per-render arithmetic alone does
// not: an ambiguous submit can be re-dispatched upstream, so more than one
// render can happen for one charge; a failed render is refunded to the user
// whether or not we are refunded in turn; and the rate the tiers were fitted
// against is itself second-hand.
//
// The derivation and the measurements live with the backend pricing rows,
// not here.
//
// 🔴 These six numbers are the same six rows the backend seeds. The draft
// gate's price is a CLIENT-SIDE SNAPSHOT written into the pending sidecar
// and never recomputed when the job fires, so if this table and that
// migration disagree the user approves one number and is charged another,
// with nothing anywhere to reconcile them. Change them in the same commit
// as the backend's pricing rows, or not at all.
//
// All three resolutions read their own column now. 480p used to ride the bare
// 720p price. The provider bills by output pixel count, and 2.5's 480p is
// 854x480 against 720p's 1280x720 — well over twice the pixels for the same
// second, so a 480p render was paying a price calibrated for a much larger
// frame.
// That was a ~125% overcharge on every 480p render, and the only error in
// this table that cost the customer rather than us.
export const VIDEO_25_TIERS = [
  { ceiling: 20, usd_480p: 3.10, usd: 6.95,  usd_1080p: 17.10 },
  { ceiling: 35, usd_480p: 4.64, usd: 10.42, usd_1080p: 25.63 },
  { ceiling: 60, usd_480p: 5.54, usd: 12.46, usd_1080p: 30.64 },
];

// The cap IS the top tier's ceiling — derived, never written twice. Past it
// no pricing row exists at all: the backend raises before the credit freeze,
// so the CLI refuses first and nothing is spent.
export const VIDEO_25_MAX_BILLED_SEC = VIDEO_25_TIERS[VIDEO_25_TIERS.length - 1].ceiling;

// Upstream charges a MINIMUM of 4 seconds of input whenever any video
// reference is present, however short the clip actually is. A single 1s
// reference bills as 4.
export const VIDEO_MIN_INPUT_SEC = 4;

/**
 * Billed seconds for one render: the output clip plus the input upstream
 * charges for, each rounded UP.
 *
 * The input side is `max(4, sum of reference seconds)` when there is at least
 * one video reference, and 0 when there is none — not simply the sum. Ignoring
 * that floor under-quotes every job with a short reference, which is the only
 * direction that silently spends money nobody approved.
 *
 * Exported so generate_video.js sends the provider exactly the number this
 * file priced.
 */
export function videoBilledDurationSec({ duration, refVideoSeconds = 0 } = {}) {
  const out = Number(duration);
  const refs = Number(refVideoSeconds);
  const outSec = Number.isFinite(out) && out > 0 ? Math.ceil(out) : 0;
  if (!Number.isFinite(refs) || refs <= 0) return outSec;
  return outSec + Math.max(VIDEO_MIN_INPUT_SEC, Math.ceil(refs));
}

/** @deprecated name kept for callers that predate 2.0 using the same rule. */
export const video25BilledDurationSec = videoBilledDurationSec;

// Callers pass either the measured `billed_duration_sec` (the CLI, which
// has ffprobed the refs) or `duration` + `ref_video_seconds` (the PATCH
// re-quote, which re-derives it after a duration edit). Returns null past
// the cap and for a job with no output length — there is no row to quote,
// and a 0 would render as a free render.
function video25CostByTier(params = {}) {
  const billed = Number.isFinite(Number(params.billed_duration_sec))
    ? Math.ceil(Number(params.billed_duration_sec))
    : video25BilledDurationSec({
        duration: params.duration,
        refVideoSeconds: params.ref_video_seconds,
      });
  if (!Number.isFinite(billed) || billed <= 0) return null;
  const tier = VIDEO_25_TIERS.find((t) => billed <= t.ceiling);
  if (!tier) return null;
  // Lower-cased for the tier lookup only. The BACKEND exact-matches the three
  // resolution strings pre-freeze rather than normalising, and
  // generate_video.js normalises `--resolution` before it sends, so what this
  // quotes and what that bills are the same string. Quoting a "1080P" at the
  // bare tier here while it read the 1080p tier there would under-quote the
  // user by up to $23; quoting it at the 1080p tier and having the backend
  // refuse costs nothing.
  const res = String(params.resolution || "").toLowerCase();
  if (res === "1080p") return tier.usd_1080p;
  if (res === "480p") return tier.usd_480p;
  return tier.usd;
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

  // ───────────── image (pro tier) ─────────────
  {
    id: "image-generation-pro",
    provider: "pai",
    kind: "image_pro",
    label: "Image Pro (image-generation-pro)",
    cost_approx_usd: imageProCostBySize,
    capabilities: ["text-to-image", "image-to-image", "multi-ref", "rendered-text"],
    default_params: { size: IMAGE_PRO_DEFAULT_SIZE, output_format: "png" },
    notes: "Sync pro image generation/editing via PAI raw passthrough. Routes refs internally to image-edit-pro. ~3 min.",
  },

  // ───────────── video (2.0) ─────────────
  {
    id: "video-generation",
    provider: "pai",
    kind: "video",
    api_version: "2.0",
    label: "Video (video-generation)",
    cost_approx_usd: videoCostByResAndDuration,
    capabilities: ["text-to-video", "image-to-video", "video-to-video", "audio"],
    default_params: { duration: 15, aspect_ratio: "16:9", resolution: "720p", generate_audio: true },
    notes: "Async video generation via PAI raw passthrough. Refs require public URLs (tunnel). ~3-6 min. Real money.",
  },

  // ───────────── video (2.5) ─────────────
  //
  // A SECOND KIND, not a second entry under kind "video". BY_KIND is built
  // last-wins from this array (:148), and getDefault() is a bare lookup in it
  // (:160-166), so a duplicate "video" row would silently repoint every
  // existing 2.0 call at 2.5 with no error anywhere. The "exactly one model
  // per kind" line at the top of this file is a comment, not a check.
  // image / image_pro already coexist exactly this way.
  //
  // Not `hidden`: GET /models is a label lookup (routes/system.js:116-135 →
  // web/src/lib/useModels.tsx byId), not a picker, so a visible entry gives a
  // 2.5 node's card its name and adds no manual control anywhere.
  {
    id: VIDEO_25_MODEL_ID,
    provider: "pai",
    kind: "video_25",
    api_version: "2.5",
    label: "Video 2.5 (video-generation-25)",
    cost_approx_usd: video25CostByTier,
    capabilities: ["text-to-video", "image-to-video", "video-to-video", "audio"],
    default_params: { duration: 15, aspect_ratio: "16:9", resolution: "720p", generate_audio: true },
    notes: "Async PAI Video 2.5. `generate_video.js --version 2.5`. Output 5-30s; flat price per billed-duration tier (output seconds + reference-video seconds, 60s cap). Real money.",
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

// generate_video.js's --version → the one registry entry that both prices
// the job and supplies the id submitted to PAI.
//
// 🔴 This exists to make one specific bug impossible. The price used to come
// from getDefault("video") in the CLI and the wire id from a module constant
// inside pai_video_client.js — two independent strings with nothing holding
// them together, so a half-finished version switch would have priced 2.5 and
// rendered 2.0 (or the reverse), with the canvas node stamped one way and the
// invoice the other. Both sides now resolve the same entry from the same
// version string.
export const DEFAULT_VIDEO_API_VERSION = "2.0";

const VIDEO_KIND_BY_API_VERSION = new Map(
  MODELS
    .filter((m) => typeof m.api_version === "string" && m.api_version !== "")
    .map((m) => [m.api_version, m.kind]),
);

export function videoApiVersions() {
  return [...VIDEO_KIND_BY_API_VERSION.keys()];
}

export function videoModelForApiVersion(version) {
  const kind = VIDEO_KIND_BY_API_VERSION.get(String(version));
  if (!kind) {
    throw new Error(
      `model_registry: no video model for version="${version}" ` +
      `(expected ${videoApiVersions().join(" | ")})`,
    );
  }
  return getDefault(kind);
}

/**
 * What staging a job will book, references included.
 *
 * A video's price is not only the model's: every reference is pre-uploaded to
 * the provider through `video-generation-assets` at ~$0.01 each, and
 * generate_video.js adds that to the draft's `cost_usd`. A caller that quotes
 * `getCost` alone therefore shows a number lower than the one it is about to
 * spend — small in dollars, but it is the number the user is being asked to
 * approve, so it has to be the same one.
 *
 * This lives here so the CLI and the /cost route share the arithmetic rather
 * than each carrying a copy. `refCount` is ignored for kinds that have no
 * preupload step: image references travel inside the request.
 */
// Kinds whose references are pre-uploaded through video-generation-assets and
// therefore carry a per-reference add-on. A set rather than the old
// `kind !== "video"` equality: 2.5 uploads its refs through the same endpoint,
// and a strict equality would have dropped the add-on from the PATCH re-quote
// while generate_video.js kept adding it at stage time — the two prices for
// one draft disagreeing by a cent per reference.
const REF_PRICED_KINDS = new Set(["video", "video_25"]);

/**
 * Stage-time price: the model price plus the per-reference add-on.
 *
 * 🔴 The add-on is FRICTION, not cost recovery, and the distinction matters
 * because the arithmetic looks wrong until you know it. A cent is nowhere near
 * what a reference costs upstream — that is billed by SECONDS at the output
 * resolution and can even be negative, since a video reference moves the whole
 * job to a cheaper rate column. Those seconds are already priced, through
 * videoBilledDurationSec.
 *
 * What the cent buys is a floor on attaching references for free. Nothing else
 * in the pipeline makes a caller think twice about sending thirty of them, and
 * each one is a real upload the provider has to accept. Do not "correct" this
 * to match vendor cost; it was never trying to.
 */
export function stagedCostUsd(modelOrId, params = {}, refCount = 0) {
  const m = typeof modelOrId === "string" ? getModel(modelOrId) : modelOrId;
  const base = getCost(m, params);
  if (base === null) return null;
  const refs = Number.isFinite(refCount) ? Math.max(0, Math.trunc(refCount)) : 0;
  if (refs === 0 || !REF_PRICED_KINDS.has(m?.kind)) return base;
  const perRef = getCost("video-generation-assets") ?? 0.01;
  return +(base + refs * perRef).toFixed(3);
}

export function getCost(modelOrId, params = {}) {
  const m = typeof modelOrId === "string" ? getModel(modelOrId) : modelOrId;
  if (!m) return null;
  const c = m.cost_approx_usd;
  if (typeof c === "function") return c(params);
  return typeof c === "number" ? c : null;
}
