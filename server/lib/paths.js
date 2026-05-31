// Process-wide config + pure path helpers + id validators. No I/O,
// no Express, no Socket.IO — just the constants and computations
// every other module needs.
//
// Test-mode overrides (PAI_PROJECTS_DIR, PAI_ACTIVE_FILE, PAI_ROOT_LINK):
// the integration tests spawn the viewer with these pointed at a tmp
// dir so a failing test never touches the real repo's .active_project
// or workflow.json symlink. In normal use, all three resolve under
// PAI_REPO_ROOT.

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PAI_REPO_ROOT = path.resolve(__dirname, "..", "..");

dotenvConfig({ path: path.join(PAI_REPO_ROOT, ".env") });

export const PORT         = parseInt(process.env.VIEWER_PORT ?? "7488", 10);
export const WEB_ORIGIN   = process.env.WEB_ORIGIN ?? "http://localhost:7443";
export const PROJECTS_DIR = process.env.PAI_PROJECTS_DIR ?? path.join(PAI_REPO_ROOT, "projects");
export const ACTIVE_FILE  = process.env.PAI_ACTIVE_FILE  ?? path.join(PAI_REPO_ROOT, ".active_project");
export const ROOT_LINK    = process.env.PAI_ROOT_LINK    ?? path.join(PAI_REPO_ROOT, "workflow.json");

export function isValidId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(id);
}

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

// Random id for untitled projects — `project_<6 base36 chars>`. The
// underscore distinguishes the auto-prefix from a user-titled slug
// (which uses hyphens via slugify), so default ids never look like a
// real project name. ~2.1B combos; collisions handled at the call site.
export function genProjectId() {
  let s = "";
  while (s.length < 6) s += Math.random().toString(36).slice(2);
  return "project_" + s.slice(0, 6);
}

export function projectDir(id)        { return path.join(PROJECTS_DIR, id); }
export function metaPath(id)          { return path.join(projectDir(id), "meta.json"); }
export function workflowPath(id)      { return path.join(projectDir(id), "workflow.json"); }
export function pendingDir(id)        { return path.join(projectDir(id), ".pending"); }
export function resultsDir(id)        { return path.join(projectDir(id), ".results"); }
export function agentNotificationsDir(id) {
  return path.join(projectDir(id), ".agent_notifications");
}
export function canvasPositionsPath(id) {
  return path.join(projectDir(id), "canvas_positions.json");
}
export function mutationLogPath(id) {
  return path.join(projectDir(id), "mutations.jsonl");
}

// Extract the project id from a viewer asset URL so asset-status chip
// events fan out only to that project's subscribers and so the cache
// file writer can scope its serialization. Returns null for non-viewer
// URLs.
export function projectIdFromCanvasUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const m = /\/projects\/([^/]+)\/assets\//.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

// Running-stage sidecars older than this are treated as orphans — most
// likely from a CLI that crashed before its `finally` could unlink them.
// Generation wall-clocks: image ~30s, image pro ~3-6min, video ~4min.
// 15min gives a generous buffer and stays above image pro's 10min
// client timeout so a still-running pro call is not swept as stale.
export const PENDING_STALE_RUNNING_MS = 15 * 60 * 1000;
// Draft-stage sidecars are user-staged calls awaiting approval. Drafts
// can sit on the canvas across a working session, so give them a much
// longer leash before the orphan sweep. Discard via the canvas Discard
// button (PR #2) or `rm projects/<id>/.pending/<jobId>.json`.
export const PENDING_STALE_DRAFT_MS = 24 * 60 * 60 * 1000;
