#!/usr/bin/env node
// One-shot migration: rename every project asset on disk to match its
// canvas node id, drop the assets/refs/ bucket (move user-uploaded image
// and video refs into the per-kind folder), and initialize the persistent
// next_ids counter in workflow.json.
//
// Usage:
//   node server/cli/migrate_ids.js --all
//   node server/cli/migrate_ids.js --project <id>
//   node server/cli/migrate_ids.js --all --dry-run
//   node server/cli/migrate_ids.js --all --force   # overwrite an existing backup
//
// Idempotent — a second run on a migrated project is a no-op.
//
// Output (stdout, one JSON line per project):
//   { ok: true, project_id, renames: int, url_rewrites: int, dry_run: bool }
//   { ok: false, project_id, message }

import fs from "node:fs/promises";
import path from "node:path";
import { PAI_REPO_ROOT } from "../lib/paths.js";

const PROJECTS_DIR = path.join(PAI_REPO_ROOT, "projects");

const BUCKET_BY_TYPE = {
  image_result: "images",
  video_result: "videos",
  audio_result: "audios",
};
const URL_FIELD_BY_TYPE = {
  image_result: "image_url",
  video_result: "video_url",
  audio_result: "audio_url",
};

function parseArgv(argv) {
  const out = { all: false, project: null, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  if (!out.all && !out.project) {
    process.stderr.write("missing --all or --project <id>\n");
    process.exit(2);
  }
  return out;
}

function viewerUrlForLocalPath(projectId, localRel) {
  const port = parseInt(process.env.VIEWER_PORT ?? "7488", 10);
  const host = process.env.VIEWER_HOST || "localhost";
  return `http://${host}:${port}/projects/${encodeURIComponent(projectId)}/${localRel}`;
}

async function listProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

async function statSafe(p) {
  try { return await fs.stat(p); } catch { return null; }
}

async function migrateProject(projectId, { dryRun, force }) {
  const projDir = path.join(PROJECTS_DIR, projectId);
  const wfPath = path.join(projDir, "workflow.json");
  const wfStat = await statSafe(wfPath);
  if (!wfStat) {
    return { ok: false, project_id: projectId, message: "no workflow.json" };
  }
  const raw = await fs.readFile(wfPath, "utf8");
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) {
    return { ok: false, project_id: projectId, message: `workflow.json parse: ${e.message}` };
  }
  if (!Array.isArray(doc.nodes)) doc.nodes = [];

  const backupPath = wfPath + ".pre-migration";
  const backupStat = await statSafe(backupPath);
  if ((!backupStat || force) && !dryRun) {
    await fs.writeFile(backupPath, raw, "utf8");
  }

  const renames = [];
  const urlRewrites = new Map();
  for (const node of doc.nodes) {
    const oldRel = node?.data?.local_path;
    if (!oldRel || typeof oldRel !== "string") continue;
    const bucket = BUCKET_BY_TYPE[node.type];
    if (!bucket) continue;
    const ext = path.extname(oldRel) || ".bin";
    const newRel = path.posix.join("assets", bucket, `${node.id}${ext}`);
    if (newRel === oldRel) continue;
    renames.push({
      fromAbs: path.join(projDir, oldRel),
      toAbs: path.join(projDir, newRel),
      fromRel: oldRel,
      toRel: newRel,
      node,
    });
    urlRewrites.set(
      viewerUrlForLocalPath(projectId, oldRel),
      viewerUrlForLocalPath(projectId, newRel),
    );
  }

  let renamedCount = 0;
  for (const r of renames) {
    const srcStat = await statSafe(r.fromAbs);
    const dstStat = await statSafe(r.toAbs);
    if (!srcStat && dstStat) continue; // already migrated
    if (!srcStat && !dstStat) {
      process.stderr.write(
        `[migrate] ${projectId} node ${r.node.id}: source file missing (${r.fromRel}); leaving local_path stale\n`,
      );
      continue;
    }
    if (srcStat && dstStat) {
      process.stderr.write(
        `[migrate] ${projectId} node ${r.node.id}: target ${r.toRel} already exists; leaving source ${r.fromRel} as orphan\n`,
      );
    } else {
      if (!dryRun) {
        await fs.mkdir(path.dirname(r.toAbs), { recursive: true });
        await fs.rename(r.fromAbs, r.toAbs);
      }
      renamedCount += 1;
    }
    r.node.data.local_path = r.toRel;
    const urlField = URL_FIELD_BY_TYPE[r.node.type];
    if (urlField && typeof r.node.data[urlField] === "string") {
      r.node.data[urlField] = viewerUrlForLocalPath(projectId, r.toRel);
    }
  }

  // Embedded source_url uses the old filename — rewrite to the renamed target.
  let urlRewriteCount = 0;
  for (const node of doc.nodes) {
    const md = node?.data?.metadata;
    if (!md || typeof md !== "object") continue;
    const replUrl = urlRewrites.get(md.source_url);
    if (replUrl) {
      md.source_url = replUrl;
      urlRewriteCount += 1;
    }
  }

  const maxByType = { note: 0, image_result: 0, video_result: 0, audio_result: 0 };
  for (const node of doc.nodes) {
    const m = /^(?:note|image|video|audio)_(\d+)$/.exec(node.id || "");
    if (!m) continue;
    if (node.type in maxByType) {
      maxByType[node.type] = Math.max(maxByType[node.type], Number(m[1]));
    }
  }
  doc.next_ids = doc.next_ids || {};
  for (const t of Object.keys(maxByType)) {
    const cur = doc.next_ids[t];
    if (typeof cur !== "number" || cur < maxByType[t]) {
      doc.next_ids[t] = maxByType[t];
    }
  }

  if (!dryRun) {
    await fs.writeFile(wfPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }

  return {
    ok: true,
    project_id: projectId,
    renames: renamedCount,
    url_rewrites: urlRewriteCount,
    dry_run: dryRun,
  };
}

async function main() {
  const args = parseArgv(process.argv);
  const projects = args.all ? await listProjects() : [args.project];
  for (const id of projects) {
    const result = await migrateProject(id, { dryRun: args.dryRun, force: args.force });
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(`[migrate] fatal: ${e.message || e}\n`);
  process.exit(1);
});
