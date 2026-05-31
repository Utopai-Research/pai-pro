import fsp from "node:fs/promises";
import path from "node:path";

import { agentNotificationsDir } from "./paths.js";
import { normalizeResultEntry, readResultEntry } from "./readers.js";

export const AGENT_RESULT_CONSUMER_HEADER = "x-pai-agent-result-consumer";
export const WAITING_CLI_RESULT_CONSUMER = "waiting-cli";

const KIND = "generation_result";
const DEFAULT_DEBOUNCE_MS = 350;
const DEFAULT_REQUIRE_IDLE_MS = 1500;
const DEFAULT_RETRY_DELAYS_MS = {
  busy: 2500,
  unsafe_input: 1000,
  submit_in_progress: 1000,
  unconfirmed_submit: 5000,
  write_failed: 5000,
};

const timers = new Map();
const inFlight = new Map();
const config = {
  submitAgentNotification: null,
  publishStatus: null,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  requireIdleMs: DEFAULT_REQUIRE_IDLE_MS,
  retryDelaysMs: { ...DEFAULT_RETRY_DELAYS_MS },
};

function isoNow() {
  return new Date().toISOString();
}

function fileSafeJobId(jobId) {
  return encodeURIComponent(jobId).replace(/%/g, "_");
}

function notificationPath(projectId, jobId) {
  return path.join(agentNotificationsDir(projectId), `${fileSafeJobId(jobId)}.json`);
}

function normalizeStatus(result) {
  if (result?.status === "succeeded" || result?.status === "failed"
      || result?.status === "aborted" || result?.status === "timeout") {
    return result.status;
  }
  if (result?.ok === true && !result?.canvas_mutation_error) return "succeeded";
  if (result?.klass === "aborted" || result?.klass === "cancelled") return "aborted";
  if (result?.klass === "timeout") return "timeout";
  return "failed";
}

function notificationRecord(projectId, result) {
  const jobId = typeof result?.job_id === "string" && result.job_id !== ""
    ? result.job_id
    : typeof result?.jobId === "string" && result.jobId !== ""
      ? result.jobId
      : null;
  if (!projectId || !jobId) return null;
  return {
    id: `generation_result_${jobId}`,
    kind: KIND,
    job_id: jobId,
    status: normalizeStatus(result),
    created_at: isoNow(),
    delivered_at: null,
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

function validNotification(raw) {
  return raw && typeof raw === "object"
    && raw.kind === KIND
    && typeof raw.job_id === "string"
    && raw.job_id !== "";
}

async function readNotificationFile(abs) {
  try {
    const parsed = JSON.parse(await fsp.readFile(abs, "utf8"));
    if (!validNotification(parsed)) return null;
    return { ...parsed, _path: abs };
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      console.warn(`[viewer] agent notification read skipped (${abs}): ${e.message}`);
    }
    return null;
  }
}

export async function readAgentResultNotifications(projectId, { undeliveredOnly = false } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(agentNotificationsDir(projectId), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readNotificationFile(path.join(agentNotificationsDir(projectId), entry.name));
    if (!record) continue;
    if (undeliveredOnly && record.delivered_at) continue;
    records.push(record);
  }
  records.sort((a, b) => {
    const at = Date.parse(a.created_at || "") || 0;
    const bt = Date.parse(b.created_at || "") || 0;
    return at - bt || a.job_id.localeCompare(b.job_id);
  });
  return records;
}

async function undeliveredCount(projectId) {
  return (await readAgentResultNotifications(projectId, { undeliveredOnly: true })).length;
}

function statusForReason(reason) {
  if (reason === "unsafe_input") return "waiting_for_input";
  if (reason === "unconfirmed_submit" || reason === "write_failed") return "error";
  return "queued";
}

async function publishStatus(projectId, patch = {}) {
  if (!projectId || typeof config.publishStatus !== "function") return;
  const pending = typeof patch.pending === "number" ? patch.pending : await undeliveredCount(projectId);
  config.publishStatus(projectId, {
    projectId,
    status: pending > 0 ? "queued" : "idle",
    pending,
    ...patch,
  });
}

export async function agentResultNotificationStatus(projectId) {
  const pending = await undeliveredCount(projectId);
  return {
    projectId,
    status: pending > 0 ? "queued" : "idle",
    pending,
  };
}

export function configureAgentResultNotifications(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "submitAgentNotification")) {
    config.submitAgentNotification =
      typeof options.submitAgentNotification === "function"
        ? options.submitAgentNotification
        : null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "publishStatus")) {
    config.publishStatus =
      typeof options.publishStatus === "function"
        ? options.publishStatus
        : null;
  }
  if (typeof options.debounceMs === "number" && Number.isFinite(options.debounceMs) && options.debounceMs >= 0) {
    config.debounceMs = options.debounceMs;
  }
  if (typeof options.requireIdleMs === "number" && Number.isFinite(options.requireIdleMs) && options.requireIdleMs >= 0) {
    config.requireIdleMs = options.requireIdleMs;
  }
  if (options.retryDelaysMs && typeof options.retryDelaysMs === "object") {
    config.retryDelaysMs = { ...options.retryDelaysMs };
  }
}

export async function enqueueGenerationResultNotification(projectId, result) {
  const record = notificationRecord(projectId, result);
  if (!record) return { ok: false, reason: "bad_args" };
  const created = await writeJsonIfAbsent(notificationPath(projectId, record.job_id), record);
  await publishStatus(projectId);
  scheduleFlush(projectId);
  return { ok: true, created, job_id: record.job_id };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function oneLine(value, maxLen = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function summaryLine(summary) {
  const status = summary.status || (summary.ok ? "succeeded" : "failed");
  const bits = [`- ${summary.job_id}: ${summary.kind || "generation"} ${status}`];
  if (status === "succeeded") {
    if (summary.node_id) bits.push(`node=${summary.node_id}`);
    if (summary.local_path) bits.push(`local_path=${summary.local_path}`);
    if (!summary.node_id && summary.output_url) bits.push(`output_url=${summary.output_url}`);
  } else {
    if (summary.klass) bits.push(`klass=${summary.klass}`);
    if (summary.message) bits.push(`message=${oneLine(summary.message)}`);
  }
  return bits.join("; ");
}

export function formatGenerationResultNotification(projectId, summaries) {
  const items = Array.isArray(summaries) ? summaries.filter((s) => s?.job_id) : [];
  if (items.length === 0) return "";
  const command = [
    `node "$PAI_REPO_ROOT/server/cli/list_generation_results.js"`,
    ...items.flatMap((s) => ["--job-id", shellQuote(s.job_id)]),
  ].join(" ");
  return [
    "[task-notification]",
    `Browser-fired generation results are ready for project ${projectId}.`,
    `${items.length} job(s) reached terminal status:`,
    ...items.map(summaryLine),
    "",
    "Inspect ground truth before planning:",
    command,
    "",
    "Treat this as async result context. Use successful node_id values as refs. Explain failures plainly. Do not rerun completed jobs unless the user asks.",
    "[/task-notification]",
  ].join("\n");
}

async function loadSummaries(projectId, records) {
  const deliverable = [];
  for (const record of records) {
    const raw = await readResultEntry(projectId, record.job_id);
    const summary = normalizeResultEntry(record.job_id, raw);
    if (!summary) continue;
    deliverable.push({ record, summary });
  }
  return deliverable;
}

async function markDelivered(deliverable, deliveredAt = isoNow()) {
  await Promise.all(deliverable.map(async ({ record }) => {
    const current = await readNotificationFile(record._path);
    if (!current || current.delivered_at) return;
    const { _path: _ignored, ...payload } = current;
    await overwriteJson(record._path, { ...payload, delivered_at: deliveredAt });
  }));
}

function retryDelayForReason(reason) {
  const value = config.retryDelaysMs?.[reason];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function flushProjectNotificationsInner(projectId) {
  const records = await readAgentResultNotifications(projectId, { undeliveredOnly: true });
  if (records.length === 0) return { ok: true, delivered: 0, pending: 0 };
  if (!config.submitAgentNotification) {
    return { ok: false, reason: "no_submitter", pending: records.length };
  }

  const deliverable = await loadSummaries(projectId, records);
  if (deliverable.length === 0) {
    return { ok: false, reason: "no_results", pending: records.length };
  }

  const text = formatGenerationResultNotification(
    projectId,
    deliverable.map((item) => item.summary),
  );
  await publishStatus(projectId, { status: "sending", pending: records.length });
  const submit = await config.submitAgentNotification(projectId, text, {
    requireIdleMs: config.requireIdleMs,
  });
  if (submit?.ok) {
    await markDelivered(deliverable);
    await publishStatus(projectId);
    return {
      ok: true,
      delivered: deliverable.length,
      pending: Math.max(0, records.length - deliverable.length),
      submit,
    };
  }

  const reason = submit?.reason || "submit_failed";
  const retryDelay = retryDelayForReason(reason);
  if (retryDelay !== null) scheduleFlush(projectId, { delayMs: retryDelay });
  await publishStatus(projectId, {
    status: statusForReason(reason),
    pending: records.length,
    reason,
    ...(submit?.message ? { message: submit.message } : {}),
  });
  return { ok: false, reason, pending: records.length, submit };
}

export function flushProjectNotifications(projectId) {
  if (!projectId) return Promise.resolve({ ok: false, reason: "bad_args" });
  const existing = inFlight.get(projectId);
  if (existing) {
    scheduleFlush(projectId, { delayMs: config.debounceMs });
    return existing;
  }
  const promise = flushProjectNotificationsInner(projectId)
    .catch((e) => {
      console.warn(`[viewer] agent notification flush failed for ${projectId}:`, e);
      return { ok: false, reason: "flush_failed", message: e.message };
    })
    .finally(() => {
      if (inFlight.get(projectId) === promise) inFlight.delete(projectId);
    });
  inFlight.set(projectId, promise);
  return promise;
}

export function scheduleFlush(projectId, { delayMs } = {}) {
  if (!projectId) return false;
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
    void flushProjectNotifications(projectId);
  }, delay);
  timer.unref?.();
  timers.set(projectId, { timer, runAt });
  return true;
}

export function resetAgentResultNotificationStateForTests() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
  config.submitAgentNotification = null;
  config.publishStatus = null;
  config.debounceMs = DEFAULT_DEBOUNCE_MS;
  config.requireIdleMs = DEFAULT_REQUIRE_IDLE_MS;
  config.retryDelaysMs = { ...DEFAULT_RETRY_DELAYS_MS };
}
