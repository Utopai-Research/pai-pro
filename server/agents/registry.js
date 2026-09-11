import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

// 🔴 TWO defaults, and they are not interchangeable.
//
// DEFAULT_AGENT_ID answers "this project's meta does not say which agent owns
// it — which one does?". The only projects in that state predate the field, so
// they were created when Claude was the sole option and have `CLAUDE.md` and
// `.claude/` on disk. Answering anything else hands them scaffolding that does
// not match their own files.
//
// DEFAULT_NEW_PROJECT_AGENT_ID answers a different question: "nobody said what
// the next project should use — what do we pick?". That is a product choice and
// it is free to change, because a new project gets whatever scaffolding the
// answer implies.
//
// Collapsing these into one constant is the tempting bug: flipping it to codex
// silently reassigns every legacy project too.
const DEFAULT_AGENT_ID = "claude";
const DEFAULT_NEW_PROJECT_AGENT_ID = "codex";

const providers = new Map([
  [claudeProvider.id, claudeProvider],
  [codexProvider.id, codexProvider],
]);

function normalize(raw, fallback = DEFAULT_AGENT_ID) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return providers.has(v) ? v : fallback;
}

export function resolveAgentIdForNewProject(env = process.env) {
  return normalize(env.PAI_DEFAULT_AGENT_ID, DEFAULT_NEW_PROJECT_AGENT_ID);
}

/** The id a new project gets when nothing overrides it. Rendered in the UI. */
export function defaultAgentIdForNewProject() {
  return DEFAULT_NEW_PROJECT_AGENT_ID;
}

export function resolveAgentIdForMeta(meta) {
  return normalize(meta?.agent_id);
}

export function getProvider(agentId) {
  return providers.get(agentId) ?? null;
}

export function listProviders() {
  return Array.from(providers.values());
}
