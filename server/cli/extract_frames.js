#!/usr/bin/env node
// extract_frames.js — free local frame sampler for video alignment checks.
// Samples N evenly spaced JPEG frames from a local video so an agent can
// visually judge whether the clip matches its prompt. Local-only: ffprobe
// for duration, one ffmpeg seek per frame. No staging, no model registry,
// no canvas write.
//
// Args:
//   --path <video>       required; project-relative (cwd) or absolute path
//   --count <N>          frames to sample, integer 1-10 (default 5)
//   --max-width <px>     downscale cap, integer >= 64 (default 1280)
//
// Frames land in assets/.tmp/frames/<input-basename>/ under the cwd; the
// directory is cleared on each run so growth stays bounded per input.
//
// Output (stdout, one line):
//   { ok: true, input, duration_seconds, count, frames: [paths] }
//   { ok: false, klass, message }   klass: bad_args | infra

import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";

import { parseArgs, emitSuccess, emitFailure, classify } from "./_cli.js";

const args = parseArgs({
  path: { type: "string" },
  count: { type: "string" },
  "max-width": { type: "string" },
});

if (!args.path) {
  emitFailure("bad_args", "missing --path");
  process.exit(2);
}
const count = args.count === undefined ? 5 : Number(args.count);
if (!Number.isInteger(count) || count < 1 || count > 10) {
  emitFailure("bad_args", "count must be an integer in [1,10]");
  process.exit(2);
}
const maxWidth = args["max-width"] === undefined ? 1280 : Number(args["max-width"]);
if (!Number.isInteger(maxWidth) || maxWidth < 64) {
  emitFailure("bad_args", "max-width must be an integer >= 64");
  process.exit(2);
}

// Local copies of the tiny spawn helpers; the siblings in cli/upscaler.js
// (runFfprobe) and reel_stitch.js (runFfmpeg) are module-local.
function run(bin, argv, failKlass) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => {
      if (e.code === "ENOENT") {
        e.klass = "infra";
        e.message = `${bin} not installed on server host`;
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const e = new Error(`${bin} exit ${code}: ${err.slice(-500)}`);
        e.klass = failKlass;
        reject(e);
        return;
      }
      resolve(out);
    });
  });
}

async function probeDuration(filePath) {
  // A broken/non-video input is the caller's problem -> bad_args.
  const raw = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], "bad_args");
  let info;
  try {
    info = JSON.parse(raw);
  } catch (e) {
    e.klass = "infra";
    throw e;
  }
  const video = Array.isArray(info?.streams)
    ? info.streams.find((s) => s?.codec_type === "video")
    : null;
  if (!video) {
    const e = new Error("ffprobe found no video stream");
    e.klass = "bad_args";
    throw e;
  }
  const duration = Number(video.duration ?? info?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const e = new Error("ffprobe could not read a positive duration");
    e.klass = "bad_args";
    throw e;
  }
  return duration;
}

try {
  const input = path.resolve(process.cwd(), args.path);
  try {
    await fsp.access(input);
  } catch {
    const e = new Error(`input not found: ${args.path}`);
    e.klass = "bad_args";
    throw e;
  }
  const duration = await probeDuration(input);

  // Evenly spaced timestamps; keep off the exact endpoints so seeks land on
  // a decodable frame (first >= 0.1s, last <= duration - 0.2s).
  const first = Math.min(0.1, duration / 2);
  const last = Math.max(first, duration - 0.2);
  const ts = count === 1
    ? [duration / 2]
    : Array.from({ length: count }, (_, i) => first + (i * (last - first)) / (count - 1));

  // Deterministic per-input dir, cleared on re-run.
  const base = path.basename(input, path.extname(input));
  const outDir = path.resolve(process.cwd(), "assets", ".tmp", "frames", base);
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const frames = [];
  for (let i = 0; i < ts.length; i++) {
    const out = path.join(outDir, `frame_${String(i + 1).padStart(2, "0")}.jpg`);
    // Single quotes are ffmpeg filtergraph escaping (protect the comma in
    // min()), not shell quoting — spawn passes the arg verbatim.
    await run("ffmpeg", [
      "-y",
      "-ss", ts[i].toFixed(3),
      "-i", input,
      "-frames:v", "1",
      "-vf", `scale='min(${maxWidth},iw)':-2`,
      "-q:v", "2",
      out,
    ], "infra");
    const stat = await fsp.stat(out).catch(() => null);
    if (!stat || stat.size === 0) {
      const e = new Error(`ffmpeg produced no frame at ${ts[i].toFixed(3)}s`);
      e.klass = "infra";
      throw e;
    }
    frames.push(path.relative(process.cwd(), out));
  }

  emitSuccess({
    input: args.path,
    duration_seconds: duration,
    count: frames.length,
    frames,
  });
} catch (e) {
  emitFailure(classify(e), e.message);
  process.exit(classify(e) === "bad_args" ? 2 : 1);
}
