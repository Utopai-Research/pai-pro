#!/usr/bin/env node
// PreToolUse hook — refuses Write/Edit on any workflow.json. Those are
// owned by the canvas mutator (server/canvas_mutator.js); the agent
// reaches them via `server/cli/canvas_mutate.js --op …` or
// `POST /projects/:id/mutate`.
//
// Hook contract: receives the tool invocation JSON on stdin,
// exits 2 to block + surfaces the stderr message to the agent's next
// reasoning turn.

import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  // Hook didn't get JSON — let the tool through rather than break.
  process.exit(0);
}

const filePath = String(input?.tool_input?.file_path || "");
if (/(?:^|\/)workflow\.json$/.test(filePath)) {
  console.error(
    `workflow.json is managed by the canvas mutator. Use:\n` +
    `  node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" --op <addNode|updateNode|...> --payload-json '{...}'\n` +
    `or POST /projects/:id/mutate. See server/canvas_mutator.js for the op surface.\n` +
    `Blocked path: ${filePath}`
  );
  process.exit(2);
}

process.exit(0);
