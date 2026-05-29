import fsp from "node:fs/promises";
import path from "node:path";

import { continuationEventsDir } from "./paths.js";

export const AGENT_RESULT_CONSUMER_HEADER = "x-pai-agent-result-consumer";
export const WAITING_CLI_RESULT_CONSUMER = "waiting-cli";

const KIND = "generation_result";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "aborted", "timeout"]);

function isoNow() {
  return new Date().toISOString();
}

function eventIdForJob(jobId) {
  return `continuation_event_${jobId}`;
}

function fileSafeEventId(eventId) {
  return encodeURIComponent(eventId).replace(/%/g, "_");
}

function eventPath(projectId, eventId) {
  return path.join(continuationEventsDir(projectId), `${fileSafeEventId(eventId)}.json`);
}

function normalizeStatus(result) {
  if (TERMINAL_STATUSES.has(result?.status)) return result.status;
  if (result?.ok === true && !result?.canvas_mutation_error) return "succeeded";
  if (result?.klass === "aborted") return "aborted";
  if (result?.klass === "timeout") return "timeout";
  return "failed";
}

function jobIdFromResult(result) {
  return typeof result?.job_id === "string" && result.job_id !== ""
    ? result.job_id
    : typeof result?.jobId === "string" && result.jobId !== ""
      ? result.jobId
      : null;
}

export function continuationEventRecord(result) {
  const jobId = jobIdFromResult(result);
  if (!jobId) return null;
  return {
    id: eventIdForJob(jobId),
    kind: KIND,
    job_id: jobId,
    status: normalizeStatus(result),
    created_at: isoNow(),
    consumed_at: null,
    continuation_id: null,
    attempt_count: 0,
    last_attempt_at: null,
    next_retry_at: null,
    last_error: null,
  };
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

async function overwriteJson(target, payload) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n");
  await fsp.rename(tmp, target);
}

function validEvent(raw) {
  return raw && typeof raw === "object"
    && raw.kind === KIND
    && typeof raw.id === "string"
    && raw.id !== ""
    && typeof raw.job_id === "string"
    && raw.job_id !== "";
}

async function readEventFile(abs) {
  try {
    const parsed = JSON.parse(await fsp.readFile(abs, "utf8"));
    if (!validEvent(parsed)) return null;
    return { ...parsed, _path: abs };
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      console.warn(`[viewer] continuation event read skipped (${abs}): ${e.message}`);
    }
    return null;
  }
}

export async function enqueueContinuationEvent(projectId, result) {
  const record = continuationEventRecord(result);
  if (!projectId || !record) return { ok: false, reason: "bad_args" };
  const created = await writeJsonIfAbsent(eventPath(projectId, record.id), record);
  return { ok: true, created, event_id: record.id, job_id: record.job_id };
}

export async function readContinuationEvents(
  projectId,
  { unconsumedOnly = false, readyOnly = false, now = Date.now() } = {},
) {
  let entries;
  try {
    entries = await fsp.readdir(continuationEventsDir(projectId), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readEventFile(path.join(continuationEventsDir(projectId), entry.name));
    if (!record) continue;
    if (unconsumedOnly && record.consumed_at) continue;
    if (readyOnly && record.next_retry_at) {
      const retryAt = Date.parse(record.next_retry_at);
      if (Number.isFinite(retryAt) && retryAt > now) continue;
    }
    records.push(record);
  }
  records.sort((a, b) => {
    const at = Date.parse(a.created_at || "") || 0;
    const bt = Date.parse(b.created_at || "") || 0;
    return at - bt || a.job_id.localeCompare(b.job_id);
  });
  return records;
}

export async function markContinuationEventsConsumed(projectId, events, continuationId, consumedAt = isoNow()) {
  await Promise.all(events.map(async (event) => {
    const current = await readEventFile(event._path || eventPath(projectId, event.id));
    if (!current || current.consumed_at) return;
    const { _path: _ignored, ...payload } = current;
    await overwriteJson(event._path || eventPath(projectId, event.id), {
      ...payload,
      consumed_at: consumedAt,
      continuation_id: continuationId,
      next_retry_at: null,
      last_error: null,
    });
  }));
}

export async function markContinuationEventsFailed(
  projectId,
  events,
  error,
  { retryDelayMs = 60_000, failedAt = isoNow() } = {},
) {
  const nextRetryAt = new Date(Date.parse(failedAt) + Math.max(0, retryDelayMs)).toISOString();
  await Promise.all(events.map(async (event) => {
    const current = await readEventFile(event._path || eventPath(projectId, event.id));
    if (!current || current.consumed_at) return;
    const { _path: _ignored, ...payload } = current;
    await overwriteJson(event._path || eventPath(projectId, event.id), {
      ...payload,
      attempt_count: Number.isFinite(payload.attempt_count) ? payload.attempt_count + 1 : 1,
      last_attempt_at: failedAt,
      next_retry_at: nextRetryAt,
      last_error: {
        message: String(error?.message || error || "continuation failed").slice(0, 1000),
        reason: typeof error?.reason === "string" ? error.reason : "worker_failed",
      },
    });
  }));
}

export function resetContinuationEventStateForTests() {
  // Kept for symmetry with the old notification module. This module has no
  // process-local timers.
}
