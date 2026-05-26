#!/usr/bin/env node
// Print compact summaries of completed generation jobs from .results/.
// Unlike wait_for_generation.js, this does not poll; it lists terminal
// records that already exist.

import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { readResultDir } from "../lib/readers.js";
import { projectDir, resultsDir } from "../lib/paths.js";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(klass, message, exitCode = 1) {
  emit({ ok: false, klass, message });
  process.exit(exitCode);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      recent: { type: "string" },
      "job-id": { type: "string", multiple: true },
      since: { type: "string" },
      failed: { type: "boolean" },
      raw: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  }));
} catch (e) {
  fail("bad_args", `argv: ${e.message}`, 2);
}

const jobIds = Array.isArray(values["job-id"])
  ? values["job-id"].filter((v) => typeof v === "string" && v !== "")
  : [];
const recentExplicit = values.recent !== undefined;
let limit = jobIds.length > 0 ? undefined : 10;
if (recentExplicit) {
  limit = Number(values.recent);
  if (!Number.isInteger(limit) || limit < 0) {
    fail("bad_args", "--recent must be a non-negative integer", 2);
  }
}
if (values.since !== undefined && !Number.isFinite(Date.parse(values.since))) {
  fail("bad_args", "--since must be a valid ISO timestamp", 2);
}

let meta;
try {
  meta = JSON.parse(await fsp.readFile(path.join(process.cwd(), "meta.json"), "utf8"));
} catch (e) {
  fail("bad_args", `cannot read project meta.json from cwd: ${e.message}`, 2);
}
const projectId = meta?.id;
if (typeof projectId !== "string" || projectId === "") {
  fail("bad_args", "project meta.json is missing id", 2);
}

try {
  const results = values.raw
    ? await readRawResults(projectId, { limit, since: values.since, failedOnly: !!values.failed, jobIds })
    : await readResultDir(projectId, {
        limit,
        since: values.since,
        failedOnly: !!values.failed,
        jobIds,
      });
  const foundIds = new Set(results.map((r) => r.job_id).filter(Boolean));
  const missing = jobIds.filter((id) => !foundIds.has(id));
  const payload = {
    ok: true,
    project_id: projectId,
    count: results.length,
    results,
  };
  if (missing.length > 0) payload.missing_job_ids = missing;
  emit(payload);
} catch (e) {
  fail("infra", e.message || String(e), 1);
}

async function readRawResults(projectId, { limit, since, failedOnly, jobIds }) {
  const dir = resultsDir(projectId);
  const jobIdSet = jobIds.length > 0 ? new Set(jobIds) : null;
  const sinceMs = since ? Date.parse(since) : null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const jobId = entry.name.slice(0, -".json".length);
    if (jobIdSet && !jobIdSet.has(jobId)) continue;
    const abs = path.join(projectDir(projectId), ".results", entry.name);
    const [rawText, st] = await Promise.all([
      fsp.readFile(abs, "utf8"),
      fsp.stat(abs),
    ]);
    const raw = JSON.parse(rawText);
    if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") continue;
    const completedAtMs = Date.parse(raw.completed_at || "");
    const sortTime = Number.isFinite(completedAtMs) ? completedAtMs : st.mtimeMs;
    if (sinceMs !== null && sortTime < sinceMs) continue;
    if (failedOnly && raw.ok !== false) continue;
    out.push({
      raw: { ...raw, job_id: typeof raw.job_id === "string" ? raw.job_id : jobId },
      sortTime,
    });
  }
  out.sort((a, b) => b.sortTime - a.sortTime);
  return (Number.isFinite(limit) ? out.slice(0, limit) : out).map((entry) => entry.raw);
}
