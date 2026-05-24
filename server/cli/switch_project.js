// Switch the active project — atomically updates the workflow.json symlink
// at the repo root and the .active_project marker so the agent's
// `./workflow.json` references resolve to the requested project.
//
// Usage:
//   node server/cli/switch_project.js --id <project-id>
//   node server/cli/switch_project.js --list
//
// Success JSON: { ok: true, active, projects: [{ id, title, last_active_at }] }
// Failure JSON: { ok: false, klass, message } — same shape as the media CLIs.

import fs from "node:fs/promises";
import path from "node:path";
import { PAI_REPO_ROOT, parseArgs, emitSuccess, emitFailure } from "./_cli.js";

const PROJECTS_DIR = path.join(PAI_REPO_ROOT, "projects");
const ACTIVE_FILE  = path.join(PAI_REPO_ROOT, ".active_project");
const ROOT_LINK    = path.join(PAI_REPO_ROOT, "workflow.json");

async function listProjects() {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(PROJECTS_DIR, e.name, "meta.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      out.push({
        id: meta.id || e.name,
        title: meta.title || "",
        last_active_at: meta.last_active_at || null,
      });
    } catch {
      out.push({ id: e.name, title: "", last_active_at: null });
    }
  }
  out.sort((a, b) => {
    const at = Date.parse(a.last_active_at || 0) || 0;
    const bt = Date.parse(b.last_active_at || 0) || 0;
    return bt - at;
  });
  return out;
}

async function flipSymlink(linkPath, targetRel) {
  const tmp = linkPath + ".tmp";
  try { await fs.unlink(tmp); } catch {}
  await fs.symlink(targetRel, tmp);
  await fs.rename(tmp, linkPath);
}

async function setActive(id) {
  const dir = path.join(PROJECTS_DIR, id);
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new Error(`projects/${id} is not a directory`);
  } catch (e) {
    if (e.code === "ENOENT") {
      emitFailure("bad_args", `project not found: ${id}`);
      process.exit(2);
    }
    throw e;
  }

  const metaPath = path.join(dir, "meta.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.last_active_at = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  await flipSymlink(ROOT_LINK, path.join("projects", id, "workflow.json"));
  await fs.writeFile(ACTIVE_FILE, id + "\n");
}

async function main() {
  const args = parseArgs({
    id:   { type: "string" },
    list: { type: "boolean", default: false },
  });

  try {
    if (args.list) {
      const ps = await listProjects();
      emitSuccess({ active: null, projects: ps });
      return;
    }
    if (!args.id) {
      emitFailure("bad_args", "missing --id <project-id> (or use --list)");
      process.exit(2);
    }
    await setActive(args.id);
    const ps = await listProjects();
    emitSuccess({ active: args.id, projects: ps });
  } catch (e) {
    emitFailure("infra", e.message || String(e));
    process.exit(1);
  }
}

main();
