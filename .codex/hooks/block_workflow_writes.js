#!/usr/bin/env node
// Codex PreToolUse hook: refuse direct edits to workflow.json.
//
// workflow.json is owned by the canvas mutator. Codex file edits arrive
// through apply_patch, so inspect the patch text instead of Claude's
// file_path-only shape. Exit 2 + stderr is Codex's supported block signal.

import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  // Hook didn't get JSON — let the tool through rather than break.
  process.exit(0);
}

function pathLooksLikeWorkflowJson(rawPath) {
  const value = String(rawPath || "").trim();
  return /(?:^|\/)workflow\.json$/.test(value);
}

function patchTouchesWorkflowJson(command) {
  const text = String(command || "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      || line.match(/^\*\*\* Move to: (.+)$/);
    if (match && pathLooksLikeWorkflowJson(match[1])) return true;
  }
  return false;
}

const toolInput = input?.tool_input || {};
const blockedPath = pathLooksLikeWorkflowJson(toolInput.file_path);
const blockedPatch = patchTouchesWorkflowJson(toolInput.command);

if (blockedPath || blockedPatch) {
  console.error(
    `workflow.json is managed by the canvas mutator. Use:\n` +
    `  node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" --op <addNode|updateNode|...> --payload-json '{...}'\n` +
    `or POST /projects/:id/mutate. See server/canvas_mutator.js for the op surface.\n` +
    `Blocked direct workflow.json edit.`
  );
  process.exit(2);
}

process.exit(0);
