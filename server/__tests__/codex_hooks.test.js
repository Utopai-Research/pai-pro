import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const HOOKS_JSON = join(REPO_ROOT, ".codex", "hooks.json");
const WORKFLOW_HOOK = join(REPO_ROOT, ".codex", "hooks", "block_workflow_writes.js");

function runHook(payload) {
  return spawnSync(process.execPath, [WORKFLOW_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

test("Codex hooks config only guards direct workflow edits", async () => {
  const parsed = JSON.parse(await readFile(HOOKS_JSON, "utf8"));
  assert.deepEqual(Object.keys(parsed.hooks), ["PreToolUse"]);
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, "Write|Edit");

  const hook = parsed.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.type, "command");
  assert.match(hook.command, /git rev-parse --show-toplevel/);
  assert.match(hook.command, /\.codex\/hooks\/block_workflow_writes\.js/);
  assert.doesNotMatch(JSON.stringify(parsed), /run_in_background|BashOutput|require_background_for_generate/);
});

test("Codex workflow hook blocks apply_patch edits to workflow.json", () => {
  const result = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: projects/project_a/workflow.json",
        "@@",
        "-{}",
        "+{}",
        "*** End Patch",
      ].join("\n"),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /workflow\.json is managed by the canvas mutator/);
});

test("Codex workflow hook allows non-workflow apply_patch edits", () => {
  const result = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: README.md",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("Codex workflow hook allows Bash media generation", () => {
  const result = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {
      command: 'node "$PAI_REPO_ROOT/server/cli/generate_image.js" --stage --prompt dog',
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("Codex workflow hook still blocks legacy file_path workflow writes", () => {
  const result = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/project/workflow.json",
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /workflow\.json is managed by the canvas mutator/);
});
