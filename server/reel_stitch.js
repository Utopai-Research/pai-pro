// Stitches a session's shot reel into a single MP4 via ffmpeg.
// Fast path: concat demuxer with `-c copy` (lossless, no re-encode).
// Video clips from the same model share codec/res/fps so this is the
// common case. Fallback: filter_complex concat with re-encode for mixed
// sources.

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile, stat, mkdir, copyFile, access, rename, unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

export function selectReel(state) {
  return (state?.nodes || [])
    .filter((n) =>
      n.type === "video_result" &&
      // Defense-in-depth: client's archive path also clears shot_id, so an
      // archived clip should never reach this filter with shot_id set. This
      // line guards against any future archive code path that forgets.
      n.data?.archived !== true &&
      typeof n.data?.local_path === "string" &&
      n.data.local_path &&
      typeof n.data?.shot_id === "number"
    )
    .sort((a, b) => a.data.shot_id - b.data.shot_id);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (b) => { err += b.toString(); });
    p.on("error", (e) => {
      if (e.code === "ENOENT") reject(new Error("ffmpeg not installed on server host"));
      else reject(e);
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`));
    });
  });
}

// Stitches the canvas's reel. `state` is the parsed workflow.json contents;
// `projectDir` is the absolute path to projects/<id>/ (so local_path values
// resolve to real files). `slug` becomes part of the temp-dir name. Returns
// { path, size, cleanup } — caller must call cleanup() after streaming the
// file back (or on error).
export async function stitchReel(state, projectDir, slug = "local") {
  const reel = selectReel(state);
  if (!reel.length) {
    const err = new Error("no shots to stitch");
    err.code = "NO_SHOTS";
    throw err;
  }

  const dir = await mkdtemp(path.join(tmpdir(), `reel-${slug}-`));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    const files = [];
    for (let i = 0; i < reel.length; i++) {
      const src = path.resolve(projectDir, reel[i].data.local_path);
      const dst = path.join(dir, `${i}${path.extname(src) || ".mp4"}`);
      await copyFile(src, dst);
      files.push(dst);
    }

    const listPath = path.join(dir, "list.txt");
    await writeFile(
      listPath,
      files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8"
    );

    const outPath = path.join(dir, "out.mp4");

    try {
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        outPath,
      ]);
    } catch (copyErr) {
      if (copyErr.message === "ffmpeg not installed on server host") throw copyErr;
      // Fallback: re-encode. Handles mismatched codecs/resolutions/fps.
      console.warn(`[stitch ${slug}] copy-mode failed, re-encoding: ${copyErr.message.slice(0, 200)}`);
      const inputs = files.flatMap((f) => ["-i", f]);
      const filter = files
        .map((_, i) => `[${i}:v:0][${i}:a:0?]`)
        .join("") + `concat=n=${files.length}:v=1:a=1[outv][outa]`;
      await runFfmpeg([
        "-y",
        ...inputs,
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "[outa]",
        "-movflags", "+faststart",
        outPath,
      ]);
    }

    const info = await stat(outPath);
    return { path: outPath, size: info.size, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// Stable hash over the reel composition that drives the playback master
// cache. Captures clip local_path + duration + position; changes whenever
// the composition or any clip's source bytes change (re-generation = new
// node id with a new local_path → new build id). Returns null when
// there's no reel to stitch so callers can skip the build entirely.
export function computeReelBuildId(state) {
  const reel = selectReel(state);
  if (!reel.length) return null;
  const h = crypto.createHash("sha1");
  h.update(`v2\n${reel.length}\n`);
  for (const n of reel) {
    h.update(`${n.id}|${n.data.local_path}|${n.data.duration ?? 0}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

// Returns the manifest describing a reel's master: which canvas clip
// occupies each [start, end) slot in the concatenated MP4. The frontend
// uses this to drive boundary detection without a src swap.
export function computeReelManifest(state) {
  const reel = selectReel(state);
  if (!reel.length) return { build_id: null, total_duration: 0, clips: [] };
  let start = 0;
  const clips = reel.map((n) => {
    const dur = Number(n.data.duration) || 0;
    const slot = { node_id: n.id, start, end: start + dur, duration: dur };
    start += dur;
    return slot;
  });
  return {
    build_id: computeReelBuildId(state),
    total_duration: start,
    clips,
  };
}

// Resolve a video_result node to a file ffmpeg can read directly. The
// asset always lives at projects/<id>/<local_path>; schema requires
// local_path, so a missing one is a hard bug.
async function resolveClipFile(node, projectDir) {
  const relLocal = node.data.local_path;
  if (typeof relLocal !== "string" || !relLocal) {
    throw new Error(`video_result node ${node.id} has no local_path`);
  }
  const abs = path.resolve(projectDir, relLocal);
  await access(abs);
  return abs;
}

// Build (or rebuild) the concatenated master for `state` to `outPath`.
// Reuses the same fast-copy / fallback-re-encode logic as stitchReel
// but writes to a caller-chosen path so the result can be cached.
// Throws { code: "NO_SHOTS" } when the reel is empty,
// { code: "FFMPEG_MISSING" } when the ffmpeg binary isn't on PATH.
export async function buildReelMaster(state, projectDir, outPath, slug = "local") {
  const reel = selectReel(state);
  if (!reel.length) {
    const err = new Error("no shots to stitch");
    err.code = "NO_SHOTS";
    throw err;
  }
  await mkdir(path.dirname(outPath), { recursive: true });
  const workDir = await mkdtemp(path.join(tmpdir(), `reel-master-${slug}-`));
  const cleanup = () => rm(workDir, { recursive: true, force: true }).catch(() => {});
  // ffmpeg writes to a private temp file in the SAME directory as outPath;
  // we atomically rename it into place only once it's fully written. This
  // buys two safety properties the old write-straight-to-outPath path lacked:
  //   1. Readers (the byte-range /reel/preview.mp4 handler) never observe a
  //      half-written file — including during ffmpeg's two-pass +faststart
  //      rewrite, which momentarily leaves the moov atom inconsistent.
  //   2. Concurrent builds for the same composition each write their own
  //      temp and rename last-wins, so the cached master is always a
  //      complete, valid MP4. Previously a background prebuild racing a
  //      preview request interleaved bytes into the shared path, yielding a
  //      right-sized but corrupt file — an unplayable reel.
  const tmpOut = `${outPath}.${crypto.randomUUID()}.partial`;
  try {
    const files = [];
    for (const n of reel) files.push(await resolveClipFile(n, projectDir));

    const listPath = path.join(workDir, "list.txt");
    await writeFile(
      listPath,
      files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );

    try {
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        tmpOut,
      ]);
    } catch (copyErr) {
      if (copyErr.message === "ffmpeg not installed on server host") {
        const err = new Error("ffmpeg not installed on server host");
        err.code = "FFMPEG_MISSING";
        throw err;
      }
      console.warn(`[stitch ${slug}] copy-mode failed, re-encoding: ${copyErr.message.slice(0, 200)}`);
      const inputs = files.flatMap((f) => ["-i", f]);
      const filter = files
        .map((_, i) => `[${i}:v:0][${i}:a:0?]`)
        .join("") + `concat=n=${files.length}:v=1:a=1[outv][outa]`;
      await runFfmpeg([
        "-y",
        ...inputs,
        "-filter_complex", filter,
        "-map", "[outv]",
        "-map", "[outa]",
        "-movflags", "+faststart",
        "-f", "mp4",
        tmpOut,
      ]);
    }

    await rename(tmpOut, outPath);
    const info = await stat(outPath);
    return { path: outPath, size: info.size };
  } catch (e) {
    await unlink(tmpOut).catch(() => {});
    throw e;
  } finally {
    await cleanup();
  }
}
