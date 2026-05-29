import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { getCost, getDefault } from "../model_registry.js";
import { pendingDir, resultsDir } from "./paths.js";

const MAX_PROMPT_CHARS = 4000;
const MAX_TEXT_CHARS = 4000;

function isoNow() {
  return new Date().toISOString();
}

function truncateString(value, maxLen) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen);
}

function hashId(parts) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `pending_${hash}`;
}

function knownCanvasNodeIds(project) {
  return new Set(
    (Array.isArray(project?.canvasState?.nodes) ? project.canvasState.nodes : [])
      .map((node) => node?.id)
      .filter((id) => typeof id === "string" && id !== ""),
  );
}

function cleanRefIds(raw) {
  return Array.isArray(raw)
    ? raw.filter((v) => typeof v === "string" && v !== "")
    : [];
}

function cleanSourceNodeId(raw) {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

function validateRefs({ project, refSourceIds, sourceNodeId }) {
  const known = knownCanvasNodeIds(project);
  const missing = [];
  for (const id of refSourceIds) {
    if (!known.has(id)) missing.push(id);
  }
  if (sourceNodeId && !known.has(sourceNodeId)) missing.push(sourceNodeId);
  if (missing.length > 0) {
    throw Object.assign(new Error(`unknown source node id(s): ${[...new Set(missing)].join(", ")}`), {
      klass: "bad_args",
    });
  }
}

function imagePayload(spec, context) {
  const prompt = truncateString(spec.prompt, MAX_PROMPT_CHARS);
  if (!prompt) throw Object.assign(new Error("stage_image requires prompt"), { klass: "bad_args" });
  const imageSize = typeof spec.image_size === "string" && spec.image_size !== ""
    ? spec.image_size
    : "2K";
  const aspectRatio = typeof spec.aspect_ratio === "string" && spec.aspect_ratio !== ""
    ? spec.aspect_ratio
    : context?.source_result?.aspect_ratio || "16:9";
  const model = getDefault("image").id;
  const argv = [
    "--prompt", prompt,
    "--aspect-ratio", aspectRatio,
    "--image-size", imageSize,
  ];
  if (typeof spec.label === "string" && spec.label.trim() !== "") argv.push("--label", spec.label.trim().slice(0, 120));
  for (const ref of context.refSourceIds) argv.push("--ref-source-id", ref);
  if (context.sourceNodeId) argv.push("--source-node-id", context.sourceNodeId);
  return {
    kind: "image",
    prompt,
    aspect_ratio: aspectRatio,
    model,
    image_size: imageSize,
    cost_usd: getCost(model, { image_size: imageSize }),
    script: "generate_image.js",
    argv,
  };
}

function videoPayload(spec, context) {
  const prompt = truncateString(spec.prompt, MAX_PROMPT_CHARS);
  if (!prompt) throw Object.assign(new Error("stage_video requires prompt"), { klass: "bad_args" });
  const duration = Number.isFinite(Number(spec.duration)) ? Math.max(1, Math.min(30, Number(spec.duration))) : 5;
  const resolution = typeof spec.resolution === "string" && spec.resolution !== ""
    ? spec.resolution
    : "720p";
  const aspectRatio = typeof spec.aspect_ratio === "string" && spec.aspect_ratio !== ""
    ? spec.aspect_ratio
    : context?.source_result?.aspect_ratio || "16:9";
  const model = getDefault("video").id;
  const argv = [
    "--prompt", prompt,
    "--duration", String(duration),
    "--aspect-ratio", aspectRatio,
    "--resolution", resolution,
  ];
  if (typeof spec.label === "string" && spec.label.trim() !== "") argv.push("--label", spec.label.trim().slice(0, 120));
  for (const ref of context.refSourceIds) argv.push("--ref-source-id", ref);
  if (context.sourceNodeId) argv.push("--source-node-id", context.sourceNodeId);
  return {
    kind: "video",
    prompt,
    aspect_ratio: aspectRatio,
    model,
    resolution,
    duration,
    cost_usd: getCost(model, { resolution, duration }),
    script: "generate_video.js",
    argv,
  };
}

function voicePayload(spec, context) {
  const prompt = truncateString(spec.prompt, MAX_PROMPT_CHARS);
  const text = truncateString(spec.text, MAX_TEXT_CHARS);
  if (!prompt) throw Object.assign(new Error("stage_voice requires prompt"), { klass: "bad_args" });
  if (!text) throw Object.assign(new Error("stage_voice requires text"), { klass: "bad_args" });
  const model = getDefault("voice").id;
  const argv = ["--text", text, "--prompt", prompt];
  if (context.sourceNodeId) argv.push("--source-node-id", context.sourceNodeId);
  return {
    kind: "audio",
    prompt,
    aspect_ratio: "16:9",
    model,
    text,
    cost_usd: getCost(model, { text }),
    script: "generate_voice.js",
    argv,
  };
}

function payloadForSpec(spec, context) {
  if (spec.kind === "stage_image") return imagePayload(spec, context);
  if (spec.kind === "stage_video") return videoPayload(spec, context);
  if (spec.kind === "stage_voice") return voicePayload(spec, context);
  throw Object.assign(new Error(`unsupported draft action kind: ${spec.kind}`), { klass: "bad_args" });
}

async function fileExists(abs) {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonIfAbsent(target, payload) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n");
    await fsp.link(tmp, target);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

export async function stageDraftFromSpec(projectId, spec, {
  project,
  continuationId,
  actionIndex = 0,
  sourceJobIds = [],
  sourceResult = null,
} = {}) {
  if (!projectId || !spec || typeof spec !== "object") {
    throw Object.assign(new Error("stageDraftFromSpec requires projectId and spec"), { klass: "bad_args" });
  }
  const refSourceIds = cleanRefIds(spec.ref_source_ids);
  const sourceNodeId = cleanSourceNodeId(spec.source_node_id);
  validateRefs({ project, refSourceIds, sourceNodeId });

  const jobId = hashId([
    "continuation-stage",
    projectId,
    continuationId,
    actionIndex,
    spec.kind,
    spec.prompt,
    spec.text,
    refSourceIds,
    sourceNodeId,
  ]);
  const resultTarget = path.join(resultsDir(projectId), `${jobId}.json`);
  if (await fileExists(resultTarget)) {
    return { ok: true, job_id: jobId, created: false, reason: "result_exists" };
  }

  const payload = payloadForSpec(spec, {
    refSourceIds,
    sourceNodeId,
    source_result: sourceResult,
  });
  const sidecar = {
    id: jobId,
    stage: "draft",
    created_at: isoNow(),
    ...payload,
    reference_source_ids: refSourceIds,
    ...(sourceNodeId ? { source_node_id: sourceNodeId } : {}),
    origin: {
      kind: "agent_continuation",
      continuation_id: continuationId || null,
      source_job_ids: sourceJobIds,
      action_index: actionIndex,
      rationale: typeof spec.rationale === "string" ? spec.rationale.slice(0, 1000) : "",
    },
  };
  const created = await writeJsonIfAbsent(path.join(pendingDir(projectId), `${jobId}.json`), sidecar);
  return { ok: true, job_id: jobId, created };
}
