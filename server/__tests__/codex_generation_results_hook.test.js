import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_CLI = resolve(__dirname, "..", "cli", "codex_generation_results_hook.js");

async function makeProject(t) {
  const projectsDir = await mkdtemp(join(tmpdir(), "codex-results-hook-"));
  t.after(() => rm(projectsDir, { recursive: true, force: true }));
  const projectId = "project_hook";
  const dir = join(projectsDir, projectId);
  await mkdir(join(dir, ".results"), { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ id: projectId }) + "\n");
  return { projectsDir, projectId, dir };
}

async function writeResult(dir, jobId, payload) {
  await writeFile(
    join(dir, ".results", `${jobId}.json`),
    JSON.stringify({
      ok: true,
      job_id: jobId,
      kind: "image",
      completed_at: "2026-05-30T00:00:00.000Z",
      node_id: "image_1",
      local_path: "assets/images/image_1.jpg",
      model: "image-generation",
      prompt: "a cat",
      ...payload,
    }, null, 2) + "\n",
  );
}

async function runHook({ dir, projectsDir }) {
  return await new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK_CLI], {
      cwd: dir,
      env: {
        ...process.env,
        PAI_PROJECTS_DIR: projectsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseHook(stdout) {
  const line = stdout.trim();
  return line ? JSON.parse(line) : {};
}

test("Codex generation results hook injects unseen results once", async (t) => {
  const { projectsDir, dir } = await makeProject(t);
  await writeResult(dir, "pending_a", {
    completed_at: "2026-05-30T00:00:01.000Z",
    node_id: "image_1",
    prompt: "a black cat",
  });

  const first = await runHook({ dir, projectsDir });
  assert.equal(first.code, 0, first.stderr);
  const firstPayload = parseHook(first.stdout);
  const context = firstPayload.hookSpecificOutput?.additionalContext;
  assert.equal(firstPayload.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(context, /<pai_generation_results>/);
  assert.match(context, /pending_a/);
  assert.match(context, /image_1/);

  const second = await runHook({ dir, projectsDir });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(parseHook(second.stdout), {});

  await writeResult(dir, "pending_b", {
    ok: false,
    completed_at: "2026-05-30T00:00:02.000Z",
    node_id: undefined,
    klass: "generation_failed",
    message: "provider rejected reference image",
  });

  const third = await runHook({ dir, projectsDir });
  assert.equal(third.code, 0, third.stderr);
  const thirdContext = parseHook(third.stdout).hookSpecificOutput?.additionalContext;
  assert.match(thirdContext, /pending_b/);
  assert.match(thirdContext, /provider rejected reference image/);
  assert.doesNotMatch(thirdContext, /pending_a/);

  const state = JSON.parse(await readFile(join(dir, ".codex", "pai-generation-results-state.json"), "utf8"));
  assert.deepEqual(state.seen_job_ids.slice(0, 2), ["pending_b", "pending_a"]);
});
