// Pending-draft fire path. Three routes that let the browser (or curl)
// edit, fire, or cancel a `.pending/<jobId>.json` sidecar that was
// staged by a generate_*.js CLI with --stage. The chokidar watcher in
// services/watcher.js fans `pending-generations` out on every sidecar
// add/change/unlink, so PATCH + DELETE need no extra emit; POST
// /generate spawns the same CLI with --existing-job-id so it flips the
// draft sidecar to running in place, then writes a durable result sidecar.
// DELETE also writes a durable cancelled result before unlinking.
//
// Security: POST /generate gates the captured `script` against an
// explicit whitelist. argv is passed positionally to spawn (no shell),
// so a tampered sidecar can't inject arbitrary commands.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { VIDEO_25_RESOLUTIONS, getCost, stagedCostUsd } from "../model_registry.js";
import { videoLimitsFor, videoOutputDurationBounds } from "../cli/_limits.js";
import { isActiveAutoRun } from "../lib/auto_runs.js";
import { PAI_REPO_ROOT, PENDING_STALE_MS, pendingDir, projectDir } from "../lib/paths.js";
import {
  normalizeResultEntry,
  readPendingEntry,
  readResultEntry,
} from "../lib/readers.js";
import { withProjectMutationLock, writeResult } from "../lib/writers.js";

const ALLOWED_SCRIPTS = new Set([
  "generate_image.js",
  "generate_image_pro.js",
  "generate_video.js",
  "generate_voice.js",
  "upscaler.js",
]);

// Patch-key → CLI flag. Only these fields can be edited via PATCH;
// anything else in the body is ignored.
const PATCH_FLAGS = {
  prompt:        "--prompt",
  aspect_ratio:  "--aspect-ratio",
  image_size:    "--image-size",
  resolution:    "--resolution",
  duration:      "--duration",
  text:          "--text",
};

// Which of those keys move the price. `text` is here because voice is billed
// by input length ($0.01 per 500 characters), so editing the line a draft will
// speak is a cost edit even though it reads like a prompt edit — `prompt`
// itself is free to change, since no model prices by it.
const COSTED_PATCH_KEYS = new Set(["image_size", "resolution", "duration", "text"]);

const IMAGE_PRO_DISPLAY_ONLY_PATCH_KEYS = new Set(["aspect_ratio", "image_size"]);
const RUNNING_TIMEOUT_MS = {
  image: 10 * 60 * 1000,
  imagePro: 30 * 60 * 1000,
  audio: 5 * 60 * 1000,
  video: 40 * 60 * 1000,
};
const RUNNING_TIMEOUT_KILL_GRACE_MS = 5 * 1000;

function pendingPath(id, jobId) {
  return path.join(pendingDir(id), `${jobId}.json`);
}

function isImageProSidecar(entry) {
  return entry?.script === "generate_image_pro.js" || entry?.model === "image-generation-pro";
}

function isPatchKeyEditableForEntry(key, entry) {
  if (!Object.prototype.hasOwnProperty.call(PATCH_FLAGS, key)) return false;
  return !(isImageProSidecar(entry) && IMAGE_PRO_DISPLAY_ONLY_PATCH_KEYS.has(key));
}

function isValidPosition(p) {
  return p !== null && typeof p === "object"
    && typeof p.x === "number" && Number.isFinite(p.x)
    && typeof p.y === "number" && Number.isFinite(p.y);
}

function parseTailJson(buf) {
  const lines = buf.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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

async function removePendingSidecar(id, jobId) {
  try {
    await fsp.unlink(pendingPath(id, jobId));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export function runningTimeoutMsForEntry(entry) {
  if (entry?.script === "generate_video.js" || entry?.kind === "video") {
    return RUNNING_TIMEOUT_MS.video;
  }
  if (entry?.script === "generate_voice.js" || entry?.kind === "audio") {
    return RUNNING_TIMEOUT_MS.audio;
  }
  if (isImageProSidecar(entry)) return RUNNING_TIMEOUT_MS.imagePro;
  return RUNNING_TIMEOUT_MS.image;
}

function fallbackResult({ jobId, code, signal, spawnError, timedOut = false, timeoutMs }) {
  if (timedOut) {
    return {
      ok: false,
      job_id: jobId,
      klass: "timeout",
      message: `generation worker timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  if (spawnError) {
    return {
      ok: false,
      job_id: jobId,
      klass: "infra",
      message: `spawn error: ${spawnError.message}`,
    };
  }
  if (signal) {
    return {
      ok: false,
      job_id: jobId,
      klass: "aborted",
      message: `killed by ${signal}`,
    };
  }
  return {
    ok: false,
    job_id: jobId,
    klass: "infra",
    message: code === 0 ? "CLI exited without result JSON" : `CLI exited with code ${code}`,
  };
}

function pendingContext(entry) {
  const out = {};
  for (const key of [
    "prompt",
    "aspect_ratio",
    "model",
    "size",
    "image_size",
    "resolution",
    "duration",
    "cost_usd",
    "mode",
    "source_resolution",
    "target_resolution",
    "text",
    "position",
    "reference_source_ids",
    "source_node_id",
    "auto_run_id",
  ]) {
    if (entry?.[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

export function markSidecarRunning(sidecar, nowIso = new Date().toISOString()) {
  sidecar.stage = "running";
  sidecar.created_at = nowIso;
  return sidecar;
}

function isStalePendingSidecar(sidecar) {
  const createdAt = Date.parse(sidecar?.created_at || "");
  return Number.isFinite(createdAt) && Date.now() - createdAt > PENDING_STALE_MS;
}

export function registerPendingRoutes({ app, projects, broadcasters }) {
  async function claimDraftForGenerate(id, jobId) {
    let claimed = null;
    await withProjectMutationLock(id, async () => {
      const target = pendingPath(id, jobId);
      let sidecar;
      try {
        sidecar = JSON.parse(await fsp.readFile(target, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR" || e instanceof SyntaxError) {
          throw Object.assign(new Error("draft not found"), { http: 404 });
        }
        throw e;
      }
      const stage = sidecar.stage === "draft" ? "draft" : "running";
      if (stage !== "draft") {
        throw Object.assign(new Error(`already ${stage}`), { http: 409 });
      }
      if (isStalePendingSidecar(sidecar)) {
        throw Object.assign(new Error("draft not found"), { http: 404 });
      }
      if (!sidecar.script || !ALLOWED_SCRIPTS.has(sidecar.script)) {
        throw Object.assign(new Error(`unknown script: ${sidecar.script}`), { http: 400 });
      }
      // Auto drafts were reserved against a specific run; once that run
      // is cancelled, completed, or replaced, its leftover drafts must
      // not remain fireable — firing spends real money outside the gate.
      if (typeof sidecar.auto_run_id === "string" && sidecar.auto_run_id !== "") {
        const run = projects.get(id)?.meta?.auto_run;
        if (!run || run.id !== sidecar.auto_run_id || !isActiveAutoRun(run)) {
          throw Object.assign(
            new Error(`auto run ${sidecar.auto_run_id} is no longer active`),
            { http: 409 },
          );
        }
      }
      sidecar = markSidecarRunning(sidecar);
      const tmp = target + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(sidecar) + "\n");
      await fsp.rename(tmp, target);
      claimed = await readPendingEntry(id, jobId);
      if (!claimed) {
        throw Object.assign(new Error("draft not found"), { http: 404 });
      }
    });
    return claimed;
  }

  async function writeResultAndBroadcast(id, jobId, result) {
    const wrote = await writeResult(id, jobId, result);
    if (!wrote) return false;
    const raw = await readResultEntry(id, jobId);
    const summary = normalizeResultEntry(jobId, raw);
    const p = projects.get(id);
    if (p && summary) {
      if (!p.generationResults) p.generationResults = new Map();
      p.generationResults.set(jobId, summary);
      broadcasters?.broadcastGenerationResults?.(id);
    }
    return true;
  }

  app.patch("/projects/:id/pending/:jobId", async (req, res) => {
    const { id, jobId } = req.params;
    if (!projects.has(id)) return res.status(404).json({ error: "not found" });
    const entry = await readPendingEntry(id, jobId);
    if (!entry) return res.status(404).json({ error: "draft not found" });
    const patch = req.body || {};
    // Position can be patched at any stage — running pads are draggable
    // too, and the position is purely view state. Everything else is
    // gated on draft.
    const positionPatch = isValidPosition(patch.position) ? { x: patch.position.x, y: patch.position.y } : null;
    const hasContentEdit = Object.keys(PATCH_FLAGS).some((k) => (
      patch[k] !== undefined && isPatchKeyEditableForEntry(k, entry)
    ));
    if (hasContentEdit && entry.stage !== "draft") {
      return res.status(409).json({ error: `cannot edit ${entry.stage} entry` });
    }
    if (positionPatch === null && !hasContentEdit) {
      return res.status(400).json({ error: "no editable fields in body" });
    }
    // A duration edit obeys the same gate as generate_video.js — an
    // out-of-range value would persist a quote the CLI rejects at fire time.
    if (patch.duration !== undefined && entry.script === "generate_video.js") {
      const bounds = videoOutputDurationBounds(entry.model);
      const dur = Number(patch.duration);
      if (!Number.isInteger(dur) || dur < bounds.min || dur > bounds.max) {
        return res.status(400).json({
          error: `--duration must be an integer between ${bounds.min} and ${bounds.max} seconds (model ${entry.model}); got "${patch.duration}"`,
        });
      }
      // 2.5 is priced per call inside a billed-seconds tier — the output clip
      // plus the reference video the vendor has to read — and there is no
      // pricing row past the top tier. Without this, an edit over the cap is
      // accepted, the re-quote below returns null, the `Number.isFinite`
      // guard (:317) leaves the OLD cost_usd in place, and the Generate button
      // shows a price for a job the CLI will refuse to fire. The message names
      // both components because the reference half is the half the user cannot
      // see.
      const limits = videoLimitsFor(entry.model);
      const refSec = Number.isFinite(entry.ref_video_seconds) ? entry.ref_video_seconds : 0;
      if (limits.max_billed_sec && dur + refSec > limits.max_billed_sec) {
        return res.status(400).json({
          error: `billed duration ${dur + refSec}s exceeds the ${limits.max_billed_sec}s maximum (model ${entry.model}): ${dur}s of output plus ${refSec}s of reference video. Shorten the clip or drop a video reference.`,
        });
      }
      patch.duration = dur;
    }
    // PATCH_FLAGS lets `resolution` be edited (:42, :52) and nothing validated
    // it. On 2.5 that is a display bug with money attached: the tier table keys
    // the composite rows on the exact string, so a "1080P" re-quotes the bare
    // tier onto the Generate button and is only caught by the CLI at fire.
    // Normalise and refuse here so the number shown is the number charged.
    //
    // 🔴 `resNorm`, NOT `res` — `res` is the Express response object in this
    // handler's scope.
    if (patch.resolution !== undefined && entry.script === "generate_video.js") {
      const resNorm = String(patch.resolution).toLowerCase();
      // `max_billed_sec` is only set for the 2.5 model — see _limits.js's
      // videoLimitsFor. 2.0 keeps its existing unvalidated behaviour.
      const allowed = videoLimitsFor(entry.model).max_billed_sec ? VIDEO_25_RESOLUTIONS : null;
      if (allowed && !allowed.includes(resNorm)) {
        return res.status(400).json({
          error: `--resolution must be one of ${allowed.join(" | ")} (model ${entry.model}); got "${patch.resolution}"`,
        });
      }
      if (allowed) patch.resolution = resNorm;
    }
    try {
      await withProjectMutationLock(id, async () => {
        const raw = await fsp.readFile(pendingPath(id, jobId), "utf8");
        const sidecar = JSON.parse(raw);
        if (hasContentEdit && sidecar.stage !== "draft") {
          throw Object.assign(new Error(`cannot edit ${sidecar.stage} entry`), { http: 409 });
        }
        if (positionPatch !== null) sidecar.position = positionPatch;
        if (hasContentEdit) {
          const argv = Array.isArray(sidecar.argv) ? [...sidecar.argv] : [];
          let costedChanged = false;
          for (const [key, flag] of Object.entries(PATCH_FLAGS)) {
            if (patch[key] === undefined) continue;
            if (!isPatchKeyEditableForEntry(key, sidecar)) continue;
            sidecar[key] = patch[key];
            if (COSTED_PATCH_KEYS.has(key)) costedChanged = true;
            const value = String(patch[key]);
            const idx = argv.indexOf(flag);
            if (idx >= 0 && idx + 1 < argv.length) argv[idx + 1] = value;
            else argv.push(flag, value);
          }
          sidecar.argv = argv;
          if (costedChanged && typeof sidecar.model === "string") {
            // References count toward the price a video draft books —
            // generate_video.js pre-uploads each one — so re-pricing on the
            // model alone would quote less than the job will spend. The
            // number on the Generate button is the one being approved, so it
            // has to be the one that will be charged.
            const refs = Array.isArray(sidecar.reference_source_ids)
              ? new Set(sidecar.reference_source_ids).size
              : 0;
            const next = stagedCostUsd(sidecar.model, {
              image_size: sidecar.image_size,
              resolution: sidecar.resolution,
              duration: sidecar.duration,
              // 2.5's tier is keyed on output + reference-video seconds.
              // Without the reference half, a duration edit re-quotes a tier
              // below the one that will actually be charged — and this number
              // is the one on the Generate button, which is the one the user
              // is being asked to approve. Read off the raw sidecar (not the
              // whitelisted entry), so no extra readers.js field is needed here.
              ref_video_seconds: sidecar.ref_video_seconds,
              text: sidecar.text,
            }, refs);
            if (typeof next === "number" && Number.isFinite(next)) {
              // An Auto draft's reservation was taken at stage time and
              // the ledger has no re-reserve; a cost-raising edit would
              // fire real spend above what the budget gate admitted.
              if (typeof sidecar.auto_run_id === "string" && sidecar.auto_run_id !== "") {
                const prevCost =
                  typeof sidecar.cost_usd === "number" && Number.isFinite(sidecar.cost_usd)
                    ? sidecar.cost_usd
                    : 0;
                if (next > prevCost + 0.0005) {
                  throw Object.assign(
                    new Error("cannot raise the cost of a reserved Auto draft; cancel it and stage a new job"),
                    { http: 409 },
                  );
                }
              }
              sidecar.cost_usd = next;
            }
          }
        }
        const target = pendingPath(id, jobId);
        const tmp = target + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(sidecar) + "\n");
        await fsp.rename(tmp, target);
      });
      res.json({ ok: true });
    } catch (e) {
      if (e?.http) return res.status(e.http).json({ error: e.message });
      console.warn(`[viewer] PATCH /projects/${id}/pending/${jobId} failed:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  // stdio piped + attached (not detached/unref'd) so we can capture the
  // CLI's final JSON line and persist it as the durable result sidecar.
  // Tradeoff: a viewer restart kills any in-flight CLI; boot recovery
  // turns the surviving running sidecar into an aborted result.
  app.post("/projects/:id/pending/:jobId/generate", async (req, res) => {
    const { id, jobId } = req.params;
    if (!projects.has(id)) return res.status(404).json({ error: "not found" });
    let entry;
    try {
      entry = await claimDraftForGenerate(id, jobId);
    } catch (e) {
      if (e?.http) return res.status(e.http).json({ error: e.message });
      console.warn(`[viewer] POST /projects/${id}/pending/${jobId}/generate claim failed:`, e);
      return res.status(500).json({ error: e.message });
    }
    try {
      const child = spawn(
        "node",
        [
          path.join(PAI_REPO_ROOT, "server", "cli", entry.script),
          "--existing-job-id", jobId,
          ...(Array.isArray(entry.argv) ? entry.argv : []),
        ],
        { cwd: projectDir(id), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Tail both streams — _cli.js prints one JSON line to stdout, but
      // uncaught throws bypass fail() and land on stderr.
      let outBuf = "";
      let spawnError = null;
      let finalized = false;
      let timedOut = false;
      const timeoutMs = runningTimeoutMsForEntry(entry);
      let killTimer = null;
      const append = (b) => {
        outBuf += b.toString();
        if (outBuf.length > 65536) outBuf = outBuf.slice(-65536);
      };
      const finalize = async (code, signal) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        const parsed = timedOut ? null : parseTailJson(outBuf);
        if (!parsed && code === 0) {
          console.warn(`[viewer] ${entry.script} for ${id}/${jobId} exited 0 without result JSON`);
        }
        const result = {
          ...pendingContext(entry),
          ...(parsed || fallbackResult({ jobId, code, signal, spawnError, timedOut, timeoutMs })),
          job_id: jobId,
          kind: entry.kind,
        };
        try {
          await writeResultAndBroadcast(id, jobId, result);
          await removePendingSidecar(id, jobId);
        } catch (e) {
          console.warn(`[viewer] result finalize failed for ${id}/${jobId}:`, e);
        }
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!finalized) child.kill("SIGKILL");
        }, RUNNING_TIMEOUT_KILL_GRACE_MS);
      }, timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => {
        spawnError = err;
        void finalize(null, null);
      });
      child.on("close", (code, signal) => { void finalize(code, signal); });
      res.status(202).json({ ok: true, job_id: jobId, pid: child.pid ?? null });
    } catch (e) {
      console.warn(`[viewer] POST /projects/${id}/pending/${jobId}/generate failed:`, e);
      try {
        await writeResultAndBroadcast(id, jobId, {
          ...pendingContext(entry),
          ...fallbackResult({ jobId, spawnError: e }),
          kind: entry.kind,
        });
        await removePendingSidecar(id, jobId);
      } catch (finalizeError) {
        console.warn(`[viewer] spawn failure finalize failed for ${id}/${jobId}:`, finalizeError);
      }
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/projects/:id/pending/:jobId", async (req, res) => {
    const { id, jobId } = req.params;
    if (!projects.has(id)) return res.status(404).json({ error: "not found" });
    try {
      const entry = await readPendingEntry(id, jobId);
      if (entry) {
        if (entry.stage !== "draft") {
          return res.status(409).json({ error: `cannot cancel ${entry.stage} entry` });
        }
        await writeResultAndBroadcast(id, jobId, {
          ...pendingContext(entry),
          ok: false,
          job_id: jobId,
          kind: entry.kind,
          klass: "cancelled",
          message: "cancelled by user",
        });
      }
      await removePendingSidecar(id, jobId);
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.warn(`[viewer] DELETE /projects/${id}/pending/${jobId} failed:`, e);
        return res.status(500).json({ error: e.message });
      }
    }
    res.json({ ok: true });
  });
}
