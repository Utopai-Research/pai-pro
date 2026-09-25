#!/usr/bin/env node
// CLI wrapper for video generation via PAI raw passthrough
// (model id: video-generation). Synchronous from the caller's POV —
// typical wall-clock is 2-4 min, so plan accordingly.
//
// Refs: every ref is a canvas node id (--ref-source-id for image / video
// sources, --ref-audio-source-id for audio sources). buildProviderRefs
// resolves each source's local_path and rewrites the host to the
// cloudflared tunnel origin via .tunnel_url (written by scripts/start.sh),
// so PAI's video-generation-assets endpoint can fetch the bytes
// server-side. External URLs are mirrored onto the canvas first via
// mirror_url.js; no separate URL-passthrough flag.

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { submitVideo, pollVideo } from "../pai_video_client.js";
import {
  DEFAULT_VIDEO_API_VERSION,
  VIDEO_25_RESOLUTIONS,
  getCost,
  stagedCostUsd,
  videoBilledDurationSec,
  videoApiVersions,
  videoModelForApiVersion,
} from "../model_registry.js";
import { uploadReferences } from "../pai_assets_client.js";
import { kickPreupload } from "./_preupload_hook.js";
import {
  streamUrlToTmp,
  viewerUrlForLocalPath,
  buildProviderRefs,
  readActiveProject,
  readNodeType,
} from "../local_mirror.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import {
  fireDraft,
  fireAndWait,
  isBypassEnabled,
  newJobId,
  readPendingSidecar,
  reserveAutoBudget,
  waitForReviewResult,
  writePending,
  writeResultSidecar,
  removePending,
  removePendingSync,
} from "./_pending.js";
import { videoLimitsFor, videoOutputDurationBounds } from "./_limits.js";
import { checkPromptRefsWired } from "./_ref_guard.js";
import { sumRefVideoSeconds } from "./_video_billing.js";

const rawArgv = process.argv.slice(2);

const args = parseArgs({
  prompt:                  { type: "string", short: "p" },
  duration:                { type: "string", default: "15" },
  // Which PAI video model this call prices AND submits against. "2.0" is the
  // long-standing route; "2.5" is PAI Video 2.5.
  //
  // A flag, never a canvas control: version selection is an agent decision,
  // and this repo adds no new manual node UI.
  //
  // A flag on THIS script rather than a second generate_video_25.js, because
  // the viewer's PATCH-side duration guard keys on the literal string
  // entry.script === "generate_video.js" — a new script name would take a
  // duration edit with no bounds check at all, and would need its own
  // ALLOWED_SCRIPTS entry besides.
  version:                 { type: "string", default: DEFAULT_VIDEO_API_VERSION },
  "aspect-ratio":          { type: "string", default: "16:9" },
  // Default filled in below, from whichever model --version resolved.
  resolution:              { type: "string" },
  // Audio defaults ON (generate_audio: true). Pass --no-audio ONLY when
  // the user has explicitly asked for a silent clip. Trailer framing,
  // "I'll add SFX in post", or detail-SFX skepticism are NOT triggers —
  // audio is the baseline. See video-compose/SKILL.md § "Hard defaults".
  "no-audio":              { type: "boolean", default: false },
  // canvas-mutate integration
  label:                   { type: "string" },
  "ref-source-id":         { type: "string", multiple: true, default: [] },
  "source-node-id":        { type: "string" }, // authorship edge — see PROJECT_AGENT.md
  // Canvas audio_result refs — resolved to local_path, uploaded via the tunnel.
  "ref-audio-source-id":   { type: "string", multiple: true, default: [] },
  "shot-id":               { type: "string" },
  "project-id":            { type: "string" },
  "request-id":            { type: "string" },
  "no-canvas-write":       { type: "boolean" },
  // Draft gate — see PROJECT_AGENT.md § "Draft gate".
  stage:                   { type: "boolean" },
  "draft-only":            { type: "boolean" },
  "existing-job-id":       { type: "string" },
  "auto-run-id":           { type: "string" },
});

// One lookup, from one flag, feeding every downstream use: the price quoted
// at the draft gate, the model written into the sidecar and the canvas node,
// and the id submitted to PAI. Those last two used to be separate strings —
// getDefault("video") here, a module constant in pai_video_client.js — so a
// half-finished version switch could price 2.5 and render 2.0.
let videoModel;
try {
  videoModel = videoModelForApiVersion(args.version);
} catch {
  emitFailure(
    "bad_args",
    `--version must be one of ${videoApiVersions().join(" | ")}; got "${args.version}"`,
  );
  process.exit(2);
}
const plannedModel = videoModel.id;
const isV25 = videoModel.api_version === "2.5";
const videoLimits = videoLimitsFor(plannedModel);
if (args.resolution === undefined) {
  args.resolution = videoModel.default_params?.resolution ?? "720p";
}

// Measured below, before staging, on BOTH version paths. Declared here because
// buildSent() reports them and fail() can fire before the measurement runs —
// the first fail() is the missing-prompt gate, which would otherwise hit a
// temporal-dead-zone ReferenceError instead of printing clean bad_args JSON.
let refVideoSeconds = 0;
let billedDurationSec = null;

const audSrcIds = Array.isArray(args["ref-audio-source-id"]) ? args["ref-audio-source-id"] : [];
const refSourcesArg = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];

// Sent values surfaced in {limits, sent} failure JSON.
function buildSent() {
  return {
    ref_source_ids: refSourcesArg,
    audio_source_ids: audSrcIds,
    source_node_id: args["source-node-id"] || null,
    version: args.version,
    model: plannedModel,
    duration: Number(args.duration) || 15,
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
    ...(isV25 || refVideoSeconds > 0
      ? { billed_duration_sec: billedDurationSec, ref_video_seconds: refVideoSeconds }
      : {}),
  };
}

// Last terminal object emitted to stdout, captured so the finally block can
// persist it as the durable result sidecar (failures fire from several inner
// sites and throw, so we funnel capture through fail() rather than each site).
let emitted = null;

function fail(klass, message, extra = {}) {
  // Model-scoped, not the static 2.0 blob: a 2.5 failure that advertised
  // 4..15 as its output-duration range would send the agent to a second
  // failure.
  emitted = emitFailure(klass, message, { limits: videoLimits, sent: buildSent(), ...extra });
  return emitted;
}

if (!args.prompt) {
  fail("bad_args", "missing --prompt");
  process.exit(2);
}

// Reject out-of-range output durations before staging, pricing, or submit.
const durationBounds = videoOutputDurationBounds(plannedModel);
const durationParsed = Number(args.duration);
if (
  !Number.isInteger(durationParsed) ||
  durationParsed < durationBounds.min ||
  durationParsed > durationBounds.max
) {
  fail(
    "bad_args",
    `--duration must be an integer between ${durationBounds.min} and ${durationBounds.max} seconds ` +
    `(model ${plannedModel}); got "${args.duration}"`,
  );
  process.exit(2);
}

// 2.5's price rows are keyed on the EXACT resolution string: only "1080p"
// reads the composite 1080p tiers, and the backend exact-matches it too.
// Normalising here means the agent may type any casing while the wire carries
// only the three exact strings the backend accepts.
if (isV25) {
  args.resolution = String(args.resolution || "").toLowerCase();
  if (!VIDEO_25_RESOLUTIONS.includes(args.resolution)) {
    fail(
      "bad_args",
      `--resolution must be one of ${VIDEO_25_RESOLUTIONS.join(" | ")} for --version 2.5; ` +
      `got "${args.resolution}"`,
    );
    process.exit(2);
  }
}

// 2.5's backend extractor rejects any other ratio pre-freeze. Refusing here
// keeps the failure ahead of the draft gate instead of behind it.
const VIDEO_25_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"];
if (isV25 && !VIDEO_25_RATIOS.includes(args["aspect-ratio"])) {
  fail(
    "bad_args",
    `--aspect-ratio must be one of ${VIDEO_25_RATIOS.join(" | ")} for --version 2.5; ` +
    `got "${args["aspect-ratio"]}"`,
  );
  process.exit(2);
}

// The provider requires an image_url or video_url item to accompany any audio_url item
// (enforced by the provider adapter on that route). On 2.0 PAI rejects this
// synchronously and free; on the 2.5 route it is checked AFTER the freeze and
// AFTER every reference is uploaded upstream, so it arrives as an async FAILED
// minutes later with a refund only via Pub/Sub or reconcile.
if (isV25 && audSrcIds.length > 0 && refSourcesArg.length === 0) {
  fail(
    "bad_args",
    "--version 2.5 rejects an audio-only reference set: every --ref-audio-source-id needs at least one image or video reference (--ref-source-id) to anchor it. On the 2.5 route this is only caught after credits are frozen, so it is refused here.",
  );
  process.exit(2);
}

if (audSrcIds.length > videoLimits.max_audio_refs) {
  fail("bad_args", `reference cap exceeded: audio_refs ${audSrcIds.length} > ${videoLimits.max_audio_refs}`);
  process.exit(2);
}

// Reject prompts that name @ImageN/@VideoN/@AudioN without wiring the matching
// flag — runs before staging + any paid call. See _ref_guard.js.
const refGuardMsg = checkPromptRefsWired({
  prompt: args.prompt,
  refSourceCount: refSourcesArg.length,
  audioRefCount: audSrcIds.length,
  tier: "video",
});
if (refGuardMsg) {
  fail("bad_args", refGuardMsg);
  process.exit(2);
}

const jobId = args["existing-job-id"] || newJobId();
const routeOwnedPending = !!args["existing-job-id"];
const durationPlanned = durationParsed; // gate above guarantees a valid integer

if (args["auto-run-id"] !== undefined) {
  if (args["auto-run-id"] === "") {
    fail("bad_args", "--auto-run-id must not be empty");
    process.exit(2);
  }
  if (!args.stage && !routeOwnedPending) {
    fail("bad_args", "--auto-run-id requires --stage so the run's budget is reserved before spending");
    process.exit(2);
  }
  // Auto's approval gate is a RUN-level estimate the viewer computes up front
  // from 2.0's per-second rates (web/src/pages/CanvasView.tsx:195-196 quotes
  // "video-generation" and rescales linearly). A 2.5 job inside that run
  // spends against a number that was never quoted for it, and a tiered price
  // cannot be rescaled — the same approved-one-number-charged-another failure
  // the rest of this file guards against. Refuse until that estimator is
  // version-aware.
  if (isV25) {
    fail(
      "bad_args",
      "--version 2.5 is not supported inside an Auto run: the run's budget estimate is computed from 2.0 per-second rates. Stage the 2.5 clip outside Auto.",
    );
    process.exit(2);
  }
}

// Asset preupload through PAI's video-generation-assets costs ~$0.01 per
// ref. Count canvas source-ids once each across image + video + audio refs.
function countUniqueRefs() {
  const sids = new Set([...refSourcesArg, ...audSrcIds]);
  return sids.size;
}

// BOTH versions are priced on BILLED seconds: the clip asked for plus every
// second of reference video the vendor has to read. Nobody upstream can
// compute that — the reference bytes are on this machine, and the backend
// freezes the money before the vendor ever fetches them — so it is measured
// here, with ffprobe, before anything is staged or submitted. Free, local, and
// on BOTH paths: the draft gate needs it to quote, and the --existing-job-id
// fire needs it to submit.
//
// 2.0 used to skip this and price output seconds alone, which rendered every
// reference second for free. It now reads the same dimension 2.5 does, and the
// backend refuses a 2.0 job carrying video references without the number.
{
  const projectIdForRefs = args["project-id"] || (await readActiveProject().catch(() => null));
  try {
    const measured = await sumRefVideoSeconds({
      sourceIds: refSourcesArg,
      projectId: projectIdForRefs,
    });
    refVideoSeconds = measured.seconds;
  } catch (e) {
    fail(classify(e), e.message);
    process.exit(e.klass === "bad_args" ? 2 : 1);
  }
  billedDurationSec = videoBilledDurationSec({
    duration: durationPlanned,
    refVideoSeconds,
  });

  // The price on the Generate button is a snapshot taken at stage time and
  // never recomputed when the job fires — the fire route replays the stored
  // argv and re-runs the measurement above from scratch. This is the one
  // place a re-measure can disagree with the approved number: a reference
  // clip regenerated, re-mirrored, or upscaled over the same local_path
  // between approval and fire. Refuse rather than submit a tier nobody
  // approved. (The sidecar survives the claim intact: routes/pending.js's
  // claimDraftForGenerate does a whole-JSON read-modify-write, so
  // ref_video_seconds is still there.)
  if (routeOwnedPending) {
    const prev = await readPendingSidecar(jobId);
    const prevBilled = prev
      ? videoBilledDurationSec({
          duration: prev.duration,
          refVideoSeconds: prev.ref_video_seconds,
        })
      : null;
    if (prevBilled && prevBilled !== billedDurationSec) {
      const approved = getCost(plannedModel, {
        resolution: prev.resolution,
        billed_duration_sec: prevBilled,
      });
      const now = getCost(plannedModel, {
        resolution: args.resolution,
        billed_duration_sec: billedDurationSec,
      });
      if (approved !== now) {
        fail(
          "bad_args",
          `reference video changed since this draft was approved: billed duration is now ` +
          `${billedDurationSec}s (was ${prevBilled}s), which is a different price tier. ` +
          "Cancel this draft and stage a new one.",
        );
        process.exit(2);
      }
    }
  }

  // Past the top tier there is no pricing row at all, so the backend refuses
  // before the credit freeze. Refusing here refuses it earlier and says which
  // knob to turn — the reference seconds are the half the user cannot see.
  //
  // 2.5 only: `max_billed_sec` is a PRICING cap, and 2.0 has no tiers to run
  // out of — it is priced per billed second at any length. Reading the ceiling
  // unconditionally would hand a 2.0 job a "--version 2.5" refusal. Same test
  // routes/pending.js:288 uses to tell the two apart.
  if (videoLimits.max_billed_sec && billedDurationSec > videoLimits.max_billed_sec) {
    fail(
      "bad_args",
      `billed duration ${billedDurationSec}s exceeds the ${videoLimits.max_billed_sec}s maximum for ` +
      `--version 2.5: ${durationPlanned}s of output plus ${refVideoSeconds}s of reference video. ` +
      "Shorten the clip or drop/trim a video reference.",
    );
    process.exit(2);
  }
}

if (args.stage && !routeOwnedPending) {
  const videoCost = getCost(plannedModel, {
    resolution: args.resolution,
    duration: durationPlanned,
    // 2.0 sends it only when there ARE video references: with none the backend
    // requires billed === duration and treats a mismatch as a caller error, so
    // the field would be noise at best.
    ...(isV25 || refVideoSeconds > 0 ? { billed_duration_sec: billedDurationSec } : {}),
  });
  // A null price on 2.5 means no tier matched. The guard above should have
  // caught that already; if it ever does not, staging anyway would put a
  // reference-only price on the Generate button and call it the cost of a
  // render.
  if (isV25 && typeof videoCost !== "number") {
    fail(
      "infra",
      `no 2.5 price for ${billedDurationSec}s billed at ${args.resolution}; refusing to stage a draft the gate cannot quote`,
    );
    process.exit(1);
  }
  // Only 2.0 pays this. 2.5 stopped pre-uploading (see the ref block below),
  // so there are no asset calls to charge for — and this number's only job is
  // to equal the charge. Leaving it in would quote every 2.5 reference at a
  // cent nobody spends, and the draft gate never re-quotes, so the gap would
  // be permanent for that job rather than corrected at fire time.
  const refCount = isV25 ? 0 : countUniqueRefs();
  const assetCost = refCount * (getCost("video-generation-assets") ?? 0.01);
  const costUsd = +(Number(videoCost ?? 0) + assetCost).toFixed(3);
  const autoRunId = args["auto-run-id"] || null;
  const autoProjectId = autoRunId
    ? args["project-id"] || (await readActiveProject().catch(() => null))
    : null;
  if (autoRunId) {
    const reserved = await reserveAutoBudget({
      projectId: autoProjectId,
      runId: autoRunId,
      jobId,
      kind: "video",
      model: plannedModel,
      prompt: args.prompt,
      costUsd,
    });
    if (!reserved.ok) {
      const { ok, klass, message, error, ...extra } = reserved;
      fail(klass || "budget_exceeded", message || error || "auto budget reservation failed", extra);
      process.exit(klass === "bad_args" ? 2 : 1);
    }
  }
  const replayArgv = rawArgv.filter((a) => a !== "--stage" && a !== "--draft-only");
  const staged = await writePending({
    jobId,
    kind: "video",
    stage: "draft",
    prompt: args.prompt,
    aspectRatio: args["aspect-ratio"],
    // --ref-source-id (image + video) and --ref-audio-source-id (audio)
    // both feed the same source-id channel for the projection's dashed
    // edges — match the edges postNodeAddBatch will emit on the final.
    sourceNodeId: args["source-node-id"] || null,
    referenceSourceIds: [...refSourcesArg, ...audSrcIds],
    model: plannedModel,
    resolution: args.resolution,
    duration: durationPlanned,
    // Persisted so the PATCH re-quote can re-tier a duration edit against the
    // same billed seconds this price was computed from.
    refVideoSeconds,
    costUsd,
    script: "generate_video.js",
    argv: replayArgv,
    autoRunId,
  });
  if (!staged) {
    fail("infra", "failed to write draft sidecar");
    process.exit(1);
  }
  emitSuccess({ stage: "draft", job_id: jobId, model: plannedModel, cost_usd: costUsd });
  try {
    const bypassEnabled = await isBypassEnabled();
    const shouldFire = bypassEnabled || !!autoRunId;
    if (args["draft-only"] && !shouldFire) process.exit(0);
    const projectId = shouldFire
      ? args["project-id"] || (await readActiveProject())
      : null;
    if (args["draft-only"]) {
      const fired = await fireDraft({ projectId, jobId });
      process.stdout.write(JSON.stringify({
        ...fired,
        ...(fired.ok ? { stage: "running", fired: true } : {}),
      }) + "\n");
      process.exit(fired.ok ? 0 : 1);
    }
    const result = shouldFire
      ? await fireAndWait({
          projectId,
          jobId,
          kind: "video",
        })
      : await waitForReviewResult(jobId, { kind: "video" });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    fail(classify(e), e.message);
    process.exit(1);
  }
}

if (!routeOwnedPending) {
  const cleanup = () => removePendingSync(jobId);
  process.on("SIGINT",  () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

await writePending({
  jobId,
  kind: "video",
  prompt: args.prompt,
  aspectRatio: args["aspect-ratio"],
  sourceNodeId: args["source-node-id"] || null,
  referenceSourceIds: [...refSourcesArg, ...audSrcIds],
  model: plannedModel,
  resolution: args.resolution,
  duration: durationPlanned,
  refVideoSeconds,
  autoRunId: args["auto-run-id"] || null,
});

let exitCode = 0;
try {
  const durationInt = durationPlanned;
  const projectId = args["project-id"] || (await readActiveProject());

  // Partition --ref-source-id list into image / video buckets by node
  // type. Wrong-typed ids (audio, note, missing) reject with bad_args
  // — silent drops would leave the user with a solid edge to a node
  // the provider never actually received. Audio refs use the
  // dedicated --ref-audio-source-id flag.
  const imgSrcIds = [];
  const vidSrcIds = [];
  const badSrcIds = [];
  for (const sid of refSourcesArg) {
    const t = await readNodeType({ nodeId: sid, projectId });
    if (t === "image_result") imgSrcIds.push(sid);
    else if (t === "video_result") vidSrcIds.push(sid);
    else badSrcIds.push({ id: sid, type: t ?? "missing" });
  }
  if (badSrcIds.length) {
    const desc = badSrcIds.map((b) => `${b.id} (type=${b.type})`).join(", ");
    fail("bad_args", `--ref-source-id rejected: ${desc}. Image / video sources only; for audio use --ref-audio-source-id.`);
    // Set exitCode + throw so the finally block can clean up the sidecar
    // (process.exit() would skip async cleanup).
    exitCode = 2;
    throw new Error("bad_args: wrong-typed ref-source-id");
  }

  // Fast-fail per-kind cap violations now that types are known.
  const overCaps = [];
  if (imgSrcIds.length > videoLimits.max_image_refs) overCaps.push(`image_refs ${imgSrcIds.length} > ${videoLimits.max_image_refs}`);
  if (vidSrcIds.length > videoLimits.max_video_refs) overCaps.push(`video_refs ${vidSrcIds.length} > ${videoLimits.max_video_refs}`);
  if (overCaps.length) {
    fail("bad_args", `reference cap exceeded: ${overCaps.join("; ")}`);
    exitCode = 2;
    throw new Error("bad_args: ref cap exceeded");
  }

  const resolvedImages = await buildProviderRefs({ sourceIds: imgSrcIds, projectId });
  const resolvedAudios = await buildProviderRefs({ sourceIds: audSrcIds, projectId });
  const resolvedVideos = await buildProviderRefs({ sourceIds: vidSrcIds, projectId });

  // 🔴 ONLY 2.0 PRE-UPLOADS, AND THAT ASYMMETRY IS THE WHOLE POINT.
  //
  // An asset id is minted inside ONE vendor's namespace. 2.5's route spreads
  // across more than one vendor and picks per task, so an id minted here is
  // correct only when the render happens to land on the vendor that minted
  // it, and is an unresolvable reference otherwise — terminally, because that
  // failure reads as bad caller input and bad input does not rotate vendors.
  //
  // That route already solves this: hand it a public URL and it uploads to
  // the vendor it actually selected, so references and render cannot
  // disagree. Pre-uploading here is what took that mechanism away.
  //
  // 2.0 keeps pre-uploading because its route does NOT upload for us — it
  // forwards the body to one fixed vendor and expects ids to already exist.
  // Sending it a URL would hand the vendor a reference it was never asked to
  // fetch. The two halves move together or not at all.
  //
  // `tunnelUrl` is what the pre-upload was uploading FROM (see
  // buildProviderRefs), so the URL path needs nothing new — it stops doing
  // the step instead of doing a different one.
  let refs = { images: [], audios: [], videos: [] };
  const hasRefs = resolvedImages.length || resolvedAudios.length || resolvedVideos.length;
  if (hasRefs && isV25) {
    refs = {
      images: resolvedImages.map((r) => r.tunnelUrl),
      audios: resolvedAudios.map((r) => r.tunnelUrl),
      videos: resolvedVideos.map((r) => r.tunnelUrl),
    };
  } else if (hasRefs) {
    try {
      refs = await uploadReferences({
        images: resolvedImages,
        audios: resolvedAudios,
        videos: resolvedVideos,
      });
    } catch (e) {
      const extra = e.assetRejected
        ? { failed_url: e.failedUrl || null, kind: e.kind || null }
        : (e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
      fail(e.assetRejected ? "asset_rejected" : classify(e), e.message, extra);
      exitCode = 1;
      throw e;
    }
  }

  const { taskId } = await submitVideo({
    prompt: args.prompt,
    // Same entry that priced the job, staged the sidecar and stamps the node.
    // submitVideo derives the wire model and the payload shape from it, so
    // there is no second place a version can be set independently.
    modelId: plannedModel,
    duration: durationInt,
    aspectRatio: args["aspect-ratio"],
    resolution: args.resolution,
    generateAudio: !args["no-audio"],
    // null on 2.0; required and validated on 2.5.
    billedDurationSec,
    imageRefs: refs.images,
    audioRefs: refs.audios,
    videoRefs: refs.videos,
  });

  const { videoUrl, durationSeconds } = await pollVideo(taskId);
  // Stream the MP4 straight to the tmp file — a 1080p clip is tens of MB,
  // and buffering it whole made the long-lived viewer OOM-prone under
  // draft-gate fan-out (audit N22).
  const staged = await streamUrlToTmp({
    url: videoUrl,
    mimeType: "video/mp4",
    projectId,
  });
  const tmpAbsPath = staged.absolute_path;
  const ext = path.extname(tmpAbsPath);

  const generatedAt = isoNow();
  // The number the draft gate showed, recomputed from the same inputs and
  // stamped onto the node. web/src/pages/CanvasPage/MediaExpandOverlay.tsx
  // prefers a stamped estimated_cost_usd over re-quoting the registry
  // (:180-195), and its re-quote sends only resolution + duration — which on
  // 2.5 tiers on the output clip alone and reads a tier too low.
  const estimatedCostUsd = isV25
    ? stagedCostUsd(
        plannedModel,
        {
          resolution: args.resolution,
          duration: durationInt,
          billed_duration_sec: billedDurationSec,
        },
        // 0, not countUniqueRefs(): this branch is 2.5, which no longer
        // pre-uploads, so its references cost nothing. Same reason the quote
        // above zeroes them — and this number is the one the canvas shows,
        // so a stale cent here contradicts the gate the user already saw.
        0,
      )
    : null;
  const shotIdRaw = args["shot-id"];
  const shotId = shotIdRaw === undefined ? null : Number(shotIdRaw);
  const data = {
    label: args.label || truncateLabel(args.prompt),
    prompt: args.prompt,
    duration: durationInt,
    aspect: args["aspect-ratio"],
    shot_id: Number.isFinite(shotId) ? shotId : null,
    metadata: {
      source: "pai",
      task_type: "video_generation",
      model: plannedModel,
      duration: durationInt,
      aspect_ratio: args["aspect-ratio"],
      resolution: args.resolution,
      generate_audio: !args["no-audio"],
      ...(isV25
        ? {
            billed_duration_sec: billedDurationSec,
            ref_video_seconds: refVideoSeconds,
            ...(typeof estimatedCostUsd === "number"
              ? { estimated_cost_usd: estimatedCostUsd }
              : {}),
          }
        : {}),
      generated_at: generatedAt,
      // PAI's signed GCS URL (~24h TTL). Surfaced for future re-download
      // paths; the canvas URL itself is always derived from local_path.
      provider_output_url: videoUrl,
      pending_job_id: jobId,
    },
  };
  // Merge audio source-ids into the --ref-source-id list so
  // postNodeAddBatch emits one derived edge per ref (image + video +
  // audio sources all feed the same edge channel).
  const argsForMutate = {
    ...args,
    "ref-source-id": [...refSourcesArg, ...audSrcIds],
  };
  const mutResult = await postNodeAddBatch({
    args: argsForMutate,
    type: "video_result",
    data,
    actor: "cli:generate_video",
    tmpPath: tmpAbsPath,
    pendingJobId: jobId,
  });
  const assignedNodeId = mutResult?.canvas_mutation?.node_id ?? null;
  if (!assignedNodeId) {
    await fs.unlink(tmpAbsPath).catch(() => {});
  }
  if (mutResult?.canvas_mutation_error) {
    const err = new Error(mutResult.canvas_mutation_error.message || "canvas mutation failed");
    err.klass = mutResult.canvas_mutation_error.klass || "infra";
    throw err;
  }
  const localPath = assignedNodeId
    ? `assets/videos/${assignedNodeId}${ext}`
    : null;
  const url = localPath
    ? viewerUrlForLocalPath({ localPath, projectId })
    : null;

  if (localPath) {
    await kickPreupload({ projectId, localPath, mimeType: "video/mp4" });
  }

  const payload = {
    output_url: url,
    local_path: localPath,
    provider_output_url: videoUrl,
    model: plannedModel,
    version: args.version,
    duration: durationInt,
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
    ...(isV25 || refVideoSeconds > 0
      ? { billed_duration_sec: billedDurationSec, ref_video_seconds: refVideoSeconds }
      : {}),
    poll_seconds: durationSeconds,
    generated_at: generatedAt,
  };
  if (mutResult) Object.assign(payload, mutResult);

  emitted = emitSuccess(payload);
} catch (e) {
  if (exitCode === 0) {
    fail(classify(e), e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
    exitCode = 1;
  }
} finally {
  // Route-owned fires get their durable result written by the fire route
  // from captured stdout; a direct/bypass CLI run persists its own.
  if (!routeOwnedPending) {
    if (emitted) await writeResultSidecar(jobId, { ...emitted, kind: "video" });
    await removePending(jobId);
  }
}
process.exit(exitCode);
