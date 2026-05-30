// Project lifecycle — load on viewer boot, mint a new on-disk project
// when none exists yet, ensure each project's asset folders before any
// write lands.

import fsp from "node:fs/promises";
import path from "node:path";

import { initProjectMutatorState } from "../canvas_mutator.js";
import { reseedFromCanvas } from "../pai_assets_client.js";
import { resolveAgentIdForMeta, resolveAgentIdForNewProject } from "../agents/index.js";
import {
  PAI_REPO_ROOT,
  PROJECTS_DIR,
  isValidId,
  projectDir,
  workflowPath,
  mutationLogPath,
  pendingDir,
} from "../lib/paths.js";
import {
  readMeta,
  readCanvas,
  readCanvasPositions,
  readPendingDir,
  readResultDir,
  readResultEntry,
  GENERATION_RESULTS_BUNDLE_LIMIT,
} from "../lib/readers.js";
import { writeMeta, writeActive, writeResult } from "../lib/writers.js";

// Per-project Claude wrapper. The `@./PROJECT_AGENT.md` import pulls in the
// canonical agent operating manual; everything below it is Claude-Code-
// specific (slash-command syntax, hook flag, output tool).
const PER_PROJECT_CLAUDE_MD = `# Per-project filmmaking agent — Claude

@./PROJECT_AGENT.md

You are invoked as \`claude\` in this project's PTY. The \`@./PROJECT_AGENT.md\` import above is the full operating manual — skills routing, media CLIs, canvas grammar, hard rules. Read it as authoritative.

Claude-specific notes:
- Skill invocation syntax is \`/<skill-name>\` (slash-prefixed). The skills referenced in PROJECT_AGENT.md (\`image-compose\`, \`video-compose\`, etc.) live at \`~/.claude/skills/\` and auto-discover by description.
- Every \`generate_image.js\`, \`generate_video.js\`, and \`generate_voice.js\` Bash call needs both the CLI flag \`--stage\` and the Bash tool option \`run_in_background: true\`; staged commands wait for the user's canvas Generate/Cancel decision before printing final JSON. This applies to every call in a parallel batch.
- To wait on a backgrounded Bash call's final JSON, use the \`BashOutput\` tool against the bash id you got back. Never \`cat\`/\`grep\` \`/tmp/claude-*/.../tasks/<id>.output\`.
`;

const PER_PROJECT_CODEX_AGENTS_MD = `# Per-project filmmaking agent -- Codex

Before doing any pai-pro work, read \`./PROJECT_AGENT.md\` and treat it as the authoritative operating manual for this project.

You are invoked as \`codex\` in this project's PTY.

Codex-specific notes:
- Repo-local skills live in \`.agents/skills/\` and are discoverable by Codex.
- Use staged media generation. Staged commands are long-running because they wait for the user's canvas Generate/Cancel decision before printing final JSON.
- For multiple independent staged generations, use Codex's background-capable command execution and inspect background terminals with \`/ps\` when needed. Do not wait for staged jobs serially unless the user asked for a dependency chain.
`;

const AGENT_TEMPLATE_PATH = path.join(PAI_REPO_ROOT, "agent-templates", "PROJECT_AGENT.md");
const SKILLS_ROOT = path.join(PAI_REPO_ROOT, "skills");

// Per-project settings.local.json — excludes the root dev CLAUDE.md from
// the agent's memory so the per-project session sees ONLY its own
// PROJECT_AGENT.md + CLAUDE.md wrapper. Path is absolute, derived from
// PAI_REPO_ROOT at write time, so it tracks repo moves. Always re-written
// (not idempotent) so a repo move auto-heals on next viewer boot.
function perProjectSettingsLocal() {
  return JSON.stringify(
    { claudeMdExcludes: [path.join(PAI_REPO_ROOT, "CLAUDE.md")] },
    null,
    2,
  ) + "\n";
}

export async function ensureProjectStructure(id, { agentId = "claude" } = {}) {
  const dir = projectDir(id);
  const resolvedAgentId = resolveAgentIdForMeta({ agent_id: agentId });
  // The four real asset buckets the mutator + CLIs write to. `audios/`
  // and `notes/` are also created lazily on first write, but pre-
  // creating makes a fresh project's `ls assets/` self-documenting.
  // `voices/` is dead (audio_result lands in `audios/`); `refs/` is
  // legacy (see migrate_ids.js — reference images now live in
  // `images/` with subtype="reference"); `.tmp/` is created lazily by
  // the upload route and the mutator's tmp_path rename path.
  await fsp.mkdir(path.join(dir, "assets/images"), { recursive: true });
  await fsp.mkdir(path.join(dir, "assets/videos"), { recursive: true });
  await fsp.mkdir(path.join(dir, "assets/audios"), { recursive: true });
  await fsp.mkdir(path.join(dir, "assets/notes"),  { recursive: true });

  // PROJECT_AGENT.md — canonical per-project agent operating manual, copied
  // from agent-templates/PROJECT_AGENT.md. Write-if-missing so a user who has
  // customized their copy isn't clobbered on viewer reboot.
  const projectAgentPath = path.join(dir, "PROJECT_AGENT.md");
  if (!(await fileExists(projectAgentPath))) {
    const template = await fsp.readFile(AGENT_TEMPLATE_PATH, "utf8");
    await fsp.writeFile(projectAgentPath, template);
  }

  if (resolvedAgentId === "codex") {
    await ensureCodexProjectFiles(dir);
    return;
  }

  await ensureClaudeProjectFiles(dir);
}

async function ensureClaudeProjectFiles(dir) {
  // Per-project .claude/ — was a single symlink to ../../.claude; now a
  // real dir with mixed contents so that settings.local.json can carry a
  // per-project `claudeMdExcludes` while hooks and settings.json stay
  // shared. The asymmetry is necessary because Claude Code's settings
  // discovery doesn't walk up from cwd — each project session needs its
  // own `.claude/` to be discovered at all.
  const claudeDir = path.join(dir, ".claude");
  // Legacy migration: unlink the old single-symlink shape if present.
  try {
    const st = await fsp.lstat(claudeDir);
    if (st.isSymbolicLink()) await fsp.unlink(claudeDir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fsp.mkdir(claudeDir, { recursive: true });

  // hooks/ and settings.json stay shared via symlinks back to the repo's
  // canonical .claude/. They encode repo-wide invariants (block direct
  // workflow.json writes, require background for generate_*) that are
  // identical across all projects.
  await ensureSymlink(
    path.join("..", "..", "..", ".claude", "hooks"),
    path.join(claudeDir, "hooks"),
  );
  await ensureSymlink(
    path.join("..", "..", "..", ".claude", "settings.json"),
    path.join(claudeDir, "settings.json"),
  );

  // settings.local.json is per-project. Always overwrite — its content
  // is system-generated (a single `claudeMdExcludes` derived from
  // PAI_REPO_ROOT) and must track repo moves. Not intended for user edits.
  await fsp.writeFile(
    path.join(claudeDir, "settings.local.json"),
    perProjectSettingsLocal(),
  );

  // CLAUDE.md wrapper — thin Claude-flavored shim that @imports PROJECT_AGENT.md.
  // Write-if-missing so user edits stick.
  const claudeMdPath = path.join(dir, "CLAUDE.md");
  if (!(await fileExists(claudeMdPath))) {
    await fsp.writeFile(claudeMdPath, PER_PROJECT_CLAUDE_MD);
  }
}

async function ensureCodexProjectFiles(dir) {
  const agentsPath = path.join(dir, "AGENTS.md");
  if (!(await fileExists(agentsPath))) {
    await fsp.writeFile(agentsPath, PER_PROJECT_CODEX_AGENTS_MD);
  }

  const skillDestRoot = path.join(dir, ".agents", "skills");
  await fsp.mkdir(skillDestRoot, { recursive: true });
  let entries;
  try {
    entries = await fsp.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(SKILLS_ROOT, entry.name);
    if (!(await fileExists(path.join(src, "SKILL.md")))) continue;
    await ensureSymlink(src, path.join(skillDestRoot, entry.name));
  }
}

// Idempotent symlink: succeed if a link with the right target already
// exists; replace if a different target is present; create if missing.
async function ensureSymlink(target, linkPath) {
  try {
    const existing = await fsp.readlink(linkPath);
    if (existing === target) return;
    await fsp.unlink(linkPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fsp.symlink(target, linkPath);
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function unlinkPendingSidecar(id, jobId) {
  try {
    await fsp.unlink(path.join(pendingDir(id), `${jobId}.json`));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export async function recoverPendingResults(id) {
  let entries;
  try {
    entries = await fsp.readdir(pendingDir(id), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const jobId = entry.name.slice(0, -".json".length);
    let pending;
    try {
      pending = JSON.parse(
        await fsp.readFile(path.join(pendingDir(id), entry.name), "utf8"),
      );
    } catch (e) {
      console.warn(`[viewer] pending recovery skipped unreadable ${id}/${jobId}: ${e.message}`);
      continue;
    }
    if (pending?.stage !== "running") continue;

    const existing = await readResultEntry(id, jobId);
    if (!existing) {
      await writeResult(id, jobId, {
        ok: false,
        job_id: jobId,
        kind:
          pending.kind === "video" ? "video"
          : pending.kind === "audio" ? "audio"
          : "image",
        klass: "aborted",
        message: "viewer restart",
      });
    }
    await unlinkPendingSidecar(id, jobId);
  }
}

export async function loadProject(projects, id) {
  const meta = await readMeta(id);
  if (!meta) return null;
  const canvasState = await readCanvas(id);
  const canvasPositions = await readCanvasPositions(id);
  const pendingGenerations = await readPendingDir(id);
  const generationResults = await readResultDir(id, { limit: GENERATION_RESULTS_BUNDLE_LIMIT });
  const entry = {
    id,
    meta,
    canvasState,
    canvasPositions,
    pendingGenerations,
    generationResults: new Map(generationResults.map((r) => [r.job_id, r])),
  };
  initProjectMutatorState(entry, {
    workflowPath: workflowPath(id),
    mutationLogPath: mutationLogPath(id),
  });
  // Reseed the in-process asset cache from the canvas itself —
  // workflow.json node metadata replaces the old .asset_cache.json sidecar.
  reseedFromCanvas(id, Array.isArray(canvasState?.nodes) ? canvasState.nodes : []);
  projects.set(id, entry);
  return entry;
}

export async function primeProjects(projects) {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!isValidId(e.name)) continue;
    const meta = await readMeta(e.name);
    await ensureProjectStructure(e.name, { agentId: resolveAgentIdForMeta(meta) });
    await recoverPendingResults(e.name);
    await loadProject(projects, e.name);
  }
  if (projects.size === 0) {
    const id = "scratch";
    const agentId = resolveAgentIdForNewProject();
    await ensureProjectStructure(id, { agentId });
    await fsp.writeFile(
      workflowPath(id),
      JSON.stringify({ version: 2, workflow_id: id, title: "", nodes: [], edges: [] }, null, 2) + "\n",
    );
    const now = new Date().toISOString();
    await writeMeta(id, {
      id,
      title: "Untitled project",
      created_at: now,
      last_active_at: now,
      agent_id: agentId,
      use_server_owned_generation: true,
    });
    await loadProject(projects, id);
    await writeActive(id);
  }
}
