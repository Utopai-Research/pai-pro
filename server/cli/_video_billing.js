// Billed-duration measurement for PAI Video — both API versions.
//
// Billed seconds are the clip we ask for plus every second of reference video
// the vendor has to read. 2.5 prices a tier off that number, 2.0 prices per
// billed second off it; either way nothing upstream can compute it, because
// the reference bytes live on this machine and the backend freezes the money
// before the vendor has fetched anything. So the client measures.
//
// An under-measure is the only direction that silently spends money nobody
// approved, so every clip rounds UP to whole seconds.
//
// ffprobe is spawned exactly the way cli/extract_frames.js and cli/upscaler.js
// already spawn it — no new dependency. Their two module-local copies are left
// where they are on purpose; this is the first caller that needs it shared,
// and pulling theirs out would touch code this change has no business in.

import { spawn } from "node:child_process";

import {
  absPathForLocalPath,
  readNodeAssetInfo,
  readNodeType,
} from "../local_mirror.js";

function classified(klass, message) {
  const e = new Error(message);
  e.klass = klass;
  return e;
}

/**
 * Wall-clock seconds of a local media file.
 *
 * Rejects rather than guesses. A guess here is either an over-charge the user
 * never approved or an under-charge we absorb, and both are silent.
 */
export function probeMediaSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { errText += b.toString(); });
    child.on("error", (e) => {
      reject(classified(
        "infra",
        e.code === "ENOENT"
          ? "ffprobe not installed on server host"
          : `ffprobe failed to start: ${e.message}`,
      ));
    });
    child.on("close", (code, signal) => {
      // Killed by a signal = the binary crashed, never the caller's input.
      if (signal) {
        reject(classified("infra", `ffprobe killed by ${signal}: ${errText.slice(-500)}`));
        return;
      }
      if (code !== 0) {
        reject(classified("bad_args", `ffprobe exit ${code}: ${errText.slice(-500)}`));
        return;
      }
      let info;
      try {
        info = JSON.parse(out);
      } catch (e) {
        reject(classified("infra", `ffprobe printed unparsable JSON: ${e.message}`));
        return;
      }
      const video = Array.isArray(info?.streams)
        ? info.streams.find((s) => s?.codec_type === "video")
        : null;
      const seconds = Number(video?.duration ?? info?.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(classified("bad_args", "ffprobe could not read a positive duration"));
        return;
      }
      resolve(seconds);
    });
  });
}

/**
 * Total reference-VIDEO seconds behind a --ref-source-id list, each clip
 * rounded up, plus the per-source breakdown.
 *
 * Non-video ids are skipped, not rejected: generate_video.js's own type
 * partition owns that rejection, it runs before any provider call, and a job
 * it rejects is never billed — so skipping here cannot under-price anything
 * that reaches an invoice.
 *
 * Audio references are deliberately NOT counted. The vendor's own formula
 * names input VIDEO duration only, and whether audio joins it is an open
 * question. Counting it "to be safe" is not safe in one direction: it would
 * push jobs into a higher tier and charge the user for a second nobody has
 * established the vendor bills for. If that question is ever settled the other
 * way, this is the function that changes.
 *
 * A node whose bytes cannot be measured throws instead of falling back to the
 * per-clip cap. The alternative — assume the maximum — silently charges a
 * tier the user did not approve; refusing names the file and the fix.
 */
export async function sumRefVideoSeconds({ sourceIds = [], projectId } = {}) {
  let seconds = 0;
  const measured = [];
  for (const sid of sourceIds) {
    if (!sid) continue;
    const type = await readNodeType({ nodeId: sid, projectId });
    if (type !== "video_result") continue;
    const info = await readNodeAssetInfo({ nodeId: sid, projectId });
    const localPath = info?.localPath;
    if (!localPath) {
      throw classified(
        "bad_args",
        `Ref ${sid}: video node carries no local_path, so its billed seconds cannot be measured. ` +
        "Reference video is priced on measured seconds; regenerate or re-mirror the asset.",
      );
    }
    const absPath = absPathForLocalPath({ localPath, projectId });
    if (!absPath) {
      // absPathForLocalPath returns null with no projectId; spawn() would then
      // throw ERR_INVALID_ARG_TYPE with a message naming neither the missing
      // project nor the fix.
      throw classified(
        "bad_args",
        `Ref ${sid}: no project resolved for ${localPath}, so its billed seconds cannot be measured. ` +
        "Pass --project-id, or run the CLI from inside projects/<id>/.",
      );
    }
    let raw;
    try {
      raw = await probeMediaSeconds(absPath);
    } catch (e) {
      throw classified(
        e.klass || "infra",
        `Could not measure reference video ${sid} (${localPath}): ${e.message}. ` +
        "Reference video is priced on measured seconds — install ffprobe, or drop the video reference.",
      );
    }
    const rounded = Math.ceil(raw);
    seconds += rounded;
    measured.push({ source_id: sid, seconds: rounded });
  }
  return { seconds, measured };
}
