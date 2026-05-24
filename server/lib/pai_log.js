// Per-call PAI observability. Two channels per call:
//   - console.log (live tmux pane)
//   - fs.appendFile to projects/<id>/pai_calls.log (durable, greppable)
//
// Calls without project context (CreateAssetGroup) land in
// logs/orphan_pai_calls.log at the repo root.
//
// Fire-and-forget: file errors are swallowed so logging never breaks the
// parent call.

import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, projectDir } from "./paths.js";

export function logPai({ projectId, tag, message }) {
  if (process.env.PAI_LOG_DISABLED === "1") return;
  const ts = new Date().toISOString();
  console.log(`[${tag}] ${message}`);
  const target = projectId
    ? path.join(projectDir(projectId), "pai_calls.log")
    : path.join(PROJECT_ROOT, "logs", "orphan_pai_calls.log");
  fs.mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.appendFile(target, `${ts} [${tag}] ${message}\n`))
    .catch(() => {});
}
