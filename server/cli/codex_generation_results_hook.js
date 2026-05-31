#!/usr/bin/env node
// Codex UserPromptSubmit hook: inject newly completed generation results
// into the next model turn. This is deliberately pull-on-turn, not a PTY
// wakeup; idle Codex sessions stay idle until the user speaks again.

import fsp from "node:fs/promises";
import path from "node:path";

import { readResultDir } from "../lib/readers.js";

const MAX_SCAN_RESULTS = 50;
const MAX_CONTEXT_RESULTS = MAX_SCAN_RESULTS;
const MAX_SEEN_JOB_IDS = 200;
const STATE_PATH = path.join(process.cwd(), ".codex", "pai-generation-results-state.json");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function empty() {
  emit({});
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n");
}

function truncate(value, max) {
  if (typeof value !== "string") return undefined;
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)) + "...";
}

function compactResult(result) {
  const out = {
    job_id: result.job_id,
    kind: result.kind,
    status: result.status,
    ok: result.ok,
  };
  for (const key of [
    "completed_at",
    "klass",
    "node_id",
    "local_path",
    "output_url",
    "model",
    "size",
    "aspect_ratio",
    "image_size",
    "resolution",
    "duration",
    "cost_usd",
    "source_node_id",
  ]) {
    if (result[key] !== undefined && result[key] !== null && result[key] !== "") {
      out[key] = result[key];
    }
  }
  const message = truncate(result.message, 700);
  if (message) out.message = message;
  const prompt = truncate(result.prompt, 300);
  if (prompt) out.prompt = prompt;
  const text = truncate(result.text, 240);
  if (text) out.text = text;
  if (Array.isArray(result.reference_source_ids) && result.reference_source_ids.length > 0) {
    out.reference_source_ids = result.reference_source_ids;
  }
  if (result.ok === false) {
    if (result.sent && typeof result.sent === "object") out.sent = result.sent;
    if (result.limits && typeof result.limits === "object") out.limits = result.limits;
  }
  return out;
}

function buildContext({ projectId, results, omittedCount }) {
  const payload = {
    project_id: projectId,
    result_count: results.length,
    results: results.map(compactResult),
  };
  if (omittedCount > 0) payload.omitted_count = omittedCount;
  return [
    "<pai_generation_results>",
    "New terminal media generation results were written since the last Codex prompt hook. Reconcile relevant successes, failures, or cancellations before answering the user. Use node_id values as canvas refs for follow-up generation.",
    JSON.stringify(payload, null, 2),
    "</pai_generation_results>",
  ].join("\n");
}

try {
  const meta = await readJson(path.join(process.cwd(), "meta.json"), null);
  const projectId = typeof meta?.id === "string" ? meta.id : "";
  if (!projectId) {
    empty();
    process.exit(0);
  }

  const state = await readJson(STATE_PATH, {});
  const seen = new Set(Array.isArray(state.seen_job_ids) ? state.seen_job_ids : []);
  const results = await readResultDir(projectId, { limit: MAX_SCAN_RESULTS });
  const jobIds = results.map((r) => r.job_id).filter((v) => typeof v === "string" && v !== "");
  const unseen = results.filter((r) => r.job_id && !seen.has(r.job_id));

  const now = new Date().toISOString();
  const nextSeen = Array.from(new Set([...jobIds, ...seen])).slice(0, MAX_SEEN_JOB_IDS);
  await writeJson(STATE_PATH, {
    seen_job_ids: nextSeen,
    last_checked_at: now,
    last_emitted_at: unseen.length > 0 ? now : state.last_emitted_at ?? null,
  });

  if (unseen.length === 0) {
    empty();
    process.exit(0);
  }

  const contextResults = unseen.slice(0, MAX_CONTEXT_RESULTS);
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildContext({
        projectId,
        results: contextResults,
        omittedCount: Math.max(0, unseen.length - contextResults.length),
      }),
    },
  });
} catch {
  // Hooks should never block the user's next turn. If reconciliation fails,
  // the agent can still call list_generation_results.js manually.
  empty();
}
