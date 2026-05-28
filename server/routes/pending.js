// Pending-draft fire path. Three routes that let the browser (or curl)
// edit, fire, or discard a `.pending/<jobId>.json` sidecar that was
// staged by a generate_*.js CLI with --stage. The chokidar watcher in
// services/watcher.js fans `pending-generations` out on every sidecar
// add/change/unlink, so PATCH + DELETE need no extra emit; POST
// /generate spawns the same CLI with --existing-job-id so it flips the
// draft sidecar to running in place, then writes a durable result sidecar.
//
// Security: POST /generate gates the captured `script` against an
// explicit whitelist. argv is passed positionally to spawn (no shell),
// so a tampered sidecar can't inject arbitrary commands.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { getCost } from "../model_registry.js";
import { PAI_REPO_ROOT, pendingDir, projectDir } from "../lib/paths.js";
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
]);

// Patch-key → CLI flag. Only these fields can be edited via PATCH;
// anything else in the body is ignored. image_size / resolution /
// duration are the cost drivers — patching one of them re-runs getCost.
const PATCH_FLAGS = {
  prompt:        "--prompt",
  aspect_ratio:  "--aspect-ratio",
  image_size:    "--image-size",
  resolution:    "--resolution",
  duration:      "--duration",
  text:          "--text",
};

const IMAGE_PRO_DISPLAY_ONLY_PATCH_KEYS = new Set(["aspect_ratio", "image_size"]);

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

function fallbackResult({ jobId, code, signal, spawnError }) {
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
    "text",
    "position",
    "reference_source_ids",
    "source_node_id",
  ]) {
    if (entry?.[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

export function registerPendingRoutes({ app, projects, broadcasters }) {
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
            if (key === "image_size" || key === "resolution" || key === "duration") {
              costedChanged = true;
            }
            const value = String(patch[key]);
            const idx = argv.indexOf(flag);
            if (idx >= 0 && idx + 1 < argv.length) argv[idx + 1] = value;
            else argv.push(flag, value);
          }
          sidecar.argv = argv;
          if (costedChanged && typeof sidecar.model === "string") {
            const next = getCost(sidecar.model, {
              image_size: sidecar.image_size,
              resolution: sidecar.resolution,
              duration: sidecar.duration,
            });
            if (typeof next === "number" && Number.isFinite(next)) {
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
    const entry = await readPendingEntry(id, jobId);
    if (!entry) return res.status(404).json({ error: "draft not found" });
    if (entry.stage !== "draft") {
      return res.status(409).json({ error: `already ${entry.stage}` });
    }
    if (!entry.script || !ALLOWED_SCRIPTS.has(entry.script)) {
      return res.status(400).json({ error: `unknown script: ${entry.script}` });
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
      const append = (b) => {
        outBuf += b.toString();
        if (outBuf.length > 65536) outBuf = outBuf.slice(-65536);
      };
      const finalize = async (code, signal) => {
        if (finalized) return;
        finalized = true;
        const parsed = parseTailJson(outBuf);
        if (!parsed && code === 0) {
          console.warn(`[viewer] ${entry.script} for ${id}/${jobId} exited 0 without result JSON`);
        }
        const result = {
          ...pendingContext(entry),
          ...(parsed || fallbackResult({ jobId, code, signal, spawnError })),
          job_id: jobId,
          kind: entry.kind,
        };
        try {
          const wrote = await writeResult(id, jobId, result);
          if (wrote) {
            const raw = await readResultEntry(id, jobId);
            const summary = normalizeResultEntry(jobId, raw);
            const p = projects.get(id);
            if (p && summary) {
              if (!p.generationResults) p.generationResults = new Map();
              p.generationResults.set(jobId, summary);
              broadcasters?.broadcastGenerationResults?.(id);
            }
          }
          await removePendingSidecar(id, jobId);
        } catch (e) {
          console.warn(`[viewer] result finalize failed for ${id}/${jobId}:`, e);
        }
      };
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
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/projects/:id/pending/:jobId", async (req, res) => {
    const { id, jobId } = req.params;
    if (!projects.has(id)) return res.status(404).json({ error: "not found" });
    try {
      await fsp.unlink(pendingPath(id, jobId));
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.warn(`[viewer] DELETE /projects/${id}/pending/${jobId} failed:`, e);
        return res.status(500).json({ error: e.message });
      }
    }
    res.json({ ok: true });
  });
}
