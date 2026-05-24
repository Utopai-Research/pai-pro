#!/usr/bin/env node
// CLI wrapper for the standard image tier via PAI raw passthrough
// (model id: image-generation).
//
// Refs: pass --ref-source-id NODE_ID to chain off a prior canvas node.
// The CLI resolves to that node's mirrored local file and rewrites the
// viewer URL's host to the cloudflared tunnel origin (via .tunnel_url),
// so PAI's `image-generation` can fetch the bytes server-side. For
// external URLs, the agent runs mirror_url.js first to mint a canvas
// reference node, then references that node's id via --ref-source-id.
//
// `./start.sh` auto-launches `cloudflared tunnel` and writes the public
// URL to .tunnel_url. If .tunnel_url is missing the call fails with
// bad_args pointing back at `./start.sh`.
//
// Output (stdout, one line):
//   { ok: true, output_url, model, aspect_ratio, image_size,
//     local_path?, duration_seconds, cost_usd, generated_at,
//     canvas_mutation? }
//   { ok: false, klass, message, retryAfterSec? }

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { generateImage as paiGenerateImage } from "../pai_image_client.js";
import {
  writeBytesToTmp,
  viewerUrlForLocalPath,
  buildProviderRefs,
  readActiveProject,
} from "../local_mirror.js";
import { postNodeAddBatch } from "./_mutate_helper.js";
import { isBypassEnabled, newJobId, writePending, removePending, removePendingSync } from "./_pending.js";
import { getDefault, getCost } from "../model_registry.js";
import { kickPreupload } from "./_preupload_hook.js";
import { IMAGE_LIMITS } from "./_limits.js";

const rawArgv = process.argv.slice(2);

const args = parseArgs({
  prompt:         { type: "string", short: "p" },
  "aspect-ratio": { type: "string", default: "16:9" },
  "image-size":   { type: "string", default: "2K" },
  // canvas-mutate integration
  label:           { type: "string" },
  subtype:         { type: "string" }, // character | location | edit | reference | split
  "source-node-id": { type: "string" }, // authorship edge — see CLAUDE.md
  "ref-source-id": { type: "string", multiple: true, default: [] },
  "project-id":    { type: "string" },
  "request-id":    { type: "string" },
  "no-canvas-write": { type: "boolean" },
  name:            { type: "string" },
  role:            { type: "string" },
  description:     { type: "string" },
  // Draft gate — see CLAUDE.md § "Draft gate".
  stage:           { type: "boolean" },
  "existing-job-id": { type: "string" },
});

const refSources = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];

function buildSent() {
  return {
    ref_source_ids: refSources,
    aspect_ratio: args["aspect-ratio"],
    image_size: args["image-size"],
  };
}

function fail(klass, message, extra = {}) {
  emitFailure(klass, message, { limits: IMAGE_LIMITS, sent: buildSent(), ...extra });
}

if (!args.prompt) {
  fail("bad_args", "missing --prompt");
  process.exit(2);
}

if (refSources.length > IMAGE_LIMITS.max_image_refs) {
  fail("bad_args", `reference cap exceeded: image_refs ${refSources.length} > ${IMAGE_LIMITS.max_image_refs}`);
  process.exit(2);
}
const jobId = args["existing-job-id"] || newJobId();
const plannedModel = getDefault("image").id;

if (args.stage && !(await isBypassEnabled())) {
  const costUsd = getCost(plannedModel, { image_size: args["image-size"] });
  await writePending({
    jobId,
    kind: "image",
    stage: "draft",
    prompt: args.prompt,
    aspectRatio: args["aspect-ratio"],
    sourceNodeId: args["source-node-id"] || null,
    referenceSourceIds: refSources,
    model: plannedModel,
    imageSize: args["image-size"],
    costUsd,
    script: "generate_image.js",
    argv: rawArgv.filter((a) => a !== "--stage"),
  });
  emitSuccess({ stage: "draft", job_id: jobId, model: plannedModel, cost_usd: costUsd });
  process.exit(0);
}

const cleanup = () => removePendingSync(jobId);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

await writePending({
  jobId,
  kind: "image",
  prompt: args.prompt,
  aspectRatio: args["aspect-ratio"],
  sourceNodeId: args["source-node-id"] || null,
  referenceSourceIds: refSources,
  model: plannedModel,
  imageSize: args["image-size"],
});

let exitCode = 0;
try {
  const projectId = args["project-id"] || (await readActiveProject());

  const resolvedRefs = await buildProviderRefs({
    sourceIds: refSources,
    projectId,
  });

  const result = await paiGenerateImage({
    prompt: args.prompt,
    aspectRatio: args["aspect-ratio"],
    imageSize: args["image-size"],
    refImageUrls: resolvedRefs,
    projectId,
  });
  // Mutator fills image_url + local_path after renaming the staged file
  // into assets/images/<node-id><ext> — the data payload below omits both.
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
      aspect_ratio: args["aspect-ratio"],
      image_size: args["image-size"],
      generated_at: isoNow(),
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
    actor: "cli:generate_image",
    tmpPath: tmpAbsPath,
    pendingJobId: jobId,
  });
  // No node id ⇒ no rename happened; the temp file is still at tmpAbsPath.
  const assignedNodeId = mutResult?.canvas_mutation?.node_id ?? null;
  if (!assignedNodeId) {
    await fs.unlink(tmpAbsPath).catch(() => {});
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

  const payload = {
    output_url: imageUrl,
    local_path: localPath,
    model: result.model,
    aspect_ratio: args["aspect-ratio"],
    image_size: args["image-size"],
    duration_seconds: result.durationSeconds,
    cost_usd: result.costUsd ?? null,
    generated_at: data.metadata.generated_at,
  };
  if (mutResult) Object.assign(payload, mutResult);

  emitSuccess(payload);
} catch (e) {
  fail(classify(e), e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
  exitCode = 1;
} finally {
  await removePending(jobId);
}
process.exit(exitCode);
