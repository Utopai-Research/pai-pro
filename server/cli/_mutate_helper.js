// Shared helper for generation CLIs to POST a mutation envelope to the
// running viewer. Keeps the wire format and retry semantics in one place;
// see server/canvas_mutator.js for the op surface.

import { isoNow } from "./_cli.js";
import { readActiveProject } from "../local_mirror.js";

const DEFAULT_PORT = parseInt(process.env.VIEWER_PORT ?? "7488", 10);
const DEFAULT_HOST = process.env.VIEWER_HOST || "localhost";

/**
 * Post a mutation envelope to the viewer. Returns the parsed reply.
 *
 * @param {Object} opts
 * @param {string} opts.op                   one of the mutator ops
 * @param {object} opts.payload              op-specific payload
 * @param {string} [opts.requestId]          auto-minted if missing
 * @param {string} [opts.projectId]          defaults to readActiveProject()
 * @param {string} [opts.actor]              defaults to "cli"
 * @param {number} [opts.port]               defaults to env VIEWER_PORT or 7488
 * @param {string} [opts.host]               defaults to env VIEWER_HOST or "localhost"
 * @param {number} [opts.attempts]           retry budget on transport/infra errors (default 3)
 * @param {string} [opts.pendingJobId]       in-flight sidecar jobId; server hands off the
 *                                           pending pad's dragged position onto the new
 *                                           node. addBatch-only.
 * @returns {Promise<{ok:boolean, status:number, reply:object, request_id:string, project_id:string}>}
 */
export async function postMutation({
  op,
  payload,
  requestId,
  projectId,
  actor = "cli",
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  attempts = 3,
  pendingJobId,
}) {
  if (!op) throw new Error("postMutation: op required");
  const reqId =
    requestId ||
    `${actor.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pid = projectId || (await readActiveProject());
  const envelope = { request_id: reqId, op, payload, ts: isoNow(), actor };
  if (typeof pendingJobId === "string" && pendingJobId !== "") {
    envelope.pending_job_id = pendingJobId;
  }
  const url = `http://${host}:${port}/projects/${encodeURIComponent(pid)}/mutate`;

  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const reply = await resp.json().catch(() => ({}));
      // 5xx + connection failures retry; 4xx (validation, not_found,
      // conflict) returns immediately — caller's bug, not transient.
      if (resp.status >= 500) {
        lastError = new Error(`viewer ${resp.status}: ${reply?.message || "infra error"}`);
        await sleep(150 * Math.pow(2, i));
        continue;
      }
      return {
        ok: resp.ok && reply.ok,
        status: resp.status,
        reply,
        request_id: reqId,
        project_id: pid,
      };
    } catch (e) {
      lastError = e;
      await sleep(150 * Math.pow(2, i));
    }
  }
  return {
    ok: false,
    status: 0,
    reply: { ok: false, klass: "infra", message: lastError?.message || "viewer unreachable" },
    request_id: reqId,
    project_id: pid,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * addBatch with one new node + derived edges: one from --source-node-id
 * (authorship, if set), one per --ref-source-id (byte refs). Same-id
 * dups between the two are dropped so the final node has one edge per
 * logical relationship. Returns the canvas_mutation fragment for the
 * CLI's success payload, or null when --no-canvas-write was passed.
 * Pass `pendingJobId` to enable server-side position handoff.
 */
export async function postNodeAddBatch({ args, type, data, actor, tmpPath, pendingJobId }) {
  if (args["no-canvas-write"]) return null;
  const sourceNodeId = typeof args["source-node-id"] === "string" ? args["source-node-id"] : null;
  const refSourceIds = Array.isArray(args["ref-source-id"]) ? args["ref-source-id"] : [];
  const edges = [];
  if (sourceNodeId) {
    edges.push({ from: sourceNodeId, to: "$0", kind: "derived" });
  }
  for (const sid of refSourceIds) {
    if (sid === sourceNodeId) continue;
    edges.push({ from: sid, to: "$0", kind: "derived" });
  }
  const node = { type, data };
  if (tmpPath) node.tmp_path = tmpPath;
  const m = await postMutation({
    op: "addBatch",
    payload: { nodes: [node], edges },
    requestId: args["request-id"],
    projectId: args["project-id"],
    actor,
    pendingJobId,
  });
  if (m.ok) {
    return {
      canvas_mutation: {
        node_id: m.reply.assigned?.node_ids?.[0],
        version: m.reply.version,
        request_id: m.request_id,
      },
    };
  }
  return {
    canvas_mutation_error: {
      klass: m.reply.klass || "infra",
      message: m.reply.message || `viewer ${m.status}`,
      request_id: m.request_id,
    },
  };
}
