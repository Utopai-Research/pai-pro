import test from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  resolveAgentIdForMeta,
  resolveAgentIdForNewProject,
} from "../agents/index.js";

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
  assert.equal(provider.buildLaunchCommand({ meta: {} }), "claude --model sonnet --effort max\r");
  assert.equal(
    provider.buildResumeCommand({ meta: {} }),
    "claude --continue --model sonnet --effort max\r",
  );
});

test("claude provider prefers agent overrides, then claude compat overrides", () => {
  const provider = getProvider("claude");
  assert.equal(
    provider.buildLaunchCommand({ meta: { agent_model: "opus", agent_effort: "xhigh" } }),
    "claude --model opus --effort xhigh\r",
  );
  assert.equal(
    provider.buildLaunchCommand({ meta: { claude_model: "haiku", claude_effort: "low" } }),
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
  assert.equal(provider.buildLaunchCommand({ meta: {} }), "codex --no-alt-screen\r");
  assert.equal(
    provider.buildResumeCommand({ meta: {} }),
    "codex resume --last --no-alt-screen\r",
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
