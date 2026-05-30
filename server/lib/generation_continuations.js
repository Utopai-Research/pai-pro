import crypto from "node:crypto";

import { getProvider, resolveAgentIdForMeta } from "../agents/index.js";
import { normalizeResultEntry, readResultEntry } from "./readers.js";
import {
  enqueueContinuationEvent,
  markContinuationEventsConsumed,
  markContinuationEventsFailed,
  readContinuationEvents,
} from "./continuation_events.js";
import {
  readAgentContinuation,
  writeAgentContinuation,
} from "./agent_continuations.js";
import { stageDraftFromSpec } from "./stage_draft_from_spec.js";

function nullable(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

const DIAGNOSTIC_PROPERTIES = {
  job_id: nullable({ type: "string" }),
  severity: nullable({ enum: ["info", "warning", "error"] }),
  message: { type: "string", maxLength: 1200 },
};

const STEP_PROPERTIES = {
  kind: { enum: ["none", "stage_image", "stage_video", "stage_voice", "note"] },
  label: nullable({ type: "string", maxLength: 160 }),
  prompt: nullable({ type: "string", maxLength: 4000 }),
  text: nullable({ type: "string", maxLength: 4000 }),
  ref_source_ids: nullable({
    type: "array",
    maxItems: 8,
    items: { type: "string" },
  }),
  source_node_id: nullable({ type: "string" }),
  rationale: nullable({ type: "string", maxLength: 1200 }),
  aspect_ratio: nullable({ type: "string", maxLength: 20 }),
  image_size: nullable({ type: "string", maxLength: 20 }),
  resolution: nullable({ type: "string", maxLength: 20 }),
  duration: nullable({ type: "number" }),
};

export const CONTINUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "diagnostics", "suggested_next_steps"],
  properties: {
    summary: { type: "string", maxLength: 2000 },
    diagnostics: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(DIAGNOSTIC_PROPERTIES),
        properties: DIAGNOSTIC_PROPERTIES,
      },
    },
    suggested_next_steps: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(STEP_PROPERTIES),
        properties: STEP_PROPERTIES,
      },
    },
  },
};

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_BATCH_LIMIT = 4;
const MAX_ACTIONS = 4;
const MAX_PROMPT_CHARS = 4000;
const MAX_TEXT_CHARS = 4000;
const timers = new Map();
const inFlight = new Map();
const needsFollowUp = new Set();

const config = {
  projects: null,
  broadcasters: null,
  enabled: false,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  batchLimit: DEFAULT_BATCH_LIMIT,
  workerRunner: null,
};

function isoNow() {
  return new Date().toISOString();
}

function continuationIdForEvents(events) {
  const key = events.map((event) => event.id).sort();
  const hash = crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 24);
  return `continuation_${hash}`;
}

function publicEvent(event) {
  const { _path: _ignored, ...out } = event;
  return out;
}

function setProjectContinuation(projectId, record) {
  const p = config.projects?.get(projectId);
  if (!p) return;
  if (!p.agentContinuations) p.agentContinuations = new Map();
  p.agentContinuations.set(record.id, record);
  config.broadcasters?.broadcastAgentContinuations?.(projectId);
}

function compactCanvasContext(project) {
  const nodes = Array.isArray(project?.canvasState?.nodes) ? project.canvasState.nodes : [];
  return nodes.slice(-80).map((node) => ({
    id: node.id,
    type: node.type,
    label: typeof node.data?.label === "string" ? node.data.label : "",
    subtype: typeof node.data?.subtype === "string" ? node.data.subtype : undefined,
    prompt: typeof node.data?.prompt === "string" ? node.data.prompt.slice(0, 800) : undefined,
    text: typeof node.data?.text === "string" ? node.data.text.slice(0, 800) : undefined,
    local_path: typeof node.data?.local_path === "string" ? node.data.local_path : undefined,
  }));
}

function resultContext(jobId, raw) {
  const summary = normalizeResultEntry(jobId, raw);
  return {
    summary,
    raw: raw && typeof raw === "object" ? raw : null,
  };
}

async function loadResultContexts(projectId, events) {
  const out = [];
  for (const event of events) {
    const raw = await readResultEntry(projectId, event.job_id);
    const ctx = resultContext(event.job_id, raw);
    if (ctx.summary) out.push(ctx);
  }
  return out;
}

function buildContinuationPrompt({ projectId, project, events, results }) {
  const context = {
    project_id: projectId,
    project_title: project?.meta?.title || projectId,
    events: events.map(publicEvent),
    results,
    recent_canvas_nodes: compactCanvasContext(project),
  };
  return [
    "You are a non-interactive PAI Pro continuation worker.",
    "You are not the live chat session. Do not ask the user questions and do not claim you typed in chat.",
    "Use only the JSON context below. Do not call tools. Do not fire paid generation.",
    "Return a JSON object matching the supplied schema.",
    "",
    "Behavior:",
    "- Summarize browser-fired generation results for the project.",
    "- For failures, diagnose the concrete cause from klass/message/sent/limits and suggest a corrected draft only when clear.",
    "- For successes, suggest useful next draft-only follow-ups when the result/provenance makes the chain clear.",
    "- Prefer origin.follow_up_policy when present. Be conservative when provenance is missing.",
    "- If staging a follow-up from a successful media node, include the successful node_id in ref_source_ids or source_node_id as appropriate.",
    "- suggested_next_steps may stage draft cards only; the server will not run them.",
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function asString(value, maxLen) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLen);
}

function normalizeDiagnostics(raw, allowedJobIds) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((diag) => {
    if (!diag || typeof diag !== "object") return null;
    const message = asString(diag.message, 1200);
    if (!message) return null;
    const out = { message };
    if (typeof diag.job_id === "string" && allowedJobIds.has(diag.job_id)) out.job_id = diag.job_id;
    if (diag.severity === "warning" || diag.severity === "error" || diag.severity === "info") {
      out.severity = diag.severity;
    } else {
      out.severity = "info";
    }
    return out;
  }).filter(Boolean);
}

function normalizeStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!["none", "stage_image", "stage_video", "stage_voice", "note"].includes(raw.kind)) return null;
  const out = { kind: raw.kind };
  for (const key of ["label", "rationale", "aspect_ratio", "image_size", "resolution"]) {
    if (typeof raw[key] === "string" && raw[key].trim() !== "") out[key] = raw[key].trim();
  }
  const prompt = asString(raw.prompt, MAX_PROMPT_CHARS);
  if (prompt) out.prompt = prompt;
  const text = asString(raw.text, MAX_TEXT_CHARS);
  if (text) out.text = text;
  if (Array.isArray(raw.ref_source_ids)) {
    out.ref_source_ids = raw.ref_source_ids.filter((v) => typeof v === "string" && v !== "").slice(0, 8);
  }
  if (typeof raw.source_node_id === "string" && raw.source_node_id !== "") out.source_node_id = raw.source_node_id;
  else if (raw.source_node_id === null) out.source_node_id = null;
  if (Number.isFinite(Number(raw.duration))) out.duration = Number(raw.duration);
  return out;
}

export function normalizeContinuationOutput(raw, { allowedJobIds = [] } = {}) {
  if (!raw || typeof raw !== "object") {
    throw Object.assign(new Error("continuation output must be an object"), { reason: "invalid_output" });
  }
  const summary = asString(raw.summary, 2000);
  if (!summary) {
    throw Object.assign(new Error("continuation output missing summary"), { reason: "invalid_output" });
  }
  const jobSet = new Set(allowedJobIds);
  const diagnostics = normalizeDiagnostics(raw.diagnostics, jobSet);
  const rawSteps = Array.isArray(raw.suggested_next_steps)
    ? raw.suggested_next_steps.slice(0, MAX_ACTIONS)
    : [];
  const suggested_next_steps = [];
  for (const rawStep of rawSteps) {
    const step = normalizeStep(rawStep);
    if (!step) {
      throw Object.assign(new Error("invalid suggested_next_steps action"), { reason: "invalid_output" });
    }
    suggested_next_steps.push(step);
  }
  for (const step of suggested_next_steps) {
    if (step.kind === "stage_image" || step.kind === "stage_video") {
      if (!step.prompt) {
        throw Object.assign(new Error(`${step.kind} requires prompt`), { reason: "invalid_output" });
      }
    }
    if (step.kind === "stage_voice" && (!step.prompt || !step.text)) {
      throw Object.assign(new Error("stage_voice requires prompt and text"), { reason: "invalid_output" });
    }
  }
  return { summary, diagnostics, suggested_next_steps };
}

function firstSuccessfulNodeResult(results) {
  const successes = results
    .map((r) => r.summary)
    .filter((summary) => summary?.status === "succeeded" && typeof summary.node_id === "string" && summary.node_id !== "");
  return successes.length === 1 ? successes[0] : null;
}

function fillDefaultRefs(step, results) {
  if (!(step.kind === "stage_image" || step.kind === "stage_video" || step.kind === "stage_voice")) return step;
  const hasRefs = Array.isArray(step.ref_source_ids) && step.ref_source_ids.length > 0;
  const hasSource = typeof step.source_node_id === "string" && step.source_node_id !== "";
  if (hasRefs || hasSource) return step;
  const source = firstSuccessfulNodeResult(results);
  if (!source) return step;
  if (step.kind === "stage_voice") return { ...step, source_node_id: source.node_id };
  return { ...step, ref_source_ids: [source.node_id] };
}

async function applyContinuationOutput({ projectId, project, continuationId, output, events, results }) {
  const stagedJobIds = [];
  const noteIds = [];
  const sourceJobIds = events.map((event) => event.job_id);
  for (let i = 0; i < output.suggested_next_steps.length; i += 1) {
    const rawStep = output.suggested_next_steps[i];
    const step = fillDefaultRefs(rawStep, results);
    if (step.kind === "none") continue;
    if (step.kind === "note") {
      continue;
    }
    const staged = await stageDraftFromSpec(projectId, step, {
      project,
      continuationId,
      actionIndex: i,
      sourceJobIds,
      sourceResult: firstSuccessfulNodeResult(results),
    });
    if (staged?.job_id) stagedJobIds.push(staged.job_id);
  }
  return { staged_job_ids: stagedJobIds, note_ids: noteIds };
}

async function defaultWorkerRunner({ provider, projectId, project, prompt, schema, continuationId }) {
  if (!provider || typeof provider.runGenerationContinuation !== "function") {
    throw Object.assign(new Error("project agent provider does not support continuations"), {
      reason: "unsupported_provider",
    });
  }
  return provider.runGenerationContinuation({
    projectId,
    meta: project?.meta,
    prompt,
    schema,
    continuationId,
  });
}

async function writeAndPublish(projectId, record) {
  const written = await writeAgentContinuation(projectId, record);
  setProjectContinuation(projectId, written);
  return written;
}

async function flushProjectContinuationsInner(projectId) {
  const project = config.projects?.get(projectId);
  if (!project) return { ok: false, reason: "no_project" };
  const events = (await readContinuationEvents(projectId, {
    unconsumedOnly: true,
    readyOnly: true,
  })).slice(0, config.batchLimit);
  if (events.length === 0) return { ok: true, processed: 0 };

  const continuationId = continuationIdForEvents(events);
  const existing = await readAgentContinuation(projectId, continuationId);
  if (existing?.status === "applied") {
    await markContinuationEventsConsumed(projectId, events, continuationId);
    if (events.length >= config.batchLimit) scheduleContinuationFlush(projectId);
    return { ok: true, processed: events.length, already_applied: true };
  }

  const providerId = resolveAgentIdForMeta(project.meta);
  const provider = getProvider(providerId);
  const results = await loadResultContexts(projectId, events);
  if (results.length === 0) return { ok: false, reason: "no_results" };

  await writeAndPublish(projectId, {
    id: continuationId,
    project_id: projectId,
    provider: providerId,
    source: "browser_fired_generation",
    job_ids: events.map((event) => event.job_id),
    created_at: existing?.created_at || isoNow(),
    status: "running",
    summary: "Agent follow-up is running.",
    diagnostics: [],
    suggested_next_steps: [],
    applied: { staged_job_ids: [], note_ids: [] },
  });

  const prompt = buildContinuationPrompt({ projectId, project, events, results });
  try {
    const worker = await (config.workerRunner || defaultWorkerRunner)({
      provider,
      providerId,
      projectId,
      project,
      prompt,
      schema: CONTINUATION_SCHEMA,
      continuationId,
      events,
      results,
    });
    const output = normalizeContinuationOutput(worker?.output ?? worker, {
      allowedJobIds: events.map((event) => event.job_id),
    });
    const applied = await applyContinuationOutput({
      projectId,
      project,
      continuationId,
      output,
      events,
      results,
    });
    const record = await writeAndPublish(projectId, {
      id: continuationId,
      project_id: projectId,
      provider: providerId,
      source: "browser_fired_generation",
      job_ids: events.map((event) => event.job_id),
      created_at: existing?.created_at || isoNow(),
      status: "applied",
      summary: output.summary,
      diagnostics: output.diagnostics,
      suggested_next_steps: output.suggested_next_steps,
      applied,
      ...(worker?.usage ? { usage: worker.usage } : {}),
      ...(worker?.raw_provider ? { raw_provider: worker.raw_provider } : {}),
    });
    await markContinuationEventsConsumed(projectId, events, continuationId);
    if (events.length >= config.batchLimit) scheduleContinuationFlush(projectId);
    return { ok: true, processed: events.length, continuation_id: record.id, applied };
  } catch (e) {
    await writeAndPublish(projectId, {
      id: continuationId,
      project_id: projectId,
      provider: providerId,
      source: "browser_fired_generation",
      job_ids: events.map((event) => event.job_id),
      created_at: existing?.created_at || isoNow(),
      status: "failed",
      summary: "Agent follow-up failed.",
      diagnostics: [],
      suggested_next_steps: [],
      applied: { staged_job_ids: [], note_ids: [] },
      error: {
        message: String(e?.message || e || "continuation failed").slice(0, 1000),
        reason: typeof e?.reason === "string" ? e.reason : "worker_failed",
      },
    });
    await markContinuationEventsFailed(projectId, events, e, { retryDelayMs: config.retryDelayMs });
    return { ok: false, reason: e?.reason || "worker_failed", message: e?.message };
  }
}

export function flushProjectContinuations(projectId) {
  if (!projectId) return Promise.resolve({ ok: false, reason: "bad_args" });
  const existing = inFlight.get(projectId);
  if (existing) {
    needsFollowUp.add(projectId);
    return existing;
  }
  const promise = flushProjectContinuationsInner(projectId)
    .catch((e) => {
      console.warn(`[viewer] continuation flush failed for ${projectId}:`, e);
      return { ok: false, reason: "flush_failed", message: e.message };
    })
    .finally(() => {
      if (inFlight.get(projectId) === promise) inFlight.delete(projectId);
      if (needsFollowUp.delete(projectId)) scheduleContinuationFlush(projectId);
    });
  inFlight.set(projectId, promise);
  return promise;
}

export function scheduleContinuationFlush(projectId, { delayMs } = {}) {
  if (!projectId || !config.enabled) return false;
  const delay = Math.max(
    0,
    typeof delayMs === "number" && Number.isFinite(delayMs) ? delayMs : config.debounceMs,
  );
  const runAt = Date.now() + delay;
  const existing = timers.get(projectId);
  if (existing && existing.runAt <= runAt) return false;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(projectId);
    void flushProjectContinuations(projectId);
  }, delay);
  timer.unref?.();
  timers.set(projectId, { timer, runAt });
  return true;
}

export async function enqueueGenerationContinuation(projectId, result) {
  const enqueued = await enqueueContinuationEvent(projectId, result);
  if (enqueued.ok && enqueued.created) scheduleContinuationFlush(projectId);
  return enqueued;
}

export function configureGenerationContinuations(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "projects")) config.projects = options.projects;
  if (Object.prototype.hasOwnProperty.call(options, "broadcasters")) config.broadcasters = options.broadcasters;
  if (typeof options.enabled === "boolean") config.enabled = options.enabled;
  if (typeof options.debounceMs === "number" && Number.isFinite(options.debounceMs) && options.debounceMs >= 0) {
    config.debounceMs = options.debounceMs;
  }
  if (typeof options.retryDelayMs === "number" && Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0) {
    config.retryDelayMs = options.retryDelayMs;
  }
  if (typeof options.batchLimit === "number" && Number.isFinite(options.batchLimit) && options.batchLimit > 0) {
    config.batchLimit = Math.floor(options.batchLimit);
  }
  if (Object.prototype.hasOwnProperty.call(options, "workerRunner")) {
    config.workerRunner = typeof options.workerRunner === "function" ? options.workerRunner : null;
  }
}

export function resetGenerationContinuationStateForTests() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
  needsFollowUp.clear();
  config.projects = null;
  config.broadcasters = null;
  config.enabled = false;
  config.debounceMs = DEFAULT_DEBOUNCE_MS;
  config.retryDelayMs = DEFAULT_RETRY_DELAY_MS;
  config.batchLimit = DEFAULT_BATCH_LIMIT;
  config.workerRunner = null;
}
