import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

const DEFAULT_AGENT_ID = "claude";

const providers = new Map([
  [claudeProvider.id, claudeProvider],
  [codexProvider.id, codexProvider],
]);

function normalize(raw) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return providers.has(v) ? v : DEFAULT_AGENT_ID;
}

export function resolveAgentIdForNewProject(env = process.env) {
  return normalize(env.PAI_DEFAULT_AGENT_ID);
}

export function resolveAgentIdForMeta(meta) {
  return normalize(meta?.agent_id);
}

export function getProvider(agentId) {
  return providers.get(agentId) ?? null;
}
