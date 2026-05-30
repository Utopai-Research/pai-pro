import fsp from "node:fs/promises";
import path from "node:path";

import { agentContinuationsDir } from "./paths.js";

export const AGENT_CONTINUATIONS_BUNDLE_LIMIT = 20;

function isoNow() {
  return new Date().toISOString();
}

function safeFileId(id) {
  return encodeURIComponent(String(id || "")).replace(/%/g, "_");
}

function continuationPath(projectId, continuationId) {
  return path.join(agentContinuationsDir(projectId), `${safeFileId(continuationId)}.json`);
}

function normalizeStatus(status) {
  return status === "running" || status === "failed" || status === "applied"
    ? status
    : "pending";
}

export function normalizeContinuationRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (!id) return null;
  const jobIds = Array.isArray(raw.job_ids)
    ? raw.job_ids.filter((v) => typeof v === "string" && v !== "")
    : [];
  const createdAt = typeof raw.created_at === "string" && raw.created_at !== ""
    ? raw.created_at
    : isoNow();
  const out = {
    id,
    project_id: typeof raw.project_id === "string" ? raw.project_id : null,
    provider: typeof raw.provider === "string" ? raw.provider : null,
    source: typeof raw.source === "string" ? raw.source : "browser_fired_generation",
    job_ids: jobIds,
    created_at: createdAt,
    updated_at: typeof raw.updated_at === "string" && raw.updated_at !== "" ? raw.updated_at : createdAt,
    status: normalizeStatus(raw.status),
    summary: typeof raw.summary === "string" ? raw.summary : "",
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
    suggested_next_steps: Array.isArray(raw.suggested_next_steps) ? raw.suggested_next_steps : [],
    applied: raw.applied && typeof raw.applied === "object" ? raw.applied : { staged_job_ids: [], note_ids: [] },
  };
  if (raw.error && typeof raw.error === "object") out.error = raw.error;
  if (raw.usage && typeof raw.usage === "object") out.usage = raw.usage;
  if (raw.raw_provider && typeof raw.raw_provider === "object") out.raw_provider = raw.raw_provider;
  return out;
}

export async function writeAgentContinuation(projectId, record) {
  const normalized = normalizeContinuationRecord({
    ...record,
    project_id: record?.project_id || projectId,
    updated_at: record?.updated_at || isoNow(),
  });
  if (!normalized) throw new Error("invalid continuation record");
  const dir = agentContinuationsDir(projectId);
  await fsp.mkdir(dir, { recursive: true });
  const target = continuationPath(projectId, normalized.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n");
  await fsp.rename(tmp, target);
  return normalized;
}

export async function readAgentContinuation(projectId, continuationId) {
  try {
    const parsed = JSON.parse(await fsp.readFile(continuationPath(projectId, continuationId), "utf8"));
    return normalizeContinuationRecord(parsed);
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
      console.warn(`[viewer] continuation read error (${projectId}/${continuationId}): ${e.message}`);
    }
    return null;
  }
}

function sortTime(record) {
  return Date.parse(record.updated_at || record.created_at || "") || 0;
}

export function compareContinuations(a, b) {
  return sortTime(b) - sortTime(a) || String(b.id).localeCompare(String(a.id));
}

export async function readAgentContinuationDir(projectId, { limit = AGENT_CONTINUATIONS_BUNDLE_LIMIT } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(agentContinuationsDir(projectId), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    console.warn(`[viewer] continuation dir scan error (${projectId}): ${e.message}`);
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await fsp.readFile(path.join(agentContinuationsDir(projectId), entry.name), "utf8"),
      );
      const record = normalizeContinuationRecord(parsed);
      if (record) out.push(record);
    } catch (e) {
      console.warn(`[viewer] continuation dir entry skipped (${projectId}/${entry.name}): ${e.message}`);
    }
  }
  out.sort(compareContinuations);
  const bounded = Number.isFinite(limit) && limit >= 0 ? limit : AGENT_CONTINUATIONS_BUNDLE_LIMIT;
  return out.slice(0, bounded);
}
