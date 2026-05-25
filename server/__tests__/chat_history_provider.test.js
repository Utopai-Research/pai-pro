import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = resolve(__dirname, "..", "local_viewer.js");
const TEST_PROJECT_ID = "old_history_project";

async function freePort() {
  return 17900 + Math.floor(Math.random() * 1000);
}

async function setupProject(projectsDir) {
  const dir = join(projectsDir, TEST_PROJECT_ID);
  await mkdir(join(dir, "assets/images"), { recursive: true });
  await mkdir(join(dir, "assets/videos"), { recursive: true });
  await mkdir(join(dir, "assets/audios"), { recursive: true });
  await mkdir(join(dir, "assets/notes"), { recursive: true });
  await writeFile(
    join(dir, "workflow.json"),
    JSON.stringify({ version: 2, workflow_id: TEST_PROJECT_ID, title: "Old", nodes: [], edges: [] }, null, 2) + "\n",
  );
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id: TEST_PROJECT_ID, title: "Old", created_at: now, last_active_at: now }, null, 2) + "\n",
  );
}

async function setupClaudeSession({ homeDir, projectsDir }) {
  const encodedProjectDir = join(projectsDir, TEST_PROJECT_ID).replace(/[/_.]/g, "-");
  const sessionDir = join(homeDir, ".claude", "projects", encodedProjectDir);
  await mkdir(sessionDir, { recursive: true });
  const sessionId = "session-provider-test";
  const rows = [
    {
      type: "user",
      message: { content: "hello" },
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "u1",
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hi there" },
          { type: "tool_use", name: "Bash", input: { command: "pwd" } },
        ],
      },
      timestamp: "2026-01-01T00:00:01.000Z",
      uuid: "a1",
    },
  ];
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  return sessionId;
}

async function startViewer({ projectsDir, homeDir }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HOME: homeDir,
    VIEWER_PORT: String(port),
    PAI_PROJECTS_DIR: projectsDir,
    PAI_ACTIVE_FILE: join(projectsDir, ".active_project"),
    PAI_ROOT_LINK: join(projectsDir, "workflow.json"),
    WEB_ORIGIN: "http://localhost:0",
  };
  const proc = spawn(process.execPath, [VIEWER_PATH], { env, stdio: ["ignore", "pipe", "pipe"] });
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok) return { proc, baseUrl };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGTERM");
  throw new Error("viewer did not start in 10s");
}

async function stopViewer(proc) {
  if (!proc) return;
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
}

test("old project without agent_id routes chat history through Claude provider", async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), "chat-history-projects-"));
  const homeDir = await mkdtemp(join(tmpdir(), "chat-history-home-"));
  let viewerProc = null;
  try {
    await setupProject(projectsDir);
    const sessionId = await setupClaudeSession({ homeDir, projectsDir });
    const viewer = await startViewer({ projectsDir, homeDir });
    viewerProc = viewer.proc;

    const r = await fetch(`${viewer.baseUrl}/projects/${TEST_PROJECT_ID}/chat-history`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.session_id, sessionId);
    assert.equal(typeof body.mtime, "number");
    assert.deepEqual(body.messages, [
      {
        role: "user",
        text: "hello",
        toolUses: [],
        timestamp: "2026-01-01T00:00:00.000Z",
        uuid: "u1",
      },
      {
        role: "assistant",
        text: "hi there",
        toolUses: [{ name: "Bash", input: { command: "pwd" } }],
        timestamp: "2026-01-01T00:00:01.000Z",
        uuid: "a1",
      },
    ]);
  } finally {
    await stopViewer(viewerProc);
    await rm(projectsDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
