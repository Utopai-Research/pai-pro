// Project asset I/O helpers. Generation CLIs stage assets via
// writeBytesToTmp (in-memory bytes) or streamUrlToTmp (a remote URL
// streamed straight to disk) and hand the absolute path to the mutator
// (addNode tmp_path); the mutator renames into
// assets/<kind>/<node-id>.<ext> under its lock so filenames always match
// node ids.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";
import { PAI_REPO_ROOT } from "./lib/paths.js";

const PROJECTS_DIR = path.join(PAI_REPO_ROOT, "projects");
const ACTIVE_FILE  = path.join(PAI_REPO_ROOT, ".active_project");

const MIME_TO_EXT = {
  "image/png":  "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif":  "gif",
  "video/mp4":  "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/wav":  "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4":  "m4a",
  "audio/aac":  "aac",
  "audio/ogg":  "ogg",
  "audio/flac": "flac",
};

// Prefer the project the script is *running inside* over the global
// `.active_project` file — the embedded terminal spawns each pty with
// cwd=projects/<id>/, so process.cwd() is the source of truth for which
// project the user is actually working on. Falling back to .active_project
// only matters when the script is run from the repo root manually (rare).
function projectFromCwd() {
  let cur = process.cwd();
  while (cur !== path.dirname(cur)) {
    const parent = path.dirname(cur);
    if (parent === PROJECTS_DIR) return path.basename(cur);
    cur = parent;
  }
  return null;
}

export async function readActiveProject() {
  const fromCwd = projectFromCwd();
  if (fromCwd) return fromCwd;
  const raw = await fs.readFile(ACTIVE_FILE, "utf8");
  const id = raw.trim();
  if (!id) throw new Error(".active_project is empty");
  return id;
}

function basenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname) || `asset_${Date.now()}.bin`;
  } catch {
    return `asset_${Date.now()}.bin`;
  }
}

const TMP_DIRNAME = ".tmp";

function classifiedError(klass, message, cause) {
  const e = new Error(message);
  e.klass = klass;
  if (cause) e.cause = cause;
  return e;
}

function downloadCauseDetail(e) {
  const cause = e?.cause;
  const nested = cause?.cause;
  const code = cause?.code || nested?.code;
  const message = cause?.message || nested?.message;
  const parts = [];
  if (code) parts.push(code);
  if (message && message !== e?.message) parts.push(message);
  return parts.join(": ");
}

function withDownloadDetail(message, e) {
  const detail = downloadCauseDetail(e);
  return detail ? `${message} (${detail})` : message;
}

function retryCount(attempts) {
  const n = Number(attempts);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

function retryDelay(retryDelayMs) {
  const n = Number(retryDelayMs);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

// Download a remote URL straight to a tmp file by streaming the response
// body to disk — the bytes never accumulate in a single Buffer. Used for
// large write-only assets (e.g. generate_video.js's MP4, tens of MB per
// 1080p clip) where buffering the whole payload in RAM made the
// long-lived viewer sluggish / OOM under draft-gate fan-out. Same return
// shape as writeBytesToTmp; pick the extension from mimeType, falling back
// to the URL's own extension.
export async function streamUrlToTmp({
  url,
  mimeType,
  projectId,
  filename,
  timeoutMs = 120_000,
  attempts = 1,
  retryDelayMs = 1_000,
}) {
  if (!url) throw new Error("streamUrlToTmp: url required");
  const proj = projectId || await readActiveProject();
  const urlExt = path.extname(basenameFromUrl(url)).replace(/^\./, "") || "bin";
  const ext = extensionForMime(mimeType, urlExt);
  const fname = filename || `tmp_${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const relPath = path.posix.join("assets", TMP_DIRNAME, fname);
  const absPath = path.join(PAI_REPO_ROOT, "projects", proj, relPath);
  const maxAttempts = retryCount(attempts);
  const delayMs = retryDelay(retryDelayMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw classifiedError("transient", withDownloadDetail(`stream download failed: ${e.message}`, e), e);
      }
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        const detail = body ? body.slice(0, 200) : url;
        throw classifiedError("transient", `stream download failed (${res.status} ${res.statusText}): ${detail}`);
      }
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      try {
        // res.body is a WHATWG ReadableStream; pipeline wants a Node stream.
        await pipeline(Readable.fromWeb(res.body), fsSync.createWriteStream(absPath));
      } catch (e) {
        // Leave no half-written tmp file behind on a mid-stream error.
        await fs.unlink(absPath).catch(() => {});
        const localWriteError = e?.path === absPath
          || ["EACCES", "ENOENT", "ENOSPC", "EPERM"].includes(e?.code);
        if (!localWriteError) {
          throw classifiedError("transient", withDownloadDetail(`stream download failed: ${e.message}`, e), e);
        }
        throw e;
      }
      return { local_path: relPath, absolute_path: absPath, filename: fname };
    } catch (e) {
      if (e.klass !== "transient" || attempt >= maxAttempts) {
        if (e.klass === "transient" && maxAttempts > 1) {
          e.downloadAttempts = attempt;
          const detail = downloadCauseDetail(e);
          if (detail) e.downloadCause = detail;
          e.message = `${e.message} after ${attempt} attempts`;
        }
        throw e;
      }
      await sleep(delayMs);
    }
  }
}

export async function writeBytesToTmp({ bytes, mimeType, projectId, filename }) {
  if (!bytes || !bytes.length) throw new Error("writeBytesToTmp: empty bytes");
  const proj = projectId || await readActiveProject();
  const ext = extensionForMime(mimeType);
  const fname = filename || `tmp_${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const relPath = path.posix.join("assets", TMP_DIRNAME, fname);
  const absPath = path.join(PAI_REPO_ROOT, "projects", proj, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, bytes);
  return { local_path: relPath, absolute_path: absPath, filename: fname };
}

function extensionForMime(mime, fallback = "bin") {
  return MIME_TO_EXT[String(mime || "").toLowerCase()] || fallback;
}

/**
 * Build the path the viewer serves a mirrored asset at — always RELATIVE
 * (`/projects/:id/assets/...`), never an absolute URL with a baked-in
 * host:port. Browsers auto-resolve relative URLs against the page's
 * origin, which is the only thing that's correct across:
 *   - host dev mode (Vite :7443 proxies /projects to viewer :7488)
 *   - host prod mode (viewer serves SPA + assets from same :7488)
 *   - Docker (container :7488 → host :7588, same origin via SPA serve)
 *
 * The old form `http://${VIEWER_HOST}:${VIEWER_PORT}/projects/...` baked
 * the container-internal port into workflow.json, which broke any time
 * the host port differed from the container port (e.g. Docker default
 * mapping `7588:7488`).
 */
export function viewerUrlForLocalPath({ localPath, projectId }) {
  if (!localPath) return null;
  // strip any leading slash; ensure forward slashes on Windows just in case
  const rel = String(localPath).replace(/^\/+/, "").replace(/\\/g, "/");
  return `/projects/${encodeURIComponent(projectId)}/${rel}`;
}

// Cloudflared tunnel origin. File-only on purpose: env vars baked into
// long-running PTYs go stale when the tunnel rotates, but scripts/start.sh
// rewrites $PAI_REPO_ROOT/.tunnel_url on every launch, so a fresh CLI
// invocation always picks up the current URL.
export function readTunnelOrigin() {
  try {
    const raw = fsSync.readFileSync(path.join(PAI_REPO_ROOT, ".tunnel_url"), "utf8").trim();
    return raw ? raw.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Same shape as viewerUrlForLocalPath, but the host is the cloudflared
 * tunnel origin. Returns null when no tunnel is configured.
 */
export function tunnelUrlForLocalPath({ localPath, projectId }) {
  if (!localPath || !projectId) return null;
  const origin = readTunnelOrigin();
  if (!origin) return null;
  const rel = String(localPath).replace(/^\/+/, "").replace(/\\/g, "/");
  return `${origin}/projects/${encodeURIComponent(projectId)}/${rel}`;
}

// Best-effort read of a single node from the project's workflow.json.
// Returns null on any miss (no nodeId, unreadable / unparsable file,
// no nodes array, no matching id). Readers below funnel through this.
async function readNodeFromWorkflow({ nodeId, projectId }) {
  if (!nodeId) return null;
  const proj = projectId || await readActiveProject();
  const wfPath = path.join(PAI_REPO_ROOT, "projects", proj, "workflow.json");
  let raw;
  try { raw = await fs.readFile(wfPath, "utf8"); } catch { return null; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(doc?.nodes)) return null;
  return doc.nodes.find((n) => n?.id === nodeId) ?? null;
}

// Used by generate_video.js to partition a flat --ref-source-id list
// into image / video buckets and reject wrong-typed refs.
export async function readNodeType({ nodeId, projectId }) {
  const node = await readNodeFromWorkflow({ nodeId, projectId });
  return typeof node?.type === "string" ? node.type : null;
}

export async function readNodeAssetInfo({ nodeId, projectId }) {
  const node = await readNodeFromWorkflow({ nodeId, projectId });
  if (!node) return null;
  return {
    localPath: typeof node?.data?.local_path === "string" ? node.data.local_path : null,
    label: typeof node?.data?.label === "string" ? node.data.label : null,
    archived: node?.data?.archived === true,
  };
}

// Used by postNodeAddBatch to fail-fast before the provider call when an
// agent references an archived node.
export async function readNodeArchived({ nodeId, projectId }) {
  const node = await readNodeFromWorkflow({ nodeId, projectId });
  return node?.data?.archived === true;
}

function makeBadArgs(message) {
  const e = new Error(message);
  e.klass = "bad_args";
  return e;
}

/**
 * Build the array of refs to hand to a provider. Every ref is a canvas
 * node id — we look up its `local_path` and rewrite the host onto the
 * cloudflared tunnel origin so PAI's server-side fetch can reach it.
 * The cached PAI `asset_id` (if any) rides alongside so callers that
 * upload through video-generation-assets can skip CreateAsset when it's
 * already known.
 *
 * External URLs are not accepted here. The agent mirrors them onto the
 * canvas first via `mirror_url.js`, which mints a `subtype: "reference"`
 * node, and then references that node like any other canvas source.
 *
 * @param {Object}    opts
 * @param {string[]}  opts.sourceIds  list of --ref-source-id values
 * @param {string}    [opts.projectId]
 * @returns {Promise<{ tunnelUrl: string, assetId: string | null }[]>}
 */
export async function buildProviderRefs({ sourceIds = [], projectId } = {}) {
  const proj = projectId || await readActiveProject();
  const out = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const sid = sourceIds[i];
    if (!sid) continue;
    const node = await readNodeFromWorkflow({ nodeId: sid, projectId: proj });
    // Refuse archived sources before the provider call — the CLAUDE.md
    // rule tells the agent to filter archived; this is the
    // system-boundary backstop.
    if (node?.data?.archived === true) {
      throw makeBadArgs(
        `Ref ${i + 1}: node ${sid} is archived. Pick a live node, or ask the user to restore it.`,
      );
    }
    const lp = node?.data?.local_path;
    if (typeof lp !== "string" || !lp) {
      throw makeBadArgs(
        `Ref ${i + 1}: node ${sid} has no local_path. Asset nodes must carry local_path; if this is an old workflow.json shape, regenerate the asset.`,
      );
    }
    const tunnelUrl = tunnelUrlForLocalPath({ localPath: lp, projectId: proj });
    if (!tunnelUrl) {
      throw makeBadArgs(
        `No tunnel configured for ref ${i + 1}. Run ./scripts/start.sh (auto-launches cloudflared).`,
      );
    }
    const md = node?.data?.metadata;
    const assetId = typeof md?.asset_id === "string" && md.asset_id ? md.asset_id : null;
    out.push({ tunnelUrl, assetId });
  }
  return out;
}
