// Tests for the @ImageN/@VideoN/@AudioN mentioned-but-not-wired guard.
// Unit-tests the pure logic in cli/_ref_guard.js (incl. the repeated-mention
// and false-positive prose cases), plus a couple of integration spawn tests
// proving the CLI rejects (bad_args, exit 2) before any paid call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkPromptRefsWired } from "../cli/_ref_guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.join(__dirname, "..", "cli");

function runCli(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(CLI_DIR, script), ...args], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

// ---------- unit: pure guard logic ----------

test("image tier: @Image1 with 1 ref passes", () => {
  assert.equal(checkPromptRefsWired({ prompt: "the character in @Image1", refSourceCount: 1, tier: "image" }), null);
});

test("image tier: @Image2 with only 1 ref rejects", () => {
  const msg = checkPromptRefsWired({ prompt: "@Image1 and @Image2", refSourceCount: 1, tier: "image" });
  assert.match(msg, /@Image2/);
});

test("image tier: @Image1 with 0 refs rejects (the wiring bug)", () => {
  assert.ok(checkPromptRefsWired({ prompt: "use @Image1 as the location", refSourceCount: 0, tier: "image" }));
});

// The user's explicit invariant: one ref, mentioned many times, is legitimate.
test("repeated @Image1 with a single ref passes (max index, NOT mention count)", () => {
  assert.equal(
    checkPromptRefsWired({ prompt: "@Image1 walks; later @Image1 turns; @Image1 again", refSourceCount: 1, tier: "image" }),
    null,
  );
});

test("image tier: @Video1 / @Audio1 are category errors regardless of count", () => {
  assert.match(checkPromptRefsWired({ prompt: "voice @Audio1", refSourceCount: 0, tier: "image" }), /image tier/);
  assert.match(checkPromptRefsWired({ prompt: "@Video1 continue", refSourceCount: 5, tier: "image" }), /image tier/);
});

// The false-positive landmine — anchored regex must let prose through.
test("prose lookalikes must pass (@Image2K, @Audio48khz, @Image1Studios)", () => {
  assert.equal(checkPromptRefsWired({ prompt: "render at @Image2K detail", refSourceCount: 0, tier: "image" }), null);
  assert.equal(checkPromptRefsWired({ prompt: "mixed at @Audio48khz", refSourceCount: 0, tier: "video" }), null);
  assert.equal(checkPromptRefsWired({ prompt: 'the sign reads "@Image1Studios"', refSourceCount: 0, tier: "video" }), null);
});

test("case-sensitive: @image1 (lowercase) is not a ref token", () => {
  assert.equal(checkPromptRefsWired({ prompt: "dm me @image1 now", refSourceCount: 0, tier: "image" }), null);
});

test("video tier: @Audio1 with 0 audio refs rejects", () => {
  assert.match(
    checkPromptRefsWired({ prompt: "narrator @Audio1 says a line", refSourceCount: 0, audioRefCount: 0, tier: "video" }),
    /@Audio1/,
  );
});

test("video tier: @Audio1 with 1 audio ref passes", () => {
  assert.equal(
    checkPromptRefsWired({ prompt: "narrator @Audio1 says a line", refSourceCount: 0, audioRefCount: 1, tier: "video" }),
    null,
  );
});

test("video tier: @Image1 + @Video1 needs 2 source refs", () => {
  assert.match(
    checkPromptRefsWired({ prompt: "open on @Image1 then @Video1", refSourceCount: 1, audioRefCount: 0, tier: "video" }),
    /source ref/,
  );
  assert.equal(
    checkPromptRefsWired({ prompt: "open on @Image1 then @Video1", refSourceCount: 2, audioRefCount: 0, tier: "video" }),
    null,
  );
});

test("video tier: reverse direction (refs passed, none mentioned) passes", () => {
  assert.equal(
    checkPromptRefsWired({ prompt: "a quiet courtyard at dawn, slow push-in", refSourceCount: 2, audioRefCount: 1, tier: "video" }),
    null,
  );
});

test("video tier: the A1 bug (@Image1/@Image2/@Audio1, 0 refs) rejects", () => {
  assert.ok(
    checkPromptRefsWired({
      prompt: "@Image1 environment, @Image2 face, narrator @Audio1",
      refSourceCount: 0,
      audioRefCount: 0,
      tier: "video",
    }),
  );
});

// ---------- integration: the CLI rejects before spending ----------

test("generate_video.js rejects @Image1 with no --ref-source-id (bad_args, exit 2)", async () => {
  const { code, stdout } = await runCli("generate_video.js", [
    "--stage",
    "--prompt",
    "the gate in @Image1, slow push-in",
    "--no-canvas-write",
  ]);
  assert.equal(code, 2);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /@Image1/);
});

test("generate_image_pro.js rejects @Audio1 on the image tier (bad_args, exit 2)", async () => {
  const { code, stdout } = await runCli("generate_image_pro.js", [
    "--stage",
    "--prompt",
    "imperial portrait, voice @Audio1",
    "--no-canvas-write",
  ]);
  assert.equal(code, 2);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  assert.equal(reply.klass, "bad_args");
  assert.match(reply.message, /image tier/);
});
