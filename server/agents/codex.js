import { exec } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectDir } from "../lib/paths.js";
import { resolveAgentBypass } from "./bypass.js";

const execAsync = promisify(exec);
const CODEX_SESSION_ORIGINATOR = "codex-tui";
const DEFAULT_MAX_DATE_DIRS = 30;
const DEFAULT_MAX_FILES = 500;
const READ_CHUNK_BYTES = 64 * 1024;

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const SANDBOX_VALUES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_VALUES = new Set(["untrusted", "on-request", "never"]);

function safeModelValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value);
}

function safeSetValue(value, allowed) {
  return typeof value === "string" && allowed.has(value);
}

function codexSessionsRoot(env = process.env) {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() !== ""
      ? env.CODEX_HOME.trim()
      : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function optionSuffix(meta = {}, env) {
  const bypass = resolveAgentBypass(env);
  const parts = ["--no-alt-screen"];
  if (bypass) {
    parts.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (safeModelValue(meta.agent_model)) {
    parts.push("--model", meta.agent_model);
  }
  if (safeSetValue(meta.agent_effort, EFFORT_VALUES)) {
    parts.push("-c", `model_reasoning_effort="${meta.agent_effort}"`);
  }
  // The bypass flag subsumes sandbox + approval, and codex refuses to start
  // when either is passed alongside it. Only emit the explicit policies when
  // the bypass is off.
  if (!bypass && safeSetValue(meta.agent_sandbox, SANDBOX_VALUES)) {
    parts.push("--sandbox", meta.agent_sandbox);
  }
  if (!bypass && safeSetValue(meta.agent_approval_mode, APPROVAL_VALUES)) {
    parts.push("--ask-for-approval", meta.agent_approval_mode);
  }
  return parts.join(" ");
}

async function binaryOk(name) {
  try {
    await execAsync(`command -v ${name}`);
    return true;
  } catch {
    return false;
  }
}

async function normalizePathForCompare(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return null;
  const resolved = path.resolve(rawPath);
  try {
    return await fsp.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function readSessionMeta(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, 0);
    const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
        return parsed.payload;
      }
    }
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch {}
  }
  return null;
}

async function readSortedDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

async function sortedJsonlFiles(dayDir) {
  const entries = await fsp.readdir(dayDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dayDir, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

async function newestDateDirs(root, maxDateDirs) {
  const out = [];
  let years;
  try {
    years = await readSortedDirs(root);
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const year of years) {
    const yearDir = path.join(root, year);
    const months = await readSortedDirs(yearDir);
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const days = await readSortedDirs(monthDir);
      for (const day of days) {
        out.push(path.join(monthDir, day));
        if (out.length >= maxDateDirs) return out;
      }
    }
  }
  return out;
}

export async function findLatestCodexSession(
  projectId,
  {
    sessionsRoot = codexSessionsRoot(),
    projectPath = projectDir(projectId),
    maxDateDirs = DEFAULT_MAX_DATE_DIRS,
    maxFiles = DEFAULT_MAX_FILES,
  } = {},
) {
  const projectCwd = await normalizePathForCompare(projectPath);
  if (!projectCwd) return null;

  const dateDirs = await newestDateDirs(sessionsRoot, maxDateDirs);
  let scannedFiles = 0;
  for (const dayDir of dateDirs) {
    const files = await sortedJsonlFiles(dayDir);
    for (const filePath of files) {
      if (scannedFiles >= maxFiles) return null;
      scannedFiles += 1;
      const payload = await readSessionMeta(filePath);
      if (!payload) continue;
      if (payload.originator !== CODEX_SESSION_ORIGINATOR) continue;
      const sessionCwd = await normalizePathForCompare(payload.cwd);
      if (sessionCwd !== projectCwd) continue;
      let mtime = null;
      try {
        mtime = (await fsp.stat(filePath)).mtimeMs;
      } catch {
        // Race during session cleanup; keep the usable payload.
      }
      return {
        sessionId: typeof payload.id === "string" ? payload.id : null,
        path: filePath,
        mtime,
      };
    }
  }
  return null;
}

export const codexProvider = {
  id: "codex",
  label: "Codex",

  buildLaunchCommand({ meta, env } = {}) {
    return `codex ${optionSuffix(meta, env)}\r`;
  },

  buildResumeCommand({ meta, env } = {}) {
    return `codex resume --last ${optionSuffix(meta, env)}\r`;
  },

  filterEnv(env) {
    return { ...env };
  },

  findLatestSession(projectId) {
    return findLatestCodexSession(projectId);
  },

  healthCheck() {
    return binaryOk("codex");
  },
};
