import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import express from "express";

import { registerSystemRoutes, rowFor } from "../routes/system.js";

async function startSystemRoutes(t, healthChecks) {
  const app = express();
  registerSystemRoutes({
    app,
    projects: new Map(),
    nodePty: true,
    healthChecks,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function mockHealthChecks({ claudeCli, codexCli }) {
  return {
    binaryOk: async (name) => name === "ffmpeg" || name === "pdftotext",
    canWrite: async () => true,
    claudeCli: async () => claudeCli,
    codexCli: async () => codexCli,
  };
}

test("rowFor includes agent metadata and preserves saved semantics", () => {
  const oldProject = rowFor({ id: "old", title: "Old project" }, {});
  assert.equal(oldProject.agent_id, "claude");
  assert.equal(oldProject.agent_label, "Claude");
  assert.equal(oldProject.saved, false);

  const codexProject = rowFor({
    id: "codex",
    title: "Codex project",
    agent_id: "codex",
    agent_session_id: "session-payload-id",
  }, {});
  assert.equal(codexProject.agent_id, "codex");
  assert.equal(codexProject.agent_label, "Codex");
  assert.equal(codexProject.saved, true);

  const legacyClaudeProject = rowFor({
    id: "legacy",
    title: "Legacy Claude project",
    claude_session_id: "legacy-session",
  }, {});
  assert.equal(legacyClaudeProject.agent_id, "claude");
  assert.equal(legacyClaudeProject.saved, true);
});

test("/healthz still fails when claude_cli is unavailable", async (t) => {
  const baseUrl = await startSystemRoutes(t, mockHealthChecks({
    claudeCli: false,
    codexCli: true,
  }));

  const res = await fetch(`${baseUrl}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.claude_cli, false);
  assert.equal(body.agents.claude.binary, false);
  assert.equal(body.agents.codex.binary, true);
  assert.equal(Object.hasOwn(body.checks, "agents"), false);
});

test("/healthz reports codex availability without gating ok", async (t) => {
  const baseUrl = await startSystemRoutes(t, mockHealthChecks({
    claudeCli: true,
    codexCli: false,
  }));

  const res = await fetch(`${baseUrl}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.claude_cli, true);
  assert.equal(body.agents.codex.binary, false);
  assert.equal(Object.hasOwn(body.checks, "agents"), false);
});
