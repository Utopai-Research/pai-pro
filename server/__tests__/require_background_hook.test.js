import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, "..", "..", ".claude", "hooks", "require_background_for_generate.js");

function runHook({ command, runInBackground = false }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({
      tool_input: {
        command,
        run_in_background: runInBackground,
      },
    }));
  });
}

test("require_background hook blocks foreground media-generation CLIs", async () => {
  for (const script of [
    "generate_image.js",
    "generate_image_pro.js",
    "generate_video.js",
    "generate_voice.js",
  ]) {
    const result = await runHook({
      command: `node "$PAI_REPO_ROOT/server/cli/${script}" --stage --prompt x`,
    });
    assert.equal(result.code, 2, `${script} should be blocked in foreground`);
    assert.match(result.stderr, /run_in_background: true/);
  }
});

test("require_background hook allows backgrounded media-generation CLIs", async () => {
  const result = await runHook({
    command: 'node "$PAI_REPO_ROOT/server/cli/generate_image_pro.js" --stage --prompt x',
    runInBackground: true,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("require_background hook catches separated node invocations and ignores incidental mentions", async () => {
  const separated = await runHook({
    command: 'cd projects/scratch; node "$PAI_REPO_ROOT/server/cli/generate_video.js" --stage --prompt x',
  });
  assert.equal(separated.code, 2);

  const incidental = await runHook({
    command: 'printf "%s\\n" "node $PAI_REPO_ROOT/server/cli/generate_video.js --stage"',
  });
  assert.equal(incidental.code, 0);
});
