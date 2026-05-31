#!/usr/bin/env node
// Wait for a foreground batch of generation results.
// Prints one progress JSON line per completed job and one final summary line.

import { parseArgs } from "node:util";

import {
  REVIEW_WAIT_TIMEOUT_MS,
  waitForResultBatch,
} from "./_pending.js";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(klass, message, exitCode = 1) {
  emit({ ok: false, klass, message });
  process.exit(exitCode);
}

function parseNonNegativeInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail("bad_args", `${name} must be a non-negative integer`, 2);
  }
  return parsed;
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      "job-id": { type: "string", multiple: true },
      "timeout-ms": { type: "string" },
      "interval-ms": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
} catch (e) {
  fail("bad_args", `argv: ${e.message}`, 2);
}

const values = parsed.values;
const jobIds = [
  ...(Array.isArray(values["job-id"]) ? values["job-id"] : []),
  ...parsed.positionals,
].filter((id) => typeof id === "string" && id.trim() !== "");

if (jobIds.length === 0) {
  fail("bad_args", "usage: wait_for_generations.js --job-id <id> [--job-id <id> ...]", 2);
}

const result = await waitForResultBatch(jobIds, {
  timeoutMs: parseNonNegativeInt(values["timeout-ms"], "--timeout-ms", REVIEW_WAIT_TIMEOUT_MS),
  intervalMs: parseNonNegativeInt(values["interval-ms"], "--interval-ms", undefined),
  onResult: (entry) => {
    emit({
      event: "generation_result",
      job_id: entry.job_id,
      result: entry,
    });
  },
});

emit(result);
process.exit(result.ok ? 0 : 1);
