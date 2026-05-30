#!/usr/bin/env node
// Compact reader for non-chat continuation records written by the viewer.

import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./_cli.js";

const args = parseArgs({
  recent: { type: "string", default: "5" },
  "job-id": { type: "string", multiple: true, default: [] },
  status: { type: "string" },
});

const jobIds = new Set(Array.isArray(args["job-id"]) ? args["job-id"] : []);
const limit = Math.max(0, Number(args.recent) || 5);

function sortTime(record) {
  return Date.parse(record.updated_at || record.created_at || "") || 0;
}

function compact(record) {
  return {
    id: record.id,
    provider: record.provider || null,
    status: record.status || "pending",
    job_ids: Array.isArray(record.job_ids) ? record.job_ids : [],
    updated_at: record.updated_at || record.created_at || null,
    summary: typeof record.summary === "string" ? record.summary : "",
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
    suggested_next_steps: Array.isArray(record.suggested_next_steps) ? record.suggested_next_steps : [],
    applied: record.applied || { staged_job_ids: [], note_ids: [] },
    ...(record.error ? { error: record.error } : {}),
  };
}

async function main() {
  let entries;
  try {
    entries = await fsp.readdir(path.join(process.cwd(), ".agent_continuations"), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      process.stdout.write(JSON.stringify({ ok: true, continuations: [] }) + "\n");
      return;
    }
    throw e;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        await fsp.readFile(path.join(process.cwd(), ".agent_continuations", entry.name), "utf8"),
      );
      if (!record || typeof record !== "object" || typeof record.id !== "string") continue;
      if (args.status && record.status !== args.status) continue;
      const recordJobs = Array.isArray(record.job_ids) ? record.job_ids : [];
      if (jobIds.size > 0 && !recordJobs.some((jobId) => jobIds.has(jobId))) continue;
      records.push(record);
    } catch {
      // Ignore malformed records; the viewer logs richer diagnostics.
    }
  }
  records.sort((a, b) => sortTime(b) - sortTime(a));
  process.stdout.write(JSON.stringify({
    ok: true,
    continuations: records.slice(0, limit).map(compact),
  }) + "\n");
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, klass: "infra", message: e.message }) + "\n");
  process.exit(1);
});
