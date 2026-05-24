// Project asset I/O helpers. Generation CLIs stage assets via mirrorToTmp /
// writeBytesToTmp and hand the absolute path to the mutator (addNode
// tmp_path); the mutator renames into assets/<kind>/<node-id>.<ext> under
// its lock so filenames always match node ids.

import fs from "node:fs/promises";
import fsSync from "node:fs";
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

export async function mirrorToTmp({ url, projectId, filename }) {
  if (!url) throw new Error("mirrorToTmp: url required");
  const proj = projectId || await readActiveProject();
  const ext = path.extname(basenameFromUrl(url)) || ".bin";
  const fname = filename || `tmp_${crypto.randomBytes(8).toString("hex")}${ext}`;
  const relPath = path.posix.join("assets", TMP_DIRNAME, fname);
  const absPath = path.join(PAI_REPO_ROOT, "projects", proj, relPath);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`mirror download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buf);
  return { local_path: relPath, absolute_path: absPath, filename: fname };
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

