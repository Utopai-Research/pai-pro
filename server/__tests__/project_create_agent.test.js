import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const REPO_ROOT = resolve(__dirname, "..", "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

async function freePort() {
  return 17800 + Math.floor(Math.random() * 1000);
}

async function startViewer({ paiDefaultAgentId } = {}) {
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
  delete env.PAI_AGENT;
  if (paiDefaultAgentId === undefined) delete env.PAI_DEFAULT_AGENT_ID;
  else env.PAI_DEFAULT_AGENT_ID = paiDefaultAgentId;

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

test("POST /projects stores claude agent_id when PAI_DEFAULT_AGENT_ID is unset", async () => {
  const handle = await startViewer();
  try {
    const { meta, dir, row } = await createProject(handle, "Agent Default");
    assert.equal(meta.agent_id, "claude");
    assert.equal(row.agent_id, "claude");
    assert.equal(row.agent_label, "Claude");
    const bundle = await (await fetch(`${handle.baseUrl}/projects/${row.id}`)).json();
    assert.equal(bundle.agent_id, "claude");
    assert.equal(bundle.agent_label, "Claude");
    assert.equal(meta.use_server_owned_generation, true);
    assert.equal(await pathExists(join(dir, "PROJECT_AGENT.md")), true);
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), true);
    const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
    assert.match(claudeMd, /--stage/);
    assert.match(claudeMd, /run_in_background: true/);
    assert.match(claudeMd, /BashOutput/);
    assert.equal(await pathExists(join(dir, ".claude", "settings.local.json")), true);
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
    assert.match(agentsMd, /read `\.\/PROJECT_AGENT\.md`/);
    assert.doesNotMatch(agentsMd, /@\.\/PROJECT_AGENT\.md/);
    assert.equal(await pathExists(join(dir, "CLAUDE.md")), false);
    assert.equal(await pathExists(join(dir, ".claude")), false);

    const names = await skillNames();
    assert.ok(names.length > 0);
    for (const name of names) {
      const link = join(dir, ".agents", "skills", name);
      const stat = await lstat(link);
      assert.equal(stat.isSymbolicLink(), true);
      assert.equal(await readlink(link), join(SKILLS_ROOT, name));
      assert.equal(await pathExists(join(link, "SKILL.md")), true);
    }
  } finally {
    await stopViewer(handle);
  }
});
