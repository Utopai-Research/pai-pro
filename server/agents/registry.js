import { claudeProvider } from "./claude.js";

const DEFAULT_AGENT_ID = "claude";
const SUPPORTED_AGENT_IDS = new Set(["claude", "codex"]);

const providers = new Map([
  [claudeProvider.id, claudeProvider],
]);

function normalize(raw) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SUPPORTED_AGENT_IDS.has(v) ? v : DEFAULT_AGENT_ID;
}

export function resolveAgentIdForNewProject(env = process.env) {
  return normalize(env.PAI_AGENT);
}

export function resolveAgentIdForMeta(meta) {
  return normalize(meta?.agent_id);
}

export function getProvider(agentId) {
  return providers.get(agentId) ?? null;
}
