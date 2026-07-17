#!/usr/bin/env node
// CLI wrapper for the pro image tier via PAI raw passthrough.
//
// User-facing model: image-generation-pro. Calls without refs use the
// raw image-generation-pro route; calls with --ref-source-id values use
// raw image-edit-pro internally. Refs remain canvas node ids only; the
// CLI resolves them to tunnel URLs through buildProviderRefs().
//
// Pro accepts exact --size only. Do not add --aspect-ratio or --image-size
// flags here; those are standard-tier provider inputs.

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { generateImagePro as paiGenerateImagePro } from "../pai_image_pro_client.js";
import {
  writeBytesToTmp,
  viewerUrlForLocalPath,
  buildProviderRefs,
  readActiveProject,
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
import { getDefault, getCost } from "../model_registry.js";
import { kickPreupload } from "./_preupload_hook.js";
import { IMAGE_PRO_LIMITS } from "./_limits.js";
import {
  IMAGE_PRO_DEFAULT_SIZE,
  aspectRatioForImageProSize,
  imageProSizeTier,
  normalizeImageProOutputFormat,
} from "../image_pro_sizes.js";

const rawArgv = process.argv.slice(2);

const args = parseArgs({
  prompt:          { type: "string", short: "p" },
  size:            { type: "string", default: IMAGE_PRO_DEFAULT_SIZE },
  "output-format": { type: "string", default: "png" },
  // canvas-mutate integration
  label:           { type: "string" },
  subtype:         { type: "string" }, // character | location | edit | reference | split | storyboard
  "source-node-id": { type: "string" },
  "ref-source-id": { type: "string", multiple: true, default: [] },
  "project-id":    { type: "string" },
  "request-id":    { type: "string" },
  "no-canvas-write": { type: "boolean" },
  name:            { type: "string" },
  role:            { type: "string" },
  description:     { type: "string" },
  stage:           { type: "boolean" },
  "draft-only":    { type: "boolean" },
  "existing-job-id": { type: "string" },
  "auto-run-id":   { type: "string" },
});

const refSources = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];
const plannedModel = getDefault("image_pro").id;

function buildSent() {
  return {
    ref_source_ids: refSources,
    size: args.size,
    output_format: args["output-format"],
  };
}

function fail(klass, message, extra = {}) {
  return emitFailure(klass, message, { limits: IMAGE_PRO_LIMITS, sent: buildSent(), ...extra });
}

if (!args.prompt) {
  fail("bad_args", "missing --prompt");
  process.exit(2);
}

const imageSize = imageProSizeTier(args.size);
if (!imageSize) {
  fail("bad_args", `unsupported --size "${args.size}"`);
  process.exit(2);
}
const aspectRatio = aspectRatioForImageProSize(args.size);
const outputFormat = normalizeImageProOutputFormat(args["output-format"]);
if (!outputFormat) {
  fail("bad_args", `unsupported --output-format "${args["output-format"]}"`);
  process.exit(2);
}

if (refSources.length > IMAGE_PRO_LIMITS.max_image_refs) {
  fail("bad_args", `reference cap exceeded: image_refs ${refSources.length} > ${IMAGE_PRO_LIMITS.max_image_refs}`);
  process.exit(2);
}

const jobId = args["existing-job-id"] || newJobId();
const routeOwnedPending = !!args["existing-job-id"];

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

if (args.stage && !routeOwnedPending) {
  const costUsd = getCost(plannedModel, { size: args.size });
  const autoRunId = args["auto-run-id"] || null;
  const autoProjectId = autoRunId
    ? args["project-id"] || (await readActiveProject().catch(() => null))
    : null;
  if (autoRunId) {
    const reserved = await reserveAutoBudget({
      projectId: autoProjectId,
      runId: autoRunId,
      jobId,
      kind: "image",
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
    kind: "image",
    stage: "draft",
    prompt: args.prompt,
    aspectRatio,
    sourceNodeId: args["source-node-id"] || null,
    referenceSourceIds: refSources,
    model: plannedModel,
    size: args.size,
    imageSize,
    costUsd,
    script: "generate_image_pro.js",
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
          kind: "image",
          timeoutMs: 12 * 60 * 1000,
        })
      : await waitForReviewResult(jobId, { kind: "image" });
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
  kind: "image",
  prompt: args.prompt,
  aspectRatio,
  sourceNodeId: args["source-node-id"] || null,
  referenceSourceIds: refSources,
  model: plannedModel,
  size: args.size,
  imageSize,
  autoRunId: args["auto-run-id"] || null,
});

let exitCode = 0;
let emitted = null;
try {
  const projectId = args["project-id"] || (await readActiveProject());

  const resolvedRefs = (await buildProviderRefs({
    sourceIds: refSources,
    projectId,
  })).map((r) => r.tunnelUrl);

  const result = await paiGenerateImagePro({
    prompt: args.prompt,
    size: args.size,
    outputFormat,
    refImageUrls: resolvedRefs,
  });
  const staged = await writeBytesToTmp({
    bytes: result.bytes,
    mimeType: result.mime,
    projectId,
  });
  const tmpAbsPath = staged.absolute_path;
  const ext = path.extname(tmpAbsPath);

  const data = {
    label: args.label || truncateLabel(args.prompt),
    prompt: args.prompt,
    metadata: {
      source: "pai",
      task_type: "image_generation",
      model: result.model,
      size: result.size,
      aspect_ratio: result.aspectRatio,
      image_size: result.imageSize,
      generated_at: isoNow(),
      pending_job_id: jobId,
    },
    ...(args.subtype ? { subtype: args.subtype } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.role ? { role: args.role } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args["source-node-id"] ? { source_id: args["source-node-id"] } : {}),
  };
  const mutResult = await postNodeAddBatch({
    args,
    type: "image_result",
    data,
    actor: "cli:generate_image_pro",
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
    ? `assets/images/${assignedNodeId}${ext}`
    : null;
  const imageUrl = localPath
    ? viewerUrlForLocalPath({ localPath, projectId })
    : null;

  if (localPath) {
    await kickPreupload({ projectId, localPath, mimeType: result.mime });
  }

  const estimatedCostUsd = getCost(plannedModel, { size: result.size });
  const payload = {
    output_url: imageUrl,
    local_path: localPath,
    model: result.model,
    size: result.size,
    aspect_ratio: result.aspectRatio,
    image_size: result.imageSize,
    duration_seconds: result.durationSeconds,
    cost_usd: result.costUsd ?? estimatedCostUsd ?? null,
    generated_at: data.metadata.generated_at,
  };
  if (mutResult) Object.assign(payload, mutResult);

  emitted = emitSuccess(payload);
} catch (e) {
  emitted = fail(classify(e), e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
  exitCode = 1;
} finally {
  if (!routeOwnedPending) {
    if (emitted) await writeResultSidecar(jobId, { ...emitted, kind: "image" });
    await removePending(jobId);
  }
}
process.exit(exitCode);
