import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");

function runCli(args) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, "split_image.js"), ...args],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

test("split_image.js rejects invalid grid dimensions as bad_args", async (t) => {
  const baseArgs = [
    "--url", "http://127.0.0.1:1/x.png",
    "--project-id", "split-grid-test",
    "--no-canvas-write",
  ];
  const cases = [
    {
      name: "cols above max",
      args: [...baseArgs, "--cols", "9", "--rows", "8"],
      message: /cols must be an integer in \[1,8\]/,
    },
    {
      name: "rows above max",
      args: [...baseArgs, "--cols", "8", "--rows", "9"],
      message: /rows must be an integer in \[1,8\]/,
    },
    {
      name: "fractional cols",
      args: [...baseArgs, "--cols", "2.5", "--rows", "2"],
      message: /cols must be an integer in \[1,8\]/,
    },
    {
      name: "1x1 no-op",
      args: [...baseArgs, "--cols", "1", "--rows", "1"],
      message: /split is a no-op/,
    },
  ];

  for (const { name, args, message } of cases) {
    await t.test(name, async () => {
      const { code, stdout } = await runCli(args);
      assert.equal(code, 2);
      const reply = parseReply(stdout);
      assert.equal(reply.ok, false);
      assert.equal(reply.klass, "bad_args");
      assert.match(reply.message, message);
    });
  }
});
