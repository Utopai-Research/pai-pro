#!/usr/bin/env node
// CLI wrapper around server/reel_stitch.js.
//
// Reads ./workflow.json, picks every video_result with a numeric data.shot_id,
// orders by shot_id, downloads each MP4, and stitches them with ffmpeg into a
// single output file. Default output is ./reel.mp4 in the project root.
//
// Usage:
//   node server/cli/reel_stitch.js [--out reel.mp4] [--workflow workflow.json]
//
// Output (stdout, one JSON line):
//   { ok: true, output_path, size_bytes, shot_count, generated_at }
//   { ok: false, klass, message }
//
// Requires `ffmpeg` on PATH. The fast path is `concat` with `-c copy`
// (lossless, no re-encode) when the inputs share codec/res/fps; a re-encode
// fallback handles mixed sources.

import path from "node:path";
import { copyFile, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow, PAI_REPO_ROOT } from "./_cli.js";
import { stitchReel } from "../reel_stitch.js";
import { readActiveProject } from "../local_mirror.js";

const args = parseArgs({
  out:      { type: "string", short: "o", default: "reel.mp4" },
  workflow: { type: "string", short: "w", default: "workflow.json" },
});

// Active project's directory — local_path values in workflow.json
// resolve against this. PAI_REPO_ROOT is the repo root; the active
// project sits under projects/<active-id>/.
const activeId = await readActiveProject().catch(() => null);
const projectBaseDir = activeId
  ? path.join(PAI_REPO_ROOT, "projects", activeId)
  : PAI_REPO_ROOT;
const workflowPath = path.resolve(projectBaseDir, args.workflow);
const outPath      = path.resolve(projectBaseDir, args.out);

let state;
try {
  const raw = await readFile(workflowPath, "utf8");
  state = JSON.parse(raw);
} catch (e) {
  emitFailure("bad_args", `cannot read ${workflowPath}: ${e.message}`);
  process.exit(2);
}

let cleanup = null;
try {
  const result = await stitchReel(state, projectBaseDir, "local");
  cleanup = result.cleanup;
  await copyFile(result.path, outPath);
  const info = await stat(outPath);
  const reelCount = (state.nodes || []).filter(
    (n) => n.type === "video_result" && typeof n.data?.shot_id === "number"
  ).length;
  emitSuccess({
    output_path: outPath,
    size_bytes: info.size,
    shot_count: reelCount,
    generated_at: isoNow(),
  });
} catch (e) {
  if (e.code === "NO_SHOTS") {
    emitFailure("bad_args", "no video_result nodes with a numeric shot_id");
  } else {
    emitFailure(classify(e), e.message);
  }
  process.exit(1);
} finally {
  if (cleanup) await cleanup();
}
