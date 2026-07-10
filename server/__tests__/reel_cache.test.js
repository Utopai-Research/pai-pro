// Regression test for N75: the reel preview master cache keys its in-flight
// build map by (project id, build id), not project id alone. Before the fix, a
// request for build B that arrived while a build for A was in flight was handed
// A's in-flight promise and resolved to A's file — the wrong cut under B's
// manifest.
//
// ensureReelMaster is async, so each call returns a fresh wrapper promise;
// promise identity says nothing about de-duplication. We assert the RESOLVED
// PATH instead. The cached-file fast-path returns before buildReelMaster, so
// pre-seeding both masters drives the race with no ffmpeg. Real PROJECTS_DIR
// (paths.js freezes it at load) + a throwaway id, cleaned up after.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { ensureReelMaster, reelCacheDir, reelCachePath } from "../lib/reel_cache.js";
import { projectDir } from "../lib/paths.js";

function freshId() {
  return `reel_cache_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

test("ensureReelMaster: build B requested mid-flight of A resolves to B's master, not A's (N75)", async (t) => {
  const id = freshId();
  await mkdir(reelCacheDir(id), { recursive: true });
  t.after(() => rm(projectDir(id), { recursive: true, force: true }));

  const buildA = "a".repeat(16);
  const buildB = "b".repeat(16);
  await writeFile(reelCachePath(id, buildA), "A");
  await writeFile(reelCachePath(id, buildB), "B");

  const projects = new Map([[id, { id, canvasState: { nodes: [] } }]]);

  // Same synchronous tick: A's call registers its in-flight entry before its
  // first await, so A is still "in flight" when B's call inspects the map —
  // exactly the window the old id-only key mishandled.
  const pA = ensureReelMaster({ projects, id, buildId: buildA });
  const pB = ensureReelMaster({ projects, id, buildId: buildB });

  const [rA, rB] = await Promise.all([pA, pB]);
  assert.equal(rA, reelCachePath(id, buildA), "A resolves to A's master");
  assert.equal(rB, reelCachePath(id, buildB), "B resolves to B's master (was A's before the fix)");
});
