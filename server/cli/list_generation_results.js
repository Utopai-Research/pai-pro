#!/usr/bin/env node
// Print compact summaries of completed generation jobs from .results/.
// Unlike wait_for_generation.js, this does not poll; it lists terminal
// records that already exist.

import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { readResultDir } from "../lib/readers.js";

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
  const results = await readResultDir(projectId, {
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
