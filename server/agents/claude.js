import { exec } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectDir } from "../lib/paths.js";
import { resolveAgentBypass } from "./bypass.js";

const execAsync = promisify(exec);
const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

function safeCliValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}

function claudeSessionDir(projectId) {
  return path.join(CLAUDE_PROJECTS_ROOT, projectDir(projectId).replace(/[/_.]/g, "-"));
}

function flagsSuffix(meta = {}, env) {
  const model =
    safeCliValue(meta.agent_model) ? meta.agent_model
    : safeCliValue(meta.claude_model) ? meta.claude_model
    : "sonnet";
  const effort =
    safeCliValue(meta.agent_effort) ? meta.agent_effort
    : safeCliValue(meta.claude_effort) ? meta.claude_effort
    : "max";
  const bypass = resolveAgentBypass(env) ? "--dangerously-skip-permissions " : "";
  return `${bypass}--model ${model} --effort ${effort}`;
}

async function binaryOk(name) {
  try {
    await execAsync(`command -v ${name}`);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitAgentNotification({ text, write, waitForOutput, phaseGapMs = 500 } = {}) {
  if (typeof write !== "function") return { ok: false, reason: "write_failed" };
  const body = typeof text === "string" ? text.replace(/\r+$/g, "") : "";
  if (body.length === 0) return { ok: false, reason: "empty_input" };
  try {
    write(body);
    await sleep(Math.max(0, Number(phaseGapMs) || 0));
    write("\r");
    if (typeof waitForOutput === "function") {
      const confirmed = await waitForOutput({ timeoutMs: 2000 });
      if (!confirmed) {
        return { ok: false, reason: "unconfirmed_submit", message: "no agent output after submit" };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "write_failed", message: e.message };
  }
}

async function findLatestSession(projectId) {
  const dir = claudeSessionDir(projectId);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, e.name);
    try {
      const stat = await fsp.stat(full);
      candidates.push({
        path: full,
        sessionId: e.name.replace(/\.jsonl$/, ""),
        mtime: stat.mtimeMs,
      });
    } catch {
      // Race during session cleanup; ignore and keep scanning.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

function claudeConfigFile(env) {
  const base =
    typeof env?.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim() !== ""
      ? env.CLAUDE_CONFIG_DIR.trim()
      : os.homedir();
  return path.join(base, ".claude.json");
}

// Pre-accept the workspace-trust dialog for a project so `claude` launches to
// a ready prompt instead of "do you trust this folder?". Isolating
// CLAUDE_CONFIG_DIR logs claude out, so this edits the real ~/.claude.json:
// additively, skip-once-trusted, and atomically (claude keeps its own
// backups/). Gated by the same PAI_AGENT_BYPASS switch as the launch flags.
async function ensureClaudeTrust(projectDir, env = process.env) {
  let abs;
  try { abs = await fsp.realpath(projectDir); }
  catch { abs = path.resolve(projectDir); }

  const file = claudeConfigFile(env);
  let cfg = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") cfg = parsed;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  const entry = projects[abs] && typeof projects[abs] === "object" ? projects[abs] : {};
  if (entry.hasTrustDialogAccepted === true && entry.hasCompletedProjectOnboarding === true) {
    return; // already trusted — don't rewrite the shared file
  }

  projects[abs] = { ...entry, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  cfg.projects = projects;

  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.pai-${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n");
  await fsp.rename(tmp, file);
}

export const claudeProvider = {
  id: "claude",
  label: "Claude",

  buildLaunchCommand({ meta, env } = {}) {
    return `claude ${flagsSuffix(meta, env)}\r`;
  },

  buildResumeCommand({ meta, env } = {}) {
    return `claude --continue ${flagsSuffix(meta, env)}\r`;
  },

  filterEnv(env) {
    const {
      ANTHROPIC_API_KEY: _a,
      ANTHROPIC_AUTH_TOKEN: _b,
      CLAUDE_API_KEY: _c,
      ...passthroughEnv
    } = env;
    return passthroughEnv;
  },

  findLatestSession,

  ensureTrust: ensureClaudeTrust,

  submitAgentNotification,

  healthCheck() {
    return binaryOk("claude");
  },
};
