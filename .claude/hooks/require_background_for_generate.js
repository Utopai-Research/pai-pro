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
// add another long-running paid media CLI under server/cli/.
const GUARDED_CLIS = [
  "generate_image.js",
  "generate_image_pro.js",
  "generate_video.js",
  "generate_voice.js",
  "upscaler.js",
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

function invokesGuardedCli(command) {
  // Treat common shell command separators as independent segments. This is
  // intentionally conservative rather than a full shell parser: it catches
  // `cd x && node ...`, `cd x; node ...`, and one-command invocations while
  // still ignoring incidental mentions inside echo/printf/gh-body text.
  const segments = command
    .split(/(?:&&|\|\||[;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.some((segment) => (
    segment.startsWith("node ")
    && GUARDED_CLIS.some((cli) => segment.includes(cli))
  ));
}

if (invokesGuardedCli(cmd) && !bg) {
  console.error(
    `media generation CLIs require run_in_background: true. Re-invoke and BashOutput-poll the bash id.`
  );
  process.exit(2);
}

process.exit(0);
