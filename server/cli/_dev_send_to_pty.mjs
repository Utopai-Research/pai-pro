#!/usr/bin/env node
// _dev_send_to_pty.mjs — outer-Claude → embedded-Claude PTY bridge.
//
// Attaches to a project's already-running PTY via Socket.IO and emits
// keystrokes. Optionally captures pty:output for a return value.
//
// Background, modes, and risks: docs/proposals/01a-agent-to-pty-helper.md.
//
// Usage:
//   node server/scripts/_dev_send_to_pty.mjs \
//     --project <project-id> \
//     [--text "..." | --text-stdin] \
//     [--press-enter] [--wait-for <regex>] \
//     [--capture-seconds <N>] [--timeout <N>]
//
// One JSON line on stdout. Same failure-class taxonomy as the rest of
// the CLIs in this folder (bad_args, infra, transient_exhausted).
//
// Submission model — TWO Socket.IO CONNECTIONS:
// Empirically on 2026-05-11, sending text and a trailing \r in the same
// Socket.IO connection (even with up to 1.5 s delay between events) leaves
// the message in claude's input box unsubmitted. The pattern that DOES
// submit is: connection A sends text and disconnects; a fresh connection
// B sends bare \r. We model that explicitly. See docs/proposals/01a §3.4.

import { io } from "socket.io-client";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

dotenvConfig({ path: path.join(REPO_ROOT, ".env") });

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(klass, message, extra = {}) {
  emit({ ok: false, klass, message, ...extra });
  process.exit(klass === "bad_args" ? 2 : 1);
}

// -------------------- argv --------------------------------

let parsed;
try {
  parsed = parseArgs({
    options: {
      project: { type: "string" },
      text: { type: "string" },
      "text-stdin": { type: "boolean" },
      "press-enter": { type: "boolean", default: false },
      "wait-for": { type: "string" },
      "capture-seconds": { type: "string", default: "0" },
      timeout: { type: "string", default: "30" },
      "viewer-url": { type: "string" },
      // Optional gap (ms) between disconnect of the text-send connection
      // and the connect of the submit connection. Default 500ms — empirically
      // sufficient. Lower at your own risk; this is the gap that lets
      // claude's input handler settle so the bare \r triggers a submit.
      "phase-gap-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
} catch (e) {
  fail("bad_args", `argv: ${e.message}`);
}
const args = parsed.values;

if (!args.project) fail("bad_args", "--project required");
let text = args.text;
if (args["text-stdin"]) {
  if (text !== undefined) fail("bad_args", "use --text OR --text-stdin, not both");
  text = readFileSync(0, "utf8");
}
if (text === undefined) fail("bad_args", "--text or --text-stdin required");

const captureMs = Number(args["capture-seconds"]) * 1000;
const timeoutMs = Number(args.timeout) * 1000;
const phaseGapMs = Number(args["phase-gap-ms"] ?? 500);
const waitFor = args["wait-for"] ? new RegExp(args["wait-for"]) : null;

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  fail("bad_args", `--timeout must be a positive number of seconds (got ${args.timeout})`);
}
if (!Number.isFinite(captureMs) || captureMs < 0) {
  fail("bad_args", `--capture-seconds must be >= 0 (got ${args["capture-seconds"]})`);
}

const viewerUrl =
  args["viewer-url"] || `http://localhost:${process.env.VIEWER_PORT || 7488}`;

// --press-enter ALWAYS sends a discrete \r in phase 2, even if the text
// already ends in \n. Trailing newlines in the briefing are just line
// breaks inside claude's multi-line input box; they do NOT submit. Submit
// requires Enter as its own keystroke arriving in a separate PTY read.
const wantsSubmit = !!args["press-enter"];

const ECHO_SETTLE_MS = 1500;

// -------------------- one phase / one Socket.IO connection ----------

/**
 * Connect to the viewer, attach to the project's PTY, send `payload`,
 * optionally capture output until a regex matches or the budget expires.
 * Resolves with a result record.
 *
 * @param {Object} opts
 * @param {string} opts.payload       bytes to emit as pty:input.
 * @param {boolean} opts.captureMode  if true, capture pty:output and
 *                                    honor waitFor / captureMs / timeoutMs.
 * @param {number} opts.budgetMs      total time budget for this phase.
 */
function runPhase({ payload, captureMode, budgetMs }) {
  return new Promise((resolve) => {
    const socket = io(viewerUrl, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });

    const state = {
      attached: null,
      pid: null,
      // pty:output arrives in three phases: (1) buffer replay between
      // pty:spawned and our pty:input emit; (2) echo of our own pty:input
      // (~100-300 ms after emit); (3) the agent's actual response. Two
      // boolean flags + one ms timestamp gate the captures:
      inputSent: false,           // flips true the moment we emit pty:input
      inputEchoDoneAt: 0,         // ms cutoff for treating output as our echo
      captured: "",               // all post-attach output (debug/dump)
      agentOutput: "",            // phase 3 only — what wait-for matches
      matched: null,
      done: false,
    };

    const conclude = (err) => {
      if (state.done) return;
      state.done = true;
      try { socket.disconnect(); } catch {}
      resolve({
        ok: !err,
        klass: err?.klass || null,
        message: err?.message || null,
        attached: state.attached,
        pid: state.pid,
        captured: state.captured,
        agentOutput: state.agentOutput,
        matched: state.matched,
      });
    };

    socket.on("connect", () => {
      socket.emit("pty:spawn", { projectId: args.project, cols: 120, rows: 36 });
    });

    socket.on("pty:spawned", (info) => {
      state.attached = info.attached;
      state.pid = info.pid;
      // Settle 200 ms so any IMMEDIATE buffer-replay frames after attach
      // have a chance to arrive and be tagged as replay (inputSent=false).
      // For huge backlogs, later replay chunks still get filtered out by
      // a phase-3-only heuristic in pty:output below.
      const settleMs = 200;
      setTimeout(() => {
        if (state.done) return;
        socket.emit("pty:input", payload);
        state.inputSent = true;
        state.inputEchoDoneAt = Date.now() + ECHO_SETTLE_MS;
        if (!captureMode) {
          // Fire-and-forget — small grace for the event to reach the PTY.
          setTimeout(() => conclude(null), 200);
        }
      }, settleMs);
    });

    socket.on("pty:output", (data) => {
      if (typeof data !== "string") return;
      state.captured += data;
      if (state.captured.length > 64 * 1024) {
        state.captured = state.captured.slice(-32 * 1024);
      }
      // Phase 1 — buffer replay — discard for wait-for purposes.
      if (!state.inputSent) return;
      // Phase 2 — echo of our own input — discard.
      if (Date.now() < state.inputEchoDoneAt) return;
      // Phase 3 — agent's actual response.
      state.agentOutput += data;
      if (state.agentOutput.length > 64 * 1024) {
        state.agentOutput = state.agentOutput.slice(-32 * 1024);
      }
      if (captureMode && waitFor && state.matched === null) {
        const m = waitFor.exec(state.agentOutput);
        if (m) {
          state.matched = m[0];
          conclude(null);
        }
      }
    });

    socket.on("pty:error", (msg) => conclude({ klass: "infra", message: String(msg) }));
    socket.on("connect_error", (e) =>
      conclude({ klass: "infra", message: `connect_error: ${e.message}` }),
    );
    socket.on("disconnect", (reason) => {
      if (!state.done) conclude({ klass: "transient_exhausted", message: `disconnected: ${reason}` });
    });

    setTimeout(() => {
      if (state.done) return;
      if (captureMode) {
        conclude({
          klass: "transient_exhausted",
          message: `phase timeout after ${budgetMs}ms` + (waitFor && state.matched === null ? " (wait-for never matched)" : ""),
        });
      } else {
        conclude(null);
      }
    }, budgetMs);
  });
}

// -------------------- run --------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const startedAt = Date.now();

  // Phase 1 — send text, no submit, fire-and-forget.
  // Always runs; if text is empty, phase 1 still does the attach handshake.
  const phase1 = await runPhase({
    payload: text,
    captureMode: false,
    budgetMs: 6000,
  });
  if (!phase1.ok) {
    emit({
      ok: false,
      klass: phase1.klass,
      message: `phase1: ${phase1.message}`,
      viewer_url: viewerUrl,
      sent_bytes: text.length,
      captured: phase1.captured.slice(-8000),
      matched: null,
    });
    process.exit(1);
  }

  // If no submit needed, we're done. Done state should still emit a record
  // so callers can introspect.
  if (!wantsSubmit) {
    emit({
      ok: true,
      attached: phase1.attached,
      pid: phase1.pid,
      viewer_url: viewerUrl,
      sent_bytes: text.length,
      captured: phase1.captured.slice(-8000),
      matched: null,
    });
    process.exit(0);
  }

  // Phase gap — let claude's input handler settle.
  await sleep(phaseGapMs);

  // Phase 2 — fresh connection, send bare \r, capture output.
  const remaining = Math.max(timeoutMs - (Date.now() - startedAt), 5000);
  const phase2Budget = captureMs > 0
    ? captureMs + ECHO_SETTLE_MS + 2000
    : remaining;
  const phase2 = await runPhase({
    payload: "\r",
    captureMode: true,
    budgetMs: phase2Budget,
  });

  const finalCaptured = (phase1.captured + phase2.captured).slice(-8000);
  emit({
    ok: phase2.ok,
    ...(phase2.ok ? {} : { klass: phase2.klass, message: phase2.message }),
    attached: phase2.attached,
    pid: phase2.pid,
    viewer_url: viewerUrl,
    sent_bytes: text.length + 1, // text + the \r
    captured: finalCaptured,
    matched: phase2.matched,
  });
  process.exit(phase2.ok ? 0 : 1);
})();
