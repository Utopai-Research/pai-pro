// canvas_layout.js — CLI front-end for the canvas_positions sidecar.
// Applies node positions and group frames in one viewer request so
// agent-authored canvas organization cannot half-apply.

import { parseArgs, emitSuccess, emitFailure } from "./_cli.js";
import { readActiveProject } from "../local_mirror.js";

const DEFAULT_PORT = parseInt(process.env.VIEWER_PORT ?? "7488", 10);
const DEFAULT_HOST = process.env.VIEWER_HOST || "localhost";

const args = parseArgs({
  "layout-json": { type: "string" },
  "layout-stdin": { type: "boolean" },
  "project-id": { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
});

let layout;
if (args["layout-stdin"]) {
  try {
    layout = JSON.parse(await readStdin());
  } catch (e) {
    emitFailure("bad_args", `stdin is not valid JSON: ${e.message}`);
    process.exit(2);
  }
} else if (args["layout-json"]) {
  try {
    layout = JSON.parse(args["layout-json"]);
  } catch (e) {
    emitFailure("bad_args", `--layout-json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
} else {
  emitFailure("bad_args", "--layout-json or --layout-stdin required");
  process.exit(2);
}

const projectId = args["project-id"] || (await readActiveProject());
const port = args.port ? parseInt(args.port, 10) : DEFAULT_PORT;
const host = args.host || DEFAULT_HOST;
const url = `http://${host}:${port}/projects/${encodeURIComponent(projectId)}/canvas-layout`;

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    emitFailure(
      res.status >= 500 ? "infra" : "bad_args",
      body.error || `viewer ${res.status}`,
      { project_id: projectId },
    );
    process.exit(res.status >= 500 ? 1 : 2);
  }
  emitSuccess({
    project_id: projectId,
    positions: Object.keys(body.state?.positions ?? {}).length,
    group_frames: Object.keys(body.state?.groupFrames ?? {}).length,
  });
} catch (e) {
  emitFailure("infra", e?.message || String(e), { project_id: projectId });
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
