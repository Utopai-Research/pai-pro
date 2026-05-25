import { exec } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectDir } from "../lib/paths.js";

const execAsync = promisify(exec);
const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

function safeCliValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}

function claudeSessionDir(projectId) {
  return path.join(CLAUDE_PROJECTS_ROOT, projectDir(projectId).replace(/[/_.]/g, "-"));
}

function flagsSuffix(meta = {}) {
  const model =
    safeCliValue(meta.agent_model) ? meta.agent_model
    : safeCliValue(meta.claude_model) ? meta.claude_model
    : "sonnet";
  const effort =
    safeCliValue(meta.agent_effort) ? meta.agent_effort
    : safeCliValue(meta.claude_effort) ? meta.claude_effort
    : "max";
  return ` --model ${model} --effort ${effort}`;
}

async function binaryOk(name) {
  try {
    await execAsync(`command -v ${name}`);
    return true;
  } catch {
    return false;
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

async function parseHistory(session) {
  const raw = await fsp.readFile(session.path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (obj.isSidechain) continue;
    const msg = obj.message;
    if (!msg) continue;

    let text = "";
    const toolUses = [];
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const c of msg.content) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c.type === "tool_use") toolUses.push({ name: c.name, input: c.input });
      }
      text = parts.join("\n").trim();
    }

    text = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
      .trim();

    if (!text && toolUses.length === 0) continue;
    out.push({
      role: obj.type,
      text,
      toolUses,
      timestamp: obj.timestamp ?? null,
      uuid: obj.uuid ?? null,
    });
  }
  return out;
}

export const claudeProvider = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",

  buildLaunchCommand({ meta } = {}) {
    return `claude${flagsSuffix(meta)}\r`;
  },

  buildResumeCommand({ meta } = {}) {
    return `claude --continue${flagsSuffix(meta)}\r`;
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
  parseHistory,

  async healthCheck() {
    const binary = await binaryOk("claude");
    return { ok: binary, binary };
  },
};
