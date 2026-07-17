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
import { getDefault, getCost } from "../model_registry.js";
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
  reserveAutoBudget,
  waitForReviewResult,
  writePending,
  writeResultSidecar,
  removePending,
  removePendingSync,
} from "./_pending.js";
import { VIDEO_LIMITS } from "./_limits.js";
import { checkPromptRefsWired } from "./_ref_guard.js";

const rawArgv = process.argv.slice(2);
const defaultVideoModel = getDefault("video");
const defaultVideoParams = defaultVideoModel.default_params ?? {};

const args = parseArgs({
  prompt:                  { type: "string", short: "p" },
  duration:                { type: "string", default: "15" },
  "aspect-ratio":          { type: "string", default: "16:9" },
  resolution:              { type: "string", default: defaultVideoParams.resolution ?? "720p" },
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

const audSrcIds = Array.isArray(args["ref-audio-source-id"]) ? args["ref-audio-source-id"] : [];
const refSourcesArg = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];

// Sent values surfaced in {limits, sent} failure JSON.
function buildSent() {
  return {
    ref_source_ids: refSourcesArg,
    audio_source_ids: audSrcIds,
    source_node_id: args["source-node-id"] || null,
    duration: Number(args.duration) || 15,
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
  };
}

// Last terminal object emitted to stdout, captured so the finally block can
// persist it as the durable result sidecar (failures fire from several inner
// sites and throw, so we funnel capture through fail() rather than each site).
let emitted = null;

function fail(klass, message, extra = {}) {
  emitted = emitFailure(klass, message, { limits: VIDEO_LIMITS, sent: buildSent(), ...extra });
  return emitted;
}

if (!args.prompt) {
  fail("bad_args", "missing --prompt");
  process.exit(2);
}

if (audSrcIds.length > VIDEO_LIMITS.max_audio_refs) {
  fail("bad_args", `reference cap exceeded: audio_refs ${audSrcIds.length} > ${VIDEO_LIMITS.max_audio_refs}`);
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
const durationPlanned = Number(args.duration) || 15;
const plannedModel = defaultVideoModel.id;

if (args["auto-run-id"] !== undefined) {
  if (args["auto-run-id"] === "") {
    fail("bad_args", "--auto-run-id must not be empty");
    process.exit(2);
  }
  if (!args.stage && !routeOwnedPending) {
    fail("bad_args", "--auto-run-id requires --stage so the run's budget is reserved before spending");
    process.exit(2);
  }
}

// Asset preupload through PAI's video-generation-assets costs ~$0.01 per
// ref. Count canvas source-ids once each across image + video + audio refs.
function countUniqueRefs() {
  const sids = new Set([...refSourcesArg, ...audSrcIds]);
  return sids.size;
}

if (args.stage && !routeOwnedPending) {
  const videoCost = getCost(plannedModel, {
    resolution: args.resolution,
    duration: durationPlanned,
  });
  const refCount = countUniqueRefs();
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
  if (imgSrcIds.length > VIDEO_LIMITS.max_image_refs) overCaps.push(`image_refs ${imgSrcIds.length} > ${VIDEO_LIMITS.max_image_refs}`);
  if (vidSrcIds.length > VIDEO_LIMITS.max_video_refs) overCaps.push(`video_refs ${vidSrcIds.length} > ${VIDEO_LIMITS.max_video_refs}`);
  if (overCaps.length) {
    fail("bad_args", `reference cap exceeded: ${overCaps.join("; ")}`);
    exitCode = 2;
    throw new Error("bad_args: ref cap exceeded");
  }

  const resolvedImages = await buildProviderRefs({ sourceIds: imgSrcIds, projectId });
  const resolvedAudios = await buildProviderRefs({ sourceIds: audSrcIds, projectId });
  const resolvedVideos = await buildProviderRefs({ sourceIds: vidSrcIds, projectId });

  let assetIds = { images: [], audios: [], videos: [] };
  if (resolvedImages.length || resolvedAudios.length || resolvedVideos.length) {
    try {
      assetIds = await uploadReferences({
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
    duration: durationInt,
    aspectRatio: args["aspect-ratio"],
    resolution: args.resolution,
    generateAudio: !args["no-audio"],
    imageAssetIds: assetIds.images,
    audioAssetIds: assetIds.audios,
    videoAssetIds: assetIds.videos,
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
    duration: durationInt,
    aspect_ratio: args["aspect-ratio"],
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
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
