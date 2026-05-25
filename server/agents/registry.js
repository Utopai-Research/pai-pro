import { claudeProvider } from "./claude.js";

export const DEFAULT_AGENT_ID = "claude";
export const SUPPORTED_AGENT_IDS = new Set(["claude", "codex"]);

const providers = new Map([
  [claudeProvider.id, claudeProvider],
]);

export function resolveAgentIdForNewProject(env = process.env) {
  const raw = (env.PAI_AGENT ?? "").trim().toLowerCase();
  return SUPPORTED_AGENT_IDS.has(raw) ? raw : DEFAULT_AGENT_ID;
}

export function resolveAgentIdForMeta(meta) {
  const raw = typeof meta?.agent_id === "string" ? meta.agent_id.trim().toLowerCase() : "";
  return SUPPORTED_AGENT_IDS.has(raw) ? raw : DEFAULT_AGENT_ID;
}

export function getProvider(agentId) {
  return providers.get(agentId) ?? null;
}

export function listProviders() {
  return Array.from(providers.values());
}
