import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");

async function freePort() {
  return 17800 + Math.floor(Math.random() * 1000);
}

async function startViewer({ paiAgent } = {}) {
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
  if (paiAgent === undefined) delete env.PAI_AGENT;
  else env.PAI_AGENT = paiAgent;

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

async function createProjectAndReadMeta(handle, title) {
  const r = await fetch(`${handle.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  assert.equal(r.status, 201);
  const row = await r.json();
  const raw = await readFile(join(handle.projectsDir, row.id, "meta.json"), "utf8");
  return JSON.parse(raw);
}

test("POST /projects stores claude agent_id when PAI_AGENT is unset", async () => {
  const handle = await startViewer();
  try {
    const meta = await createProjectAndReadMeta(handle, "Agent Default");
    assert.equal(meta.agent_id, "claude");
  } finally {
    await stopViewer(handle);
  }
});

test("POST /projects stores codex agent_id when PAI_AGENT=codex", async () => {
  const handle = await startViewer({ paiAgent: "codex" });
  try {
    const meta = await createProjectAndReadMeta(handle, "Agent Codex");
    assert.equal(meta.agent_id, "codex");
  } finally {
    await stopViewer(handle);
  }
});
