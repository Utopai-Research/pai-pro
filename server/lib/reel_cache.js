// Reel preview master cache — keeps the 3 most recent build ids per
// project so smooth playback survives a tab close.
//
// The Timeline player swaps a single `<video>` element's src on every
// clip boundary. The browser tears down the decoder on src change,
// blanking the surface to black for ~100-200ms — a visible flash. To
// avoid that, we serve the on-reel clips as ONE concatenated MP4 and
// let the player drive boundaries via `currentTime` instead of `src`.
//
// The pre-build runs in the background whenever the reel composition
// changes (broadcastCanvas → kickReelPrebuild), debounced 500ms so a
// rapid drag-reorder collapses to one ffmpeg invocation. Cache key is
// computeReelBuildId(state): a hash of (clip URLs + durations in
// shot_id order). Reorders / regenerations naturally invalidate.

import fsp from "node:fs/promises";
import path from "node:path";

import { buildReelMaster, computeReelBuildId } from "../reel_stitch.js";
import { projectDir } from "./paths.js";

const REEL_CACHE_LRU = 3;                 // keep the 3 most recent build ids per project
const REEL_PREBUILD_DEBOUNCE_MS = 500;

// projectId -> { timer }
const _reelPrebuildTimers = new Map();
// `${projectId}:${buildId}` -> Promise (in-flight build). Keyed by build id too,
// so a request for build B that lands mid-build of A gets its own build (and
// streams B's bytes) instead of being handed A's in-flight promise.
const _reelBuildsInFlight = new Map();

export function reelCacheDir(id) {
  return path.join(projectDir(id), "assets/cache/reel-preview");
}

export function reelCachePath(id, buildId) {
  return path.join(reelCacheDir(id), `${buildId}.mp4`);
}

async function pruneReelCache(id, keepBuildId) {
  const dir = reelCacheDir(id);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;
    return;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".mp4"))
    .map((e) => e.name);
  if (files.length <= REEL_CACHE_LRU) return;
  // mtime-desc sort; drop everything past the keep window. Always
  // preserve `keepBuildId` even if it's somehow older than peers.
  const stats = await Promise.all(
    files.map(async (name) => ({ name, st: await fsp.stat(path.join(dir, name)).catch(() => null) })),
  );
  const sorted = stats
    .filter((s) => s.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const keep = new Set(sorted.slice(0, REEL_CACHE_LRU).map((s) => s.name));
  if (keepBuildId) keep.add(`${keepBuildId}.mp4`);
  for (const { name } of sorted) {
    if (keep.has(name)) continue;
    fsp.unlink(path.join(dir, name)).catch(() => {});
  }
}

// Run an actual build for the given build id (the caller has already
// verified that build_id matches the current state). De-duplicates
// concurrent calls so a /preview.mp4 request that arrives during a
// background build just awaits the same Promise.
export async function ensureReelMaster({ projects, id, buildId }) {
  const key = `${id}:${buildId}`;
  const inflight = _reelBuildsInFlight.get(key);
  if (inflight) return inflight;
  const p = projects.get(id);
  if (!p?.canvasState) {
    const err = new Error("project not loaded");
    err.code = "NO_STATE";
    throw err;
  }
  const outPath = reelCachePath(id, buildId);
  // Register the in-flight promise SYNCHRONOUSLY — before the first await —
  // so concurrent cold-cache callers collapse onto this single build. The
  // cached-file check has to live INSIDE the promise: when it sat before the
  // registration, its `await fsp.access` yielded the event loop, letting two
  // requests both miss the cache and each spawn an ffmpeg writing the same
  // path. buildReelMaster now renames atomically so that race no longer
  // corrupts the master, but collapsing it also avoids the wasted duplicate
  // encodes.
  const buildPromise = (async () => {
    try {
      // Already cached? Touch mtime to keep it warm in the LRU and reuse.
      try {
        await fsp.access(outPath);
        const now = new Date();
        await fsp.utimes(outPath, now, now).catch(() => {});
        return outPath;
      } catch { /* not cached; build it */ }
      await buildReelMaster(p.canvasState, projectDir(id), outPath, id);
      pruneReelCache(id, buildId).catch(() => {});
      return outPath;
    } finally {
      _reelBuildsInFlight.delete(key);
    }
  })();
  _reelBuildsInFlight.set(key, buildPromise);
  return buildPromise;
}

// Schedule a background pre-build. Called from broadcastCanvas. The
// debounce window collapses rapid-fire reorders into a single build.
export function kickReelPrebuild({ projects, id }) {
  const p = projects.get(id);
  if (!p?.canvasState) return;
  const buildId = computeReelBuildId(p.canvasState);
  if (!buildId) return;
  // If a build for this exact composition already exists or is in
  // flight, skip — nothing to do.
  if (_reelBuildsInFlight.has(`${id}:${buildId}`)) return;
  fsp.access(reelCachePath(id, buildId)).then(
    () => { /* already cached */ },
    () => {
      const slot = _reelPrebuildTimers.get(id);
      if (slot?.timer) clearTimeout(slot.timer);
      const timer = setTimeout(() => {
        _reelPrebuildTimers.delete(id);
        ensureReelMaster({ projects, id, buildId }).catch((e) => {
          if (e.code !== "FFMPEG_MISSING" && e.code !== "NO_SHOTS") {
            console.warn(`[viewer] reel prebuild ${id} failed: ${e.message}`);
          }
        });
      }, REEL_PREBUILD_DEBOUNCE_MS);
      _reelPrebuildTimers.set(id, { timer });
    },
  );
}
