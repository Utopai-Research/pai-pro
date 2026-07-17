#!/usr/bin/env node
// CLI wrapper for voice design / TTS via PAI raw passthrough
// (model id: tts). `text` is what the voice says; `prompt` is the
// design brief (timbre, tone, age, accent, mood). Without
// --source-node-id the CLI creates a free-floating audio_result
// (subtype: voice) — for narration, V.O., or any voice not anchored
// to a canvas node. Pricing per-500-input-chars in
// server/model_registry.js → voiceCostByChars.

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, truncateLabel } from "./_cli.js";
import { generateVoice as paiGenerateVoice } from "../pai_voice_client.js";
import { getDefault, getCost } from "../model_registry.js";
import {
  writeBytesToTmp,
  viewerUrlForLocalPath,
  readActiveProject,
} from "../local_mirror.js";
import { postMutation } from "./_mutate_helper.js";
import {
  fireDraft,
  fireAndWait,
  isBypassEnabled,
  newJobId,
  reserveAutoBudget,
  waitForReviewResult,
  writePending,
  writeResultSidecar,
  removePending,
  removePendingSync,
} from "./_pending.js";
import { kickPreupload } from "./_preupload_hook.js";
import { VOICE_LIMITS } from "./_limits.js";

const rawArgv = process.argv.slice(2);

const args = parseArgs({
  text:   { type: "string" },
  prompt: { type: "string", short: "p" },
  "source-node-id":    { type: "string" }, // authorship edge — see PROJECT_AGENT.md
  "project-id":        { type: "string" },
  "request-id":        { type: "string" },
  "no-canvas-write":   { type: "boolean" },
  // Draft gate — see PROJECT_AGENT.md § "Draft gate".
  stage:               { type: "boolean" },
  "draft-only":        { type: "boolean" },
  "existing-job-id":   { type: "string" },
  "auto-run-id":       { type: "string" },
});

function buildSent() {
  return {
    text_chars: (args.text || "").length,
    prompt_chars: (args.prompt || "").length,
    source_node_id: args["source-node-id"] || null,
  };
}

function fail(klass, message, extra = {}) {
  return emitFailure(klass, message, { limits: VOICE_LIMITS, sent: buildSent(), ...extra });
}

if (!args.text)   { fail("bad_args", "missing --text");   process.exit(2); }
if (!args.prompt) { fail("bad_args", "missing --prompt"); process.exit(2); }

const PLANNED_MODEL = getDefault("voice").id;
const jobId = args["existing-job-id"] || newJobId();
const routeOwnedPending = !!args["existing-job-id"];
const sourceNodeId = args["source-node-id"] || null;

if (args["auto-run-id"] !== undefined) {
  if (args["auto-run-id"] === "") {
    fail("bad_args", "--auto-run-id must not be empty");
    process.exit(2);
  }
  if (!args.stage && !routeOwnedPending) {
    fail("bad_args", "--auto-run-id requires --stage so the run's budget is reserved before spending");
    process.exit(2);
  }
}

if (args.stage && !routeOwnedPending) {
  const costUsd = getCost(PLANNED_MODEL, { text: args.text });
  const autoRunId = args["auto-run-id"] || null;
  const autoProjectId = autoRunId
    ? args["project-id"] || (await readActiveProject().catch(() => null))
    : null;
  if (autoRunId) {
    const reserved = await reserveAutoBudget({
      projectId: autoProjectId,
      runId: autoRunId,
      jobId,
      kind: "audio",
      model: PLANNED_MODEL,
      prompt: args.prompt,
      costUsd,
    });
    if (!reserved.ok) {
      const { ok, klass, message, error, ...extra } = reserved;
      fail(klass || "budget_exceeded", message || error || "auto budget reservation failed", extra);
      process.exit(klass === "bad_args" ? 2 : 1);
    }
  }
  const replayArgv = rawArgv.filter((a) => a !== "--stage" && a !== "--draft-only");
  const staged = await writePending({
    jobId,
    kind: "audio",
    stage: "draft",
    prompt: args.prompt,
    sourceNodeId,
    referenceSourceIds: [],
    model: PLANNED_MODEL,
    costUsd,
    script: "generate_voice.js",
    argv: replayArgv,
    text: args.text,
    autoRunId,
  });
  if (!staged) {
    fail("infra", "failed to write draft sidecar");
    process.exit(1);
  }
  emitSuccess({ stage: "draft", job_id: jobId, model: PLANNED_MODEL, cost_usd: costUsd });
  try {
    const bypassEnabled = await isBypassEnabled();
    const shouldFire = bypassEnabled || !!autoRunId;
    if (args["draft-only"] && !shouldFire) process.exit(0);
    const projectId = shouldFire
      ? args["project-id"] || (await readActiveProject())
      : null;
    if (args["draft-only"]) {
      const fired = await fireDraft({ projectId, jobId });
      process.stdout.write(JSON.stringify({
        ...fired,
        ...(fired.ok ? { stage: "running", fired: true } : {}),
      }) + "\n");
      process.exit(fired.ok ? 0 : 1);
    }
    const result = shouldFire
      ? await fireAndWait({
          projectId,
          jobId,
          kind: "audio",
        })
      : await waitForReviewResult(jobId, { kind: "audio" });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    fail(classify(e), e.message);
    process.exit(1);
  }
}

if (!routeOwnedPending) {
  const cleanup = () => removePendingSync(jobId);
  process.on("SIGINT",  () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

await writePending({
  jobId,
  kind: "audio",
  prompt: args.prompt,
  sourceNodeId,
  referenceSourceIds: [],
  model: PLANNED_MODEL,
  text: args.text,
  autoRunId: args["auto-run-id"] || null,
});

let exitCode = 0;
let emitted = null;
try {
  const projectId = args["project-id"] || (await readActiveProject());

  const result = await paiGenerateVoice({ text: args.text, prompt: args.prompt });
  // PAI's tts returns the MP3 bytes inline (decoded from the upstream
  // envelope's body_base64). Stage the bytes to the .tmp/ holding area;
  // the mutator renames into assets/audios/<node-id>.mp3 below.
  const staged = await writeBytesToTmp({
    bytes: result.bytes,
    mimeType: result.mime,
    projectId,
  });
  const tmpAbsPath = staged.absolute_path;
  const ext = path.extname(tmpAbsPath);

  const modelName = PLANNED_MODEL;
  const durationSec = result.audioDurationSec ?? null;
  const wallClockSec = result.wallClockSec;
  const generatedAt = isoNow();

  let assignedNodeId = null;
  let canvasMutationFragment = null;
  if (!args["no-canvas-write"]) {
    const audioData = {
      subtype: "voice",
      label: truncateLabel(args.text),
      text: args.text,
      prompt: args.prompt,
      ...(sourceNodeId ? { source_id: sourceNodeId } : {}),
      metadata: {
        source: "pai",
        task_type: "tts",
        model: modelName,
        ...(durationSec !== null ? { duration_sec: durationSec } : {}),
        generated_at: generatedAt,
        pending_job_id: jobId,
      },
    };
    const mutPayload = {
      nodes: [{ type: "audio_result", data: audioData, tmp_path: tmpAbsPath }],
      ...(sourceNodeId
        ? { edges: [{ from: sourceNodeId, to: "$0", kind: "derived" }] }
        : {}),
    };
    const m = await postMutation({
      op: "addBatch",
      payload: mutPayload,
      requestId: args["request-id"],
      projectId: args["project-id"],
      actor: "cli:generate_voice",
      pendingJobId: jobId,
    });
    if (m.ok) {
      assignedNodeId = m.reply.assigned?.node_ids?.[0] ?? null;
      canvasMutationFragment = {
        canvas_mutation: {
          node_id: assignedNodeId,
          version: m.reply.version,
          request_id: m.request_id,
        },
      };
    } else {
      canvasMutationFragment = {
        canvas_mutation_error: {
          klass: m.reply.klass || "infra",
          message: m.reply.message || `viewer ${m.status}`,
          request_id: m.request_id,
        },
      };
    }
  }
  if (!assignedNodeId) {
    await fs.unlink(tmpAbsPath).catch(() => {});
  }
  if (canvasMutationFragment?.canvas_mutation_error) {
    const err = new Error(canvasMutationFragment.canvas_mutation_error.message || "canvas mutation failed");
    err.klass = canvasMutationFragment.canvas_mutation_error.klass || "infra";
    throw err;
  }
  const localPath = assignedNodeId
    ? `assets/audios/${assignedNodeId}${ext}`
    : null;
  // PAI tts returns bytes inline, so there's no provider-side URL to fall
  // back on if the canvas mutation failed. output_url is null in that
  // case; the user regenerates. The freeze/charge accounting on the PAI
  // side is independent of our mutation outcome.
  const url = localPath
    ? viewerUrlForLocalPath({ localPath, projectId })
    : null;

  if (localPath) {
    await kickPreupload({ projectId, localPath });
  }

  const payload = {
    output_url: url,
    ...(localPath ? { local_path: localPath } : {}),
    model: modelName,
    text: args.text,
    prompt: args.prompt,
    audio_duration_seconds: durationSec,
    wall_clock_seconds: wallClockSec,
    generated_at: generatedAt,
    ...(canvasMutationFragment || {}),
  };

  emitted = emitSuccess(payload);
} catch (e) {
  emitted = fail(classify(e), e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {});
  exitCode = 1;
} finally {
  // Route-owned fires get their durable result written by the fire route
  // from captured stdout; a direct/bypass CLI run persists its own.
  if (!routeOwnedPending) {
    if (emitted) await writeResultSidecar(jobId, { ...emitted, kind: "audio" });
    await removePending(jobId);
  }
}
process.exit(exitCode);
