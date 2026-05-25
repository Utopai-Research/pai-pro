import test from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  resolveAgentIdForMeta,
  resolveAgentIdForNewProject,
} from "../agents/index.js";

test("resolveAgentIdForNewProject defaults to claude", () => {
  assert.equal(resolveAgentIdForNewProject({}), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: undefined }), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: "" }), "claude");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: "gemini" }), "claude");
});

test("resolveAgentIdForNewProject accepts codex case-insensitively", () => {
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: "codex" }), "codex");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: "CODEX" }), "codex");
  assert.equal(resolveAgentIdForNewProject({ PAI_AGENT: " Codex " }), "codex");
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

test("provider registry exposes claude and leaves codex unimplemented in PR1", () => {
  assert.equal(getProvider("claude")?.id, "claude");
  assert.equal(getProvider("codex"), null);
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
