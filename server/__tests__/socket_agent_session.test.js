import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const priorBypass = process.env.PAI_AGENT_BYPASS;
process.env.PAI_AGENT_BYPASS = "0";
test.after(() => {
  if (priorBypass === undefined) delete process.env.PAI_AGENT_BYPASS;
  else process.env.PAI_AGENT_BYPASS = priorBypass;
});

test("persistDiscoveredAgentSession writes agent_session_id from discovered payload id", async (t) => {
  const projectsDir = await mkdtemp(join(tmpdir(), "socket-agent-session-"));
  t.after(() => rm(projectsDir, { recursive: true, force: true }));
  const prior = process.env.PAI_PROJECTS_DIR;
  t.after(() => {
    if (prior === undefined) delete process.env.PAI_PROJECTS_DIR;
    else process.env.PAI_PROJECTS_DIR = prior;
  });
  process.env.PAI_PROJECTS_DIR = projectsDir;

  const projectId = "codex_project";
  await mkdir(join(projectsDir, projectId), { recursive: true });
  const project = {
    meta: {
      id: projectId,
      title: "Codex project",
      agent_id: "codex",
    },
  };

  const { persistDiscoveredAgentSession } = await import(`../services/socket.js?persist=${Date.now()}`);
  assert.equal(
    await persistDiscoveredAgentSession(projectId, project, { sessionId: "payload-session-id" }),
    true,
  );
  assert.equal(project.meta.agent_session_id, "payload-session-id");

  const persisted = JSON.parse(await readFile(join(projectsDir, projectId, "meta.json"), "utf8"));
  assert.equal(persisted.agent_session_id, "payload-session-id");

  assert.equal(
    await persistDiscoveredAgentSession(projectId, project, { sessionId: "payload-session-id" }),
    false,
  );
  assert.equal(await persistDiscoveredAgentSession(projectId, project, { sessionId: "" }), false);
});
