#!/usr/bin/env node
// Poll the durable result sidecar written by the viewer fire route and
// print exactly one JSON line for agent consumption.

import { waitForResult } from "./_pending.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stdout.write(JSON.stringify({
    ok: false,
    job_id: null,
    klass: "bad_args",
    message: "usage: wait_for_generation.js <job_id>",
  }) + "\n");
  process.exit(2);
}

const result = await waitForResult(jobId);
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(result.ok ? 0 : 1);
