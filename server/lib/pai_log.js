// Per-call PAI observability. Two channels per call:
//   - console.log (live tmux pane)
//   - fs.appendFile to projects/<id>/pai_calls.log (durable, greppable)
//
// Calls without project context (e.g. tests with mocked external URLs)
// only console.log — no file write. In production every call has a
// projectId: media gens get it from the CLI's --project-id, asset
// uploads parse it from the canonical URL, and the lazy
// CreateAssetGroup bootstrap inherits the projectId of whichever
// upload triggered it.

import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./paths.js";

export function logPai({ projectId, tag, message }) {
  if (process.env.PAI_LOG_DISABLED === "1") return;
  console.log(`[${tag}] ${message}`);
  if (!projectId) return; // console-only — no file to write to
  const target = path.join(projectDir(projectId), "pai_calls.log");
  fs.appendFile(target, `${new Date().toISOString()} [${tag}] ${message}\n`)
    .catch(() => {}); // fire-and-forget; file errors must never break the parent call
}
