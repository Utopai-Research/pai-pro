// canvas_mutate.js — CLI front-end for the canvas mutator. Parses argv,
// builds an envelope, hands it to _mutate_helper.postMutation (which owns
// the HTTP transport + retry semantics), prints one JSON line on stdout.
//
// Replaces the agent's (and other CLIs') Read/Edit/Write of workflow.json.
//
// Args:
//   --op <name>              one of the mutator ops (addNode, addEdge, ...)
//   --payload-json <json>    inline JSON payload
//   --payload-stdin          read payload JSON from stdin
//   --project-id <id>        optional; defaults to the active project
//                            (cwd-walk to projects/<id>/, fall back to
//                            .active_project)
//   --request-id <id>        optional; auto-minted as canvas-mutate-<ts>-<rand>
//   --actor <name>           optional; defaults to "cli:canvas-mutate"
//   --port <port>            optional; defaults to env VIEWER_PORT or 7488
//   --host <host>            optional; defaults to env VIEWER_HOST or localhost

import { parseArgs, emitSuccess, emitFailure } from "./_cli.js";
import { postMutation } from "./_mutate_helper.js";

const args = parseArgs({
  op: { type: "string" },
  "payload-json": { type: "string" },
  "payload-stdin": { type: "boolean" },
  "project-id": { type: "string" },
  "request-id": { type: "string" },
  actor: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
});

if (!args.op) {
  emitFailure("bad_args", "--op required");
  process.exit(2);
}

let payload;
if (args["payload-stdin"]) {
  payload = JSON.parse(await readStdin());
} else if (args["payload-json"]) {
  try {
    payload = JSON.parse(args["payload-json"]);
  } catch (e) {
    emitFailure("bad_args", `--payload-json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
} else {
  emitFailure("bad_args", "--payload-json or --payload-stdin required");
  process.exit(2);
}

const m = await postMutation({
  op: args.op,
  payload,
  requestId: args["request-id"],
  projectId: args["project-id"],
  actor: args.actor || "cli:canvas-mutate",
  ...(args.port ? { port: parseInt(args.port, 10) } : {}),
  ...(args.host ? { host: args.host } : {}),
});

if (m.ok) {
  emitSuccess({
    request_id: m.request_id,
    project_id: m.project_id,
    applied: m.reply.applied,
    assigned: m.reply.assigned,
    version: m.reply.version,
  });
  process.exit(0);
}

emitFailure(
  m.reply.klass || "infra",
  m.reply.message || `viewer ${m.status}`,
  { request_id: m.request_id, project_id: m.project_id },
);
process.exit(1);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
