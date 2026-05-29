import test from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  resolveAgentIdForMeta,
  resolveAgentIdForNewProject,
} from "../agents/index.js";
import { resolveAgentBypass } from "../agents/bypass.js";
import {
  buildClaudeContinuationCommand,
  parseClaudeContinuationOutput,
} from "../agents/claude.js";
import {
  buildCodexContinuationCommand,
  parseCodexContinuationOutput,
} from "../agents/codex.js";

// Disables the default-on permission bypass so a test can assert the
// model/effort/sandbox mapping in isolation.
const NO_BYPASS = { PAI_AGENT_BYPASS: "0" };

test("resolveAgentIdForNewProject defaults to claude", () => {
  assert.equal(resolveAgentIdForNewProject({}), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: undefined }), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: "" }), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: "gemini" }), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: "codex" }), "claude");
});

test("resolveAgentIdForNewProject accepts codex case-insensitively", () => {
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: "codex" }), "codex");
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: "CODEX" }), "codex");
  assert.equal(resolveAgentIdForNewProject({ PAI_DEFAULT_AGENT_ID: " Codex " }), "codex");
});

test("resolveAgentIdForMeta treats old or unknown metadata as claude", () => {
  assert.equal(resolveAgentIdForMeta({}), "claude");
  assert.equal(resolveAgentIdForMeta({ claude_model: "opus" }), "claude");
  assert.equal(resolveAgentIdForMeta({ agent_id: "gemini" }), "claude");
});

test("resolveAgentIdForMeta accepts codex", () => {
  assert.equal(resolveAgentIdForMeta({ agent_id: "codex" }), "codex");
  assert.equal(resolveAgentIdForMeta({ agent_id: "CODEX" }), "codex");
});

test("provider registry exposes claude and codex with labels", () => {
  assert.equal(getProvider("claude")?.id, "claude");
  assert.equal(getProvider("claude")?.label, "Claude");
  assert.equal(getProvider("codex")?.id, "codex");
  assert.equal(getProvider("codex")?.label, "Codex");
});

test("claude provider builds launch and resume commands with defaults", () => {
  const provider = getProvider("claude");
  assert.equal(
    provider.buildLaunchCommand({ meta: {}, env: {} }),
    "claude --dangerously-skip-permissions --model sonnet --effort max\r",
  );
  assert.equal(
    provider.buildResumeCommand({ meta: {}, env: {} }),
    "claude --continue --dangerously-skip-permissions --model sonnet --effort max\r",
  );
});

test("claude provider drops the bypass flag when PAI_AGENT_BYPASS is off", () => {
  const provider = getProvider("claude");
  assert.equal(
    provider.buildLaunchCommand({ meta: {}, env: NO_BYPASS }),
    "claude --model sonnet --effort max\r",
  );
  assert.equal(
    provider.buildResumeCommand({ meta: {}, env: NO_BYPASS }),
    "claude --continue --model sonnet --effort max\r",
  );
});

test("claude provider prefers agent overrides, then claude compat overrides", () => {
  const provider = getProvider("claude");
  assert.equal(
    provider.buildLaunchCommand({ meta: { agent_model: "opus", agent_effort: "xhigh" }, env: NO_BYPASS }),
    "claude --model opus --effort xhigh\r",
  );
  assert.equal(
    provider.buildLaunchCommand({ meta: { claude_model: "haiku", claude_effort: "low" }, env: NO_BYPASS }),
    "claude --model haiku --effort low\r",
  );
  assert.equal(
    provider.buildLaunchCommand({
      meta: {
        agent_model: "bad value",
        claude_model: "opus",
        agent_effort: "also bad",
        claude_effort: "medium",
      },
      env: NO_BYPASS,
    }),
    "claude --model opus --effort medium\r",
  );
});

test("claude provider filters Claude and Anthropic auth env vars", () => {
  const provider = getProvider("claude");
  assert.deepEqual(
    provider.filterEnv({
      ANTHROPIC_API_KEY: "a",
      ANTHROPIC_AUTH_TOKEN: "b",
      CLAUDE_API_KEY: "c",
      FOO: "ok",
    }),
    { FOO: "ok" },
  );
});

test("codex provider builds launch and resume commands with defaults", () => {
  const provider = getProvider("codex");
  assert.equal(
    provider.buildLaunchCommand({ meta: {}, env: {} }),
    "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox\r",
  );
  assert.equal(
    provider.buildResumeCommand({ meta: {}, env: {} }),
    "codex resume --last --no-alt-screen --dangerously-bypass-approvals-and-sandbox\r",
  );
});

test("codex provider drops the bypass flag when PAI_AGENT_BYPASS is off", () => {
  const provider = getProvider("codex");
  assert.equal(provider.buildLaunchCommand({ meta: {}, env: NO_BYPASS }), "codex --no-alt-screen\r");
  assert.equal(
    provider.buildResumeCommand({ meta: {}, env: NO_BYPASS }),
    "codex resume --last --no-alt-screen\r",
  );
});

test("codex bypass suppresses sandbox and approval (codex refuses them together)", () => {
  const provider = getProvider("codex");
  assert.equal(
    provider.buildLaunchCommand({
      meta: {
        agent_model: "gpt-5.1-codex/max",
        agent_effort: "high",
        agent_sandbox: "workspace-write",
        agent_approval_mode: "on-request",
      },
      env: {},
    }),
    'codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox --model gpt-5.1-codex/max -c model_reasoning_effort="high"\r',
  );
});

test("codex provider maps safe agent options to CLI flags", () => {
  const provider = getProvider("codex");
  assert.equal(
    provider.buildLaunchCommand({
      meta: {
        agent_model: "gpt-5.1-codex/max",
        agent_effort: "high",
        agent_sandbox: "workspace-write",
        agent_approval_mode: "on-request",
      },
      env: NO_BYPASS,
    }),
    'codex --no-alt-screen --model gpt-5.1-codex/max -c model_reasoning_effort="high" --sandbox workspace-write --ask-for-approval on-request\r',
  );
});

test("codex provider ignores invalid agent options", () => {
  const provider = getProvider("codex");
  assert.equal(
    provider.buildLaunchCommand({
      meta: {
        agent_model: "bad value",
        agent_effort: "extreme",
        agent_sandbox: "workspace-write;rm",
        agent_approval_mode: "on-failure",
      },
      env: NO_BYPASS,
    }),
    "codex --no-alt-screen\r",
  );
});

test("codex provider leaves env vars intact", () => {
  const provider = getProvider("codex");
  assert.deepEqual(
    provider.filterEnv({
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      FOO: "ok",
    }),
    {
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      FOO: "ok",
    },
  );
});

test("resolveAgentBypass defaults on and only falsy strings disable it", () => {
  assert.equal(resolveAgentBypass({}), true);
  assert.equal(resolveAgentBypass({ PAI_AGENT_BYPASS: "" }), true);
  assert.equal(resolveAgentBypass({ PAI_AGENT_BYPASS: "1" }), true);
  assert.equal(resolveAgentBypass({ PAI_AGENT_BYPASS: "true" }), true);
  for (const off of ["0", "false", "no", "off", "OFF", " Off "]) {
    assert.equal(resolveAgentBypass({ PAI_AGENT_BYPASS: off }), false, off);
  }
});

test("claude continuation command is non-interactive and capped", () => {
  const schema = { type: "object" };
  const built = buildClaudeContinuationCommand({
    meta: { agent_model: "sonnet", agent_effort: "high" },
    schema,
    env: { PAI_CONTINUATION_MAX_BUDGET_USD: "0.12" },
  });
  assert.equal(built.command, "claude");
  assert.deepEqual(built.args.slice(0, 7), [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--allowedTools", "",
  ]);
  assert.ok(built.args.includes("--no-session-persistence"));
  assert.ok(built.args.includes("--max-budget-usd"));
  assert.ok(built.args.includes("0.12"));
  assert.ok(built.args.includes("--model"));
  assert.ok(built.args.includes("sonnet"));
});

test("claude continuation parser extracts structured_output wrapper", () => {
  const parsed = parseClaudeContinuationOutput(JSON.stringify({
    type: "result",
    total_cost_usd: 0.01,
    structured_output: {
      summary: "Done",
      diagnostics: [],
      suggested_next_steps: [{ kind: "none" }],
    },
  }));
  assert.equal(parsed.output.summary, "Done");
  assert.equal(parsed.raw_provider.total_cost_usd, 0.01);
});

test("codex continuation command uses exec json schema and read-only sandbox", () => {
  const built = buildCodexContinuationCommand({
    meta: { agent_model: "gpt-5.3-codex", agent_effort: "high" },
    schemaPath: "/tmp/schema.json",
    lastMessagePath: "/tmp/last.json",
    workdir: "/tmp/work",
  });
  assert.equal(built.command, "codex");
  assert.deepEqual(built.args.slice(0, 10), [
    "exec",
    "--json",
    "--output-schema", "/tmp/schema.json",
    "--output-last-message", "/tmp/last.json",
    "--cd", "/tmp/work",
    "--sandbox", "read-only",
  ]);
  assert.ok(built.args.includes("--ephemeral"));
  assert.ok(built.args.includes("--ignore-rules"));
  assert.ok(built.args.includes("--skip-git-repo-check"));
  assert.ok(built.args.includes("-"));
});

test("codex continuation parser prefers output-last-message", () => {
  const parsed = parseCodexContinuationOutput({
    stdout: JSON.stringify({ type: "ignored", message: "not json" }) + "\n",
    lastMessage: JSON.stringify({
      summary: "Codex done",
      diagnostics: [],
      suggested_next_steps: [{ kind: "none" }],
    }),
  });
  assert.equal(parsed.output.summary, "Codex done");
  assert.equal(parsed.raw_provider.source, "output-last-message");
});
