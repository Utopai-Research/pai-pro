#!/usr/bin/env node
// PreToolUse hook — rejects foreground Bash invocations of the media-
// generation CLIs. Claude Code's Bash tool serializes foreground commands
// within a single message, so N parallel tool_uses still execute one at
// a time. run_in_background: true bypasses that serialization; each call
// becomes its own OS subprocess and N calls truly run in parallel.
//
// Hook contract (Claude Code): receives the tool invocation JSON on stdin,
// exits 2 to block + surfaces the stderr message to the agent's next
// reasoning turn.

import { readFileSync } from "node:fs";

// Explicit allow-list of CLIs we guard. Add a filename here when you
// add another long-running generate_* CLI under server/cli/.
const GUARDED_CLIS = [
  "generate_image.js",
  "generate_video.js",
  "generate_voice.js",
];

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  // Hook didn't get JSON — let the tool through rather than break.
  process.exit(0);
}

const cmd = String(input?.tool_input?.command || "");
const bg  = input?.tool_input?.run_in_background === true;

// Only treat the command as a CLI invocation when it actually shells out
// to `node …` (allowing one optional `cd <dir> && ` prefix). This skips
// incidental mentions of the filename inside echo/printf/gh-body text.
const lastSegment = cmd.split("&&").pop().trim();
const isNodeInvocation = lastSegment.startsWith("node ");
const mentionsGuardedCli = GUARDED_CLIS.some((cli) => cmd.includes(cli));

if (isNodeInvocation && mentionsGuardedCli && !bg) {
  console.error(
    `generate_*.js requires run_in_background: true. Re-invoke and BashOutput-poll the bash id.`
  );
  process.exit(2);
}

process.exit(0);
