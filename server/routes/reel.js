// Reel routes: stitch-on-demand download + the smooth-playback master
// (manifest + byte-range MP4 served out of the LRU cache built by
// lib/reel_cache.js).

import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

import { mutate } from "../canvas_mutator.js";
import {
  selectReel,
  stitchReel,
  computeReelBuildId,
  computeReelManifest,
} from "../reel_stitch.js";
import { statusForKlass } from "../lib/broadcasters.js";
import {
  ensureReelMaster,
  kickReelPrebuild,
  reelCachePath,
} from "../lib/reel_cache.js";
import { PAI_REPO_ROOT, projectDir } from "../lib/paths.js";
import { readPendingEntry } from "../lib/readers.js";

const UPSCALE_STAGE_TIMEOUT_MS = 4 * 60 * 1000;

function parseTailJson(buf) {
  const lines = String(buf || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        return parsed;
      }
    } catch {
      /* keep walking */
    }
  }
  return null;
}

function runUpscalerStage({ id, sourceNodeId, label }) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        path.join(PAI_REPO_ROOT, "server", "cli", "upscaler.js"),
        "--project-id", id,
        "--source-node-id", sourceNodeId,
        "--label", label,
        "--stage",
        "--stage-only",
      ],
      { cwd: projectDir(id), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let outBuf = "";
    let settled = false;
    let timedOut = false;
    const append = (b) => {
      outBuf += b.toString();
      if (outBuf.length > 65536) outBuf = outBuf.slice(-65536);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, UPSCALE_STAGE_TIMEOUT_MS);
    const finish = (fallback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = timedOut ? null : parseTailJson(outBuf);
      resolve(parsed || fallback);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      finish({
        ok: false,
        klass: "infra",
        message: `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        ok: false,
        klass: timedOut ? "timeout" : "infra",
        message: timedOut
          ? "timed out while preparing 4K upscale quote"
          : signal
            ? `upscaler stage killed by ${signal}`
            : `upscaler stage exited with code ${code}`,
      });
    });
  });
}

export function registerReelRoutes({ app, projects, mutatorHooks }) {
  // GET /projects/:id/reel.mp4 — stitch every video_result with a numeric
  // shot_id (ordered by shot_id) and stream the concatenated MP4 back as a
  // download. Re-runs ffmpeg on every request; the fast path is concat-copy
  // so a handful of clips stitches in a couple seconds.
  app.get("/projects/:id/reel.mp4", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const state = p.canvasState;
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "no canvas state" });
    }
    let cleanup = null;
    try {
      const result = await stitchReel(state, projectDir(id), id);
      cleanup = result.cleanup;
      const safeTitle = (p.meta?.title || "reel")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "reel";
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", String(result.size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeTitle}.mp4"`,
      );
      // Content-Disposition isn't in the CORS "safelist" — without an
      // explicit Expose-Headers, the browser fetch() can't read it back
      // and our blob-URL download falls back to the generic filename.
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      const stream = fs.createReadStream(result.path);
      const finalize = () => {
        if (cleanup) { cleanup(); cleanup = null; }
      };
      stream.on("close", finalize);
      stream.on("error", (e) => {
        console.warn(`[viewer] reel stream ${id} failed:`, e.message);
        finalize();
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on("close", finalize);
      stream.pipe(res);
    } catch (e) {
      if (cleanup) await cleanup();
      if (e.code === "NO_SHOTS") {
        return res.status(400).json({ error: "no shots on the reel to stitch" });
      }
      console.warn(`[viewer] GET /projects/${id}/reel.mp4 failed:`, e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  app.post("/projects/:id/reel/upscale-4k/draft", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ ok: false, error: "not found" });
    const state = p.canvasState;
    if (!state || typeof state !== "object") {
      return res.status(400).json({ ok: false, error: "no canvas state" });
    }

    const reel = selectReel(state);
    if (!reel.length) {
      return res.status(400).json({ ok: false, error: "no shots on the reel to upscale" });
    }

    let cleanup = null;
    let tmpPath = null;
    try {
      const stitched = await stitchReel(state, projectDir(id), id);
      cleanup = stitched.cleanup;
      const tmpDir = path.join(projectDir(id), "assets", ".tmp");
      await fsp.mkdir(tmpDir, { recursive: true });
      tmpPath = path.join(tmpDir, `timeline-reel-${crypto.randomUUID()}.mp4`);
      await fsp.copyFile(stitched.path, tmpPath);
      const manifest = computeReelManifest(state);
      const shotIds = reel.map((n) => n.id);
      const generatedAt = new Date().toISOString();
      const duration = Math.max(1, Math.round(Number(manifest.total_duration) || 0));
      const aspect = typeof reel[0]?.data?.aspect === "string" ? reel[0].data.aspect : "16:9";
      const label = `Timeline reel (${reel.length} clip${reel.length === 1 ? "" : "s"})`;
      const reply = await mutate(
        p,
        {
          request_id: `viewer-reel-upscale-source-${id}-${crypto.randomUUID()}`,
          op: "addBatch",
          payload: {
            nodes: [{
              type: "video_result",
              tmp_path: tmpPath,
              data: {
                label,
                prompt: `Stitched timeline reel from ${reel.length} clip${reel.length === 1 ? "" : "s"}`,
                duration,
                aspect,
                shot_id: null,
                metadata: {
                  source: "viewer",
                  task_type: "reel_stitch",
                  mode: "timeline_reel",
                  model: "ffmpeg",
                  shot_count: reel.length,
                  source_node_ids: shotIds,
                  reel_build_id: manifest.build_id,
                  generated_at: generatedAt,
                },
              },
            }],
            edges: [],
          },
          actor: "viewer:reel-upscale",
        },
        mutatorHooks,
      );
      if (!reply.ok) {
        await fsp.unlink(tmpPath).catch(() => {});
        tmpPath = null;
        return res.status(statusForKlass(reply.klass)).json({ ok: false, error: reply.message });
      }
      tmpPath = null;
      const reelNodeId = reply.assigned?.node_ids?.[0] ?? null;
      if (!reelNodeId) {
        return res.status(500).json({ ok: false, error: "stitched reel node was not assigned" });
      }

      const stage = await runUpscalerStage({
        id,
        sourceNodeId: reelNodeId,
        label: `4K ${label}`,
      });
      if (!stage?.ok) {
        const klass = stage?.klass || "infra";
        return res.status(statusForKlass(klass)).json({
          ok: false,
          klass,
          error: stage?.message || "failed to prepare 4K upscale quote",
        });
      }
      if (typeof stage.job_id !== "string" || stage.job_id === "") {
        return res.status(500).json({ ok: false, error: "upscaler stage did not return a job id" });
      }
      const pending = await readPendingEntry(id, stage.job_id);
      res.status(201).json({
        ok: true,
        job_id: stage.job_id,
        cost_usd: stage.cost_usd,
        shot_count: reel.length,
        ...(pending ? {
          source_resolution: pending.source_resolution,
          target_resolution: pending.target_resolution,
          duration: pending.duration,
        } : {}),
      });
    } catch (e) {
      if (tmpPath) await fsp.unlink(tmpPath).catch(() => {});
      if (e.code === "NO_SHOTS") {
        return res.status(400).json({ ok: false, error: "no shots on the reel to upscale" });
      }
      console.warn(`[viewer] POST /projects/${id}/reel/upscale-4k/draft failed:`, e.message);
      return res.status(500).json({
        ok: false,
        error: e.message,
      });
    } finally {
      if (cleanup) await cleanup();
    }
  });

  // GET /projects/:id/reel/manifest — describes the master that goes
  // with the current canvas state. Cheap (no ffmpeg) — the player polls
  // this on tab open and on every canvas-state push to learn the
  // build_id it should be requesting.
  app.get("/projects/:id/reel/manifest", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const manifest = computeReelManifest(p.canvasState);
    if (!manifest.build_id) return res.json({ ...manifest, ready: false });
    let ready = false;
    try {
      await fsp.access(reelCachePath(id, manifest.build_id));
      ready = true;
    } catch { /* still building or never built */ }
    // Side-effect: if we haven't started a build for this composition,
    // kick one off so the next manifest poll sees ready=true.
    if (!ready) kickReelPrebuild({ projects, id });
    res.json({ ...manifest, ready });
  });

  // GET /projects/:id/reel/preview.mp4?build=<id> — streams the cached
  // master with byte-range support so the <video> element can seek.
  // When ?build= is missing or stale, returns 409 so the client knows
  // to refetch the manifest and try again with the new build_id.
  app.get("/projects/:id/reel/preview.mp4", async (req, res) => {
    const id = req.params.id;
    const p = projects.get(id);
    if (!p) return res.status(404).json({ error: "not found" });
    const requestedBuild = typeof req.query.build === "string" ? req.query.build : null;
    const currentBuild = computeReelBuildId(p.canvasState);
    if (!currentBuild) return res.status(400).json({ error: "no shots on reel" });
    if (requestedBuild && requestedBuild !== currentBuild) {
      return res.status(409).json({ error: "build_id stale", current_build: currentBuild });
    }
    const buildId = requestedBuild || currentBuild;
    let cachePath;
    try {
      cachePath = await ensureReelMaster({ projects, id, buildId });
    } catch (e) {
      if (e.code === "FFMPEG_MISSING") {
        return res.status(503).json({ error: "ffmpeg not installed", klass: "ffmpeg_missing" });
      }
      if (e.code === "NO_SHOTS") {
        return res.status(400).json({ error: "no shots on reel" });
      }
      console.warn(`[viewer] reel preview ${id} build failed: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }

    // Byte-range serving so <video> can seek without re-downloading.
    let info;
    try {
      info = await fsp.stat(cachePath);
    } catch (e) {
      return res.status(500).json({ error: "cache file vanished" });
    }
    const total = info.size;
    const range = req.headers.range;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (!range) {
      res.setHeader("Content-Length", String(total));
      fs.createReadStream(cachePath).pipe(res);
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.status(416).end();
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (start > end || start >= total) {
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(cachePath, { start, end }).pipe(res);
  });
}
