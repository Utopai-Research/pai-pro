#!/usr/bin/env node
// CLI wrapper for PAI video upscaling. Initial implementation follows the
// documented upscale-* flow and writes the result as a normal
// video_result node.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { parseArgs, emitSuccess, emitFailure, classify, isoNow } from "./_cli.js";
import {
  createUpscale,
  acceptUpscale,
  uploadUpscaleSource,
  completeUpscale,
  pollUpscale,
  UPSCALE_COMPLETE_MODEL,
} from "../pai_upscale_client.js";
import {
  streamUrlToTmp,
  viewerUrlForLocalPath,
  readActiveProject,
  readNodeAssetInfo,
} from "../local_mirror.js";
import { projectDir } from "../lib/paths.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import { kickPreupload } from "./_preupload_hook.js";
import {
  fireDraft,
  fireAndWait,
  isBypassEnabled,
  newJobId,
  waitForReviewResult,
  writePending,
  writeResultSidecar,
  removePending,
  removePendingSync,
} from "./_pending.js";

const rawArgv = process.argv.slice(2);

const args = parseArgs({
  "source-node-id":       { type: "string" },
  label:                  { type: "string" },
  "project-id":           { type: "string" },
  "request-id":           { type: "string" },
  "no-canvas-write":      { type: "boolean" },
  stage:                  { type: "boolean" },
  "draft-only":           { type: "boolean" },
  "existing-job-id":      { type: "string" },
  "upscale-request-id":   { type: "string" },
  "estimated-cost-usd":   { type: "string" },
});

let emitted = null;
let lastUpscaleRequestId = args["upscale-request-id"] || null;
let lastUpscaleTaskId = null;
let lastProviderOutputUrl = null;

function providerHost(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function failureContext(e) {
  return {
    ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}),
    ...(lastUpscaleTaskId ? { task_id: lastUpscaleTaskId } : {}),
    ...(lastProviderOutputUrl ? { provider_output_url: lastProviderOutputUrl } : {}),
    ...(providerHost(lastProviderOutputUrl) ? { provider_output_url_host: providerHost(lastProviderOutputUrl) } : {}),
    ...(e.downloadAttempts ? { download_attempts: e.downloadAttempts } : {}),
    ...(e.downloadCause ? { download_cause: e.downloadCause } : {}),
  };
}

function fail(klass, message, extra = {}) {
  emitted = emitFailure(klass, message, {
    sent: {
      source_node_id: args["source-node-id"] || null,
      upscale_request_id: lastUpscaleRequestId,
    },
    ...extra,
  });
  return emitted;
}

if (!args["source-node-id"]) {
  fail("bad_args", "missing --source-node-id");
  process.exit(2);
}

const jobId = args["existing-job-id"] || newJobId();
const routeOwnedPending = !!args["existing-job-id"];
const OUTPUT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_DOWNLOAD_ATTEMPTS = 3;
const OUTPUT_DOWNLOAD_RETRY_DELAY_MS = 5_000;
const UPSCALE_MODE_LABEL = "4K upscale";

function parseRate(v) {
  if (typeof v !== "string" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseFraction(s) {
  const value = String(s || "");
  const [a, b] = value.split("/").map(Number);
  if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function target4kResolution({ width, height }) {
  const ratio = width / height;
  if (Math.abs(ratio - (16 / 9)) < 0.01) return { width: 3840, height: 2160 };
  if (Math.abs(ratio - (9 / 16)) < 0.01) return { width: 2160, height: 3840 };
  const scale = 3840 / Math.max(width, height);
  return { width: even(width * scale), height: even(height * scale) };
}

function containerForPath(filePath, formatName) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (ext) return ext;
  const first = String(formatName || "").split(",")[0]?.trim();
  return first || "mp4";
}

async function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => {
      if (e.code === "ENOENT") {
        e.klass = "infra";
        e.message = "ffprobe not installed on server host";
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const e = new Error(`ffprobe exit ${code}: ${err.slice(-500)}`);
        e.klass = "bad_args";
        reject(e);
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        e.klass = "infra";
        reject(e);
      }
    });
  });
}

async function probeSource(filePath) {
  const info = await runFfprobe(filePath);
  const video = Array.isArray(info?.streams)
    ? info.streams.find((s) => s?.codec_type === "video")
    : null;
  if (!video) {
    const e = new Error("ffprobe found no video stream");
    e.klass = "bad_args";
    throw e;
  }
  const width = Number(video.width);
  const height = Number(video.height);
  const duration = Number(video.duration ?? info?.format?.duration);
  const frameRate = parseFraction(video.avg_frame_rate) ?? parseFraction(video.r_frame_rate);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    const e = new Error("ffprobe could not read source dimensions");
    e.klass = "bad_args";
    throw e;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    const e = new Error("ffprobe could not read source duration");
    e.klass = "bad_args";
    throw e;
  }
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    const e = new Error("ffprobe could not read source frame rate");
    e.klass = "bad_args";
    throw e;
  }
  const st = await fs.stat(filePath);
  const frameCountRaw = Number(video.nb_frames);
  const frameCount = Number.isFinite(frameCountRaw) && frameCountRaw > 0
    ? Math.round(frameCountRaw)
    : Math.max(1, Math.round(duration * frameRate));
  return {
    width,
    height,
    container: containerForPath(filePath, info?.format?.format_name),
    size: st.size,
    duration,
    frameRate: Number(frameRate.toFixed(3)),
    frameCount,
  };
}

function aspectString({ width, height }) {
  function gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) [x, y] = [y, x % y];
    return x || 1;
  }
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

function resolutionString({ width, height }) {
  return `${Math.round(width)}x${Math.round(height)}`;
}

function buildCreatePayload(sourceSpec, outputResolution) {
  return {
    source: {
      resolution: { width: sourceSpec.width, height: sourceSpec.height },
      container: sourceSpec.container,
      size: sourceSpec.size,
      duration: sourceSpec.duration,
      frameRate: sourceSpec.frameRate,
      frameCount: sourceSpec.frameCount,
    },
    output: {
      resolution: outputResolution,
      frameRate: sourceSpec.frameRate,
      container: "mp4",
      audioCodec: "AAC",
      audioTransfer: "Copy",
    },
    filters: [{ model: "prob-4" }],
  };
}

function replayArgvWithEstimate(requestId, costUsd) {
  const out = rawArgv.filter((a) => a !== "--stage" && a !== "--draft-only");
  if (!out.includes("--upscale-request-id")) out.push("--upscale-request-id", requestId);
  if (!out.includes("--estimated-cost-usd") && typeof costUsd === "number") {
    out.push("--estimated-cost-usd", String(costUsd));
  }
  return out;
}

async function resolveSource() {
  const projectId = args["project-id"] || (await readActiveProject());
  const source = await readNodeAssetInfo({ nodeId: args["source-node-id"], projectId });
  if (!source) {
    const e = new Error(`source node not found: ${args["source-node-id"]}`);
    e.klass = "bad_args";
    throw e;
  }
  if (source.archived) {
    const e = new Error(`source node is archived: ${args["source-node-id"]}`);
    e.klass = "bad_args";
    throw e;
  }
  if (!source.localPath) {
    const e = new Error(`source node has no local_path: ${args["source-node-id"]}`);
    e.klass = "bad_args";
    throw e;
  }
  const filePath = path.resolve(projectDir(projectId), source.localPath);
  const sourceSpec = await probeSource(filePath);
  const outputResolution = target4kResolution(sourceSpec);
  return {
    projectId,
    source,
    filePath,
    sourceSpec,
    outputResolution,
    aspectRatio: aspectString(outputResolution),
    durationInt: Math.max(1, Math.round(sourceSpec.duration)),
    prompt: `Upscale ${args["source-node-id"]} to 4K`,
  };
}

async function ensureUpscaleRequest(sourceSpec, outputResolution) {
  const existing = args["upscale-request-id"];
  if (existing) {
    return {
      requestId: existing,
      costUsd: parseRate(args["estimated-cost-usd"]),
    };
  }
  const created = await createUpscale(buildCreatePayload(sourceSpec, outputResolution));
  const costUsd = typeof created.estimates?.price_usd === "number"
    ? created.estimates.price_usd
    : null;
  return { requestId: created.requestId, costUsd };
}

if (args.stage && !routeOwnedPending) {
  try {
    const resolved = await resolveSource();
    const { requestId, costUsd } = await ensureUpscaleRequest(resolved.sourceSpec, resolved.outputResolution);
    lastUpscaleRequestId = requestId;
    const staged = await writePending({
      jobId,
      kind: "video",
      stage: "draft",
      prompt: resolved.prompt,
      aspectRatio: resolved.aspectRatio,
      sourceNodeId: args["source-node-id"],
      referenceSourceIds: [],
      model: UPSCALE_COMPLETE_MODEL,
      resolution: "4K",
      duration: resolved.durationInt,
      costUsd,
      mode: UPSCALE_MODE_LABEL,
      sourceResolution: resolutionString(resolved.sourceSpec),
      targetResolution: resolutionString(resolved.outputResolution),
      script: "upscaler.js",
      argv: replayArgvWithEstimate(requestId, costUsd),
    });
    if (!staged) {
      fail("infra", "failed to write draft sidecar");
      process.exit(1);
    }
    emitSuccess({ stage: "draft", job_id: jobId, model: UPSCALE_COMPLETE_MODEL, cost_usd: costUsd });
    const bypassEnabled = await isBypassEnabled();
    if (args["draft-only"] && !bypassEnabled) process.exit(0);
    const projectId = bypassEnabled
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
    const result = bypassEnabled
      ? await fireAndWait({ projectId, jobId, kind: "video" })
      : await waitForReviewResult(jobId, { kind: "video" });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    fail(classify(e), e.message, failureContext(e));
    process.exit(1);
  }
}

if (!routeOwnedPending) {
  const cleanup = () => removePendingSync(jobId);
  process.on("SIGINT",  () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

let exitCode = 0;
let tmpAbsPath = null;
try {
  const resolved = await resolveSource();
  await writePending({
    jobId,
    kind: "video",
    prompt: resolved.prompt,
    aspectRatio: resolved.aspectRatio,
    sourceNodeId: args["source-node-id"],
    referenceSourceIds: [],
    model: UPSCALE_COMPLETE_MODEL,
    resolution: "4K",
    duration: resolved.durationInt,
    costUsd,
    mode: UPSCALE_MODE_LABEL,
    sourceResolution: resolutionString(resolved.sourceSpec),
    targetResolution: resolutionString(resolved.outputResolution),
  });

  const { requestId, costUsd } = await ensureUpscaleRequest(resolved.sourceSpec, resolved.outputResolution);
  lastUpscaleRequestId = requestId;
  const { uploadUrl } = await acceptUpscale(requestId);
  const uploadResult = await uploadUpscaleSource({
    uploadUrl,
    filePath: resolved.filePath,
    contentType: "video/mp4",
  });
  const { taskId } = await completeUpscale({ requestId, uploadResult });
  lastUpscaleTaskId = taskId;
  const { videoUrl, durationSeconds } = await pollUpscale(taskId);
  lastProviderOutputUrl = videoUrl;
  const staged = await streamUrlToTmp({
    url: videoUrl,
    mimeType: "video/mp4",
    projectId: resolved.projectId,
    timeoutMs: OUTPUT_DOWNLOAD_TIMEOUT_MS,
    attempts: OUTPUT_DOWNLOAD_ATTEMPTS,
    retryDelayMs: OUTPUT_DOWNLOAD_RETRY_DELAY_MS,
  });
  tmpAbsPath = staged.absolute_path;
  const outputSpec = await probeSource(tmpAbsPath);
  const actualOutputResolution = { width: outputSpec.width, height: outputSpec.height };
  const actualAspectRatio = aspectString(actualOutputResolution);
  const outputDurationInt = Math.max(1, Math.round(outputSpec.duration));
  const ext = path.extname(tmpAbsPath);

  const generatedAt = isoNow();
  const data = {
    label: args.label || `4K ${resolved.source.label || args["source-node-id"]}`,
    prompt: resolved.prompt,
    duration: outputDurationInt,
    aspect: actualAspectRatio,
    shot_id: null,
    metadata: {
      source: "pai",
      task_type: "video_upscale",
      mode: UPSCALE_MODE_LABEL,
      model: UPSCALE_COMPLETE_MODEL,
      resolution: "4K",
      aspect_ratio: actualAspectRatio,
      source_node_id: args["source-node-id"],
      source_resolution: resolutionString(resolved.sourceSpec),
      requested_output_resolution: resolutionString(resolved.outputResolution),
      output_resolution: resolutionString(actualOutputResolution),
      upscale_request_id: requestId,
      ...(typeof costUsd === "number" ? { estimated_cost_usd: costUsd } : {}),
      provider_output_url: videoUrl,
      generated_at: generatedAt,
      pending_job_id: jobId,
    },
  };
  const mutResult = await postNodeAddBatch({
    args,
    type: "video_result",
    data,
    actor: "cli:upscaler",
    tmpPath: tmpAbsPath,
    pendingJobId: jobId,
  });
  const assignedNodeId = mutResult?.canvas_mutation?.node_id ?? null;
  if (!assignedNodeId) {
    await fs.unlink(tmpAbsPath).catch(() => {});
    tmpAbsPath = null;
  }
  if (mutResult?.canvas_mutation_error) {
    const err = new Error(mutResult.canvas_mutation_error.message || "canvas mutation failed");
    err.klass = mutResult.canvas_mutation_error.klass || "infra";
    throw err;
  }
  const localPath = assignedNodeId ? `assets/videos/${assignedNodeId}${ext}` : null;
  const url = localPath
    ? viewerUrlForLocalPath({ localPath, projectId: resolved.projectId })
    : null;

  if (localPath) {
    await kickPreupload({ projectId: resolved.projectId, localPath, mimeType: "video/mp4" });
  }

  const payload = {
    output_url: url,
    local_path: localPath,
    provider_output_url: videoUrl,
    model: UPSCALE_COMPLETE_MODEL,
    resolution: "4K",
    aspect_ratio: actualAspectRatio,
    duration: outputDurationInt,
    upscale_request_id: requestId,
    cost_usd: costUsd,
    poll_seconds: durationSeconds,
    generated_at: generatedAt,
  };
  if (mutResult) Object.assign(payload, mutResult);
  emitted = emitSuccess(payload);
} catch (e) {
  if (tmpAbsPath) await fs.unlink(tmpAbsPath).catch(() => {});
  fail(classify(e), e.message, failureContext(e));
  exitCode = e.klass === "bad_args" ? 2 : 1;
} finally {
  if (!routeOwnedPending) {
    if (emitted) await writeResultSidecar(jobId, { ...emitted, kind: "video" });
    await removePending(jobId);
  }
}
process.exit(exitCode);
