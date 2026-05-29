// Whether spawned project agents launch with their permission/sandbox
// guardrails bypassed. ON by default: these agents run in the project's own
// cwd (inside the Docker runtime that externally sandboxes them) and need to
// edit project files and run the media CLIs without prompting. Set
// PAI_AGENT_BYPASS to a falsy value to restore the normal prompts — drops
// `claude --dangerously-skip-permissions` and
// `codex --dangerously-bypass-approvals-and-sandbox` from the launch command.
const FALSY = new Set(["0", "false", "no", "off"]);

export function resolveAgentBypass(env = process.env) {
  const raw =
    typeof env?.PAI_AGENT_BYPASS === "string" ? env.PAI_AGENT_BYPASS.trim().toLowerCase() : "";
  return !FALSY.has(raw);
}
