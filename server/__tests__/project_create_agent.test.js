import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const REPO_ROOT = resolve(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

async function freePort() {
  return 17800 + Math.floor(Math.random() * 1000);
}

/**
 * A stand-in for an agent CLI on PATH.
 *
 * The switch route probes the target binary and refuses with 409 when it is
 * missing — deliberately, so a one-click switch cannot strand a project on an
 * agent this machine cannot launch. That probe is real, so a test that wants
 * the switch to SUCCEED has to supply the binary. CI has neither CLI, which is
 * what turned these green locally and red there.
 */
async function makeFakeAgentBin(t, name) {
  const dir = await mkdtemp(join(tmpdir(), `pai-fake-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, name);
  await writeFile(bin, `#!/bin/sh\necho '${name} 9.9.9'\n`);
  await chmod(bin, 0o755);
  return dir;
}

async function startViewer({ paiDefaultAgentId, paiAgent, extraPath } = {}) {
  const projectsDir = await mkdtemp(join(tmpdir(), "project-create-agent-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    VIEWER_PORT: String(port),
    PAI_PROJECTS_DIR: projectsDir,
    PAI_ACTIVE_FILE: join(projectsDir, ".active_project"),
    PAI_ROOT_LINK: join(projectsDir, "workflow.json"),
    WEB_ORIGIN: "http://localhost:0",
  };
  if (extraPath) env.PATH = `${extraPath}${delimiter}${process.env.PATH ?? ""}`;
  // Use "" (not delete) for the unset case. The spawned viewer reloads the
  // repo .env on boot, and dotenv only fills *absent* keys — so deleting a
  // var lets a developer's local .env (e.g. PAI_DEFAULT_AGENT_ID=codex)
  // re-inject it and break these default-agent assertions. An empty string is
  // "present but unset": dotenv leaves it untouched and normalize() falls back
  // to the default agent, so the test stays hermetic regardless of local .env.
  env.PAI_AGENT = paiAgent === undefined ? "" : paiAgent;
  env.PAI_DEFAULT_AGENT_ID = paiDefaultAgentId === undefined ? "" : paiDefaultAgentId;

  const proc = spawn(process.execPath, [VIEWER_PATH], { env, stdio: ["ignore", "pipe", "pipe"] });
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return { proc, projectsDir, baseUrl };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGTERM");
  throw new Error("viewer did not start in 10s");
}

async function stopViewer(handle) {
  if (handle?.proc) {
    handle.proc.kill("SIGTERM");
    await new Promise((r) => handle.proc.once("exit", r));
  }
  if (handle?.projectsDir) {
    await rm(handle.projectsDir, { recursive: true, force: true });
  }
}

async function createProject(handle, title) {
  const r = await fetch(`${handle.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  assert.equal(r.status, 201);
  const row = await r.json();
  const { id } = row;
  const dir = join(handle.projectsDir, id);
  const raw = await readFile(join(dir, "meta.json"), "utf8");
  return { meta: JSON.parse(raw), dir, row };
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function skillNames() {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await pathExists(join(SKILLS_ROOT, entry.name, "SKILL.md"))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function assertProjectSkillLinks(dir) {
  const names = await skillNames();
  assert.ok(names.length > 0);
  assert.ok(names.includes("story-to-video-workflow"));
  for (const name of names) {
    const link = join(dir, ".agents", "skills", name);
    const stat = await lstat(link);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(await readlink(link), join(SKILLS_ROOT, name));
    assert.equal(await pathExists(join(link, "SKILL.md")), true);
  }
}

test("POST /projects stores codex agent_id when PAI_DEFAULT_AGENT_ID is unset", async () => {
  // The scaffolding assertions are the point, not the label: a project created
  // on the default must come out with the files THAT agent actually reads.
  // Getting the id right while writing the other agent's files is the failure
  // this guards.
  const handle = await startViewer();
  try {
    const { meta, dir, row } = await createProject(handle, "Agent Default");
    assert.equal(meta.agent_id, "codex");
    assert.equal(row.agent_id, "codex");
    assert.equal(row.agent_label, "Codex");
    const bundle = await (await fetch(`${handle.baseUrl}/projects/${row.id}`)).json();
    assert.equal(bundle.agent_id, "codex");
    assert.equal(bundle.agent_label, "Codex");
    assert.equal(await pathExists(join(dir, "PROJECT_AGENT.md")), true);
    assert.equal(await pathExists(join(dir, "AGENTS.md")), true);
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), false);
    await assertProjectSkillLinks(dir);
  } finally {
    await stopViewer(handle);
  }
});

test("POST /projects ignores unsupported PAI_AGENT alias", async () => {
  // PAI_AGENT was never the variable this reads. Setting it must change
  // nothing, which now means landing on the new-project default rather than
  // on the value it names.
  const handle = await startViewer({ paiAgent: "codex" });
  try {
    const { meta, row } = await createProject(handle, "Agent Legacy Alias");
    assert.equal(meta.agent_id, "codex");
    assert.equal(row.agent_id, "codex");
    assert.equal(row.agent_label, "Codex");
  } finally {
    await stopViewer(handle);
  }
});

test("POST /projects stores codex agent_id when PAI_DEFAULT_AGENT_ID=codex", async () => {
  const handle = await startViewer({ paiDefaultAgentId: "codex" });
  try {
    const { meta, dir, row } = await createProject(handle, "Agent Codex");
    assert.equal(meta.agent_id, "codex");
    assert.equal(row.agent_id, "codex");
    assert.equal(row.agent_label, "Codex");
    const bundle = await (await fetch(`${handle.baseUrl}/projects/${row.id}`)).json();
    assert.equal(bundle.agent_id, "codex");
    assert.equal(bundle.agent_label, "Codex");
    assert.equal(await pathExists(join(dir, "PROJECT_AGENT.md")), true);
    const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.match(agentsMd, /Read `\.\/PROJECT_AGENT\.md`/);
    assert.match(agentsMd, /Classify the user's request into exactly one primary route/);
    assert.match(agentsMd, /story-to-video-workflow\/SKILL\.md/);
    assert.match(agentsMd, /Codex does not get Claude's automatic project-agent import/);
    assert.match(agentsMd, /generate_image_pro\.js/);
    assert.match(agentsMd, /--draft-only/);
    assert.match(agentsMd, /wait_for_generations\.js/);
    assert.doesNotMatch(agentsMd, /@\.\/PROJECT_AGENT\.md/);
    assert.doesNotMatch(agentsMd, /\[task-notification\]/);
    assert.match(agentsMd, /Do not use Codex background command execution/);
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), false);
    assert.equal(await pathExists(join(dir, ".claude")), false);
    await assertProjectSkillLinks(dir);
  } finally {
    await stopViewer(handle);
  }
});

// ── switching an existing project ──────────────────────────────────────
//
// The agent used to be fixed at creation, readable only by editing meta.json
// and restarting the viewer. PATCH makes it a runtime choice, which means the
// project has to end up with the incoming agent's scaffolding AND lose the
// outgoing agent's session pointer — a stale pointer makes the Home list claim
// a saved conversation the new agent has never seen.

async function patchAgent(handle, projectId, agentId) {
  const res = await fetch(`${handle.baseUrl}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("PATCH agent_id moves the project and lays down the new agent's files", async (t) => {
  const handle = await startViewer({ extraPath: await makeFakeAgentBin(t, "claude") });
  try {
    const { meta, dir, row } = await createProject(handle, "Agent Switch");
    assert.equal(meta.agent_id, "codex");
    assert.equal(await pathExists(join(dir, "AGENTS.md")), true);
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), false);

    const { status } = await patchAgent(handle, row.id, "claude");
    assert.equal(status, 200);

    const bundle = await (await fetch(`${handle.baseUrl}/projects/${row.id}`)).json();
    assert.equal(bundle.agent_id, "claude");
    assert.equal(bundle.agent_label, "Claude");
    // The incoming agent can only run if its own files are there.
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), true);
    assert.equal(await pathExists(join(dir, ".claude", "settings.local.json")), true);
    // The outgoing agent's files are left alone: switching back must not have
    // to rebuild them, and a customized copy is the user's.
    assert.equal(await pathExists(join(dir, "AGENTS.md")), true);
    await assertProjectSkillLinks(dir);
  } finally {
    await stopViewer(handle);
  }
});

test("PATCH agent_id drops the previous agent's session pointer", async (t) => {
  const handle = await startViewer({ extraPath: await makeFakeAgentBin(t, "claude") });
  try {
    const { dir, row } = await createProject(handle, "Agent Switch Session");
    // Stand in for a session the departing agent had discovered and persisted.
    const metaPath = join(dir, "meta.json");
    const before = JSON.parse(await readFile(metaPath, "utf8"));
    before.agent_session_id = "0199c4f2-aaaa-bbbb-cccc-ddddeeeeffff";
    await writeFile(metaPath, JSON.stringify(before, null, 2));

    await patchAgent(handle, row.id, "claude");

    const after = JSON.parse(await readFile(metaPath, "utf8"));
    assert.equal(after.agent_id, "claude");
    assert.equal(
      Object.hasOwn(after, "agent_session_id"),
      false,
      "the pointer belongs to the agent that just stopped — carrying it over " +
        "makes the project list advertise a conversation the new agent has never seen",
    );
  } finally {
    await stopViewer(handle);
  }
});

test("PATCH agent_id rejects an id we do not ship, and is a no-op for the current one", async () => {
  const handle = await startViewer();
  try {
    const { row } = await createProject(handle, "Agent Switch Guards");

    const bad = await patchAgent(handle, row.id, "gemini");
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /agent_id must be one of/);

    // Re-selecting the current agent must not kill the pty or rewrite meta.
    const same = await patchAgent(handle, row.id, "codex");
    assert.equal(same.status, 200);
    const bundle = await (await fetch(`${handle.baseUrl}/projects/${row.id}`)).json();
    assert.equal(bundle.agent_id, "codex");
  } finally {
    await stopViewer(handle);
  }
});
