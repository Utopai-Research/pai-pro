import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProvider } from "../agents/index.js";

async function tmpProject(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectDir = join(root, "projects", "p1");
  await mkdir(projectDir, { recursive: true });
  // Agents key trust by the resolved realpath of the cwd.
  const abs = await realpath(projectDir);
  return { root, projectDir, abs };
}

// ---------------- claude ----------------

test("claude ensureTrust seeds the project's trust entry into an isolated .claude.json", async () => {
  const { root, projectDir, abs } = await tmpProject("trust-claude-");
  const provider = getProvider("claude");
  await provider.ensureTrust(projectDir, { CLAUDE_CONFIG_DIR: root });

  const cfg = JSON.parse(await readFile(join(root, ".claude.json"), "utf8"));
  assert.equal(cfg.projects[abs].hasTrustDialogAccepted, true);
  assert.equal(cfg.projects[abs].hasCompletedProjectOnboarding, true);
});

test("claude ensureTrust preserves existing config and sibling projects", async () => {
  const { root, projectDir, abs } = await tmpProject("trust-claude-");
  const file = join(root, ".claude.json");
  await writeFile(
    file,
    JSON.stringify({
      oauthAccount: { id: "keep-me" },
      projects: { "/other/project": { hasTrustDialogAccepted: true, custom: 7 } },
    }),
  );
  const provider = getProvider("claude");
  await provider.ensureTrust(projectDir, { CLAUDE_CONFIG_DIR: root });

  const cfg = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(cfg.oauthAccount, { id: "keep-me" }); // untouched
  assert.equal(cfg.projects["/other/project"].custom, 7); // sibling preserved
  assert.equal(cfg.projects[abs].hasTrustDialogAccepted, true);
});

test("claude ensureTrust is idempotent (no rewrite once trusted)", async () => {
  const { root, projectDir } = await tmpProject("trust-claude-");
  const file = join(root, ".claude.json");
  const provider = getProvider("claude");
  await provider.ensureTrust(projectDir, { CLAUDE_CONFIG_DIR: root });
  const first = await readFile(file, "utf8");
  await provider.ensureTrust(projectDir, { CLAUDE_CONFIG_DIR: root });
  const second = await readFile(file, "utf8");
  assert.equal(first, second);
});

// ---------------- codex ----------------

test("codex ensureTrust appends a trusted project section to config.toml", async () => {
  const { root, projectDir, abs } = await tmpProject("trust-codex-");
  const provider = getProvider("codex");
  await provider.ensureTrust(projectDir, { CODEX_HOME: root });

  const toml = await readFile(join(root, "config.toml"), "utf8");
  assert.ok(toml.includes(`[projects."${abs}"]\ntrust_level = "trusted"`));
});

test("codex ensureTrust preserves existing config and never duplicates the section", async () => {
  const { root, projectDir, abs } = await tmpProject("trust-codex-");
  const file = join(root, "config.toml");
  await writeFile(file, '[features]\nfoo = true\n');
  const provider = getProvider("codex");
  await provider.ensureTrust(projectDir, { CODEX_HOME: root });
  await provider.ensureTrust(projectDir, { CODEX_HOME: root }); // second call: no-op

  const toml = await readFile(file, "utf8");
  assert.match(toml, /\[features\]\nfoo = true/);            // prior content intact
  const header = `[projects."${abs}"]`;
  const occurrences = toml.split(header).length - 1;
  assert.equal(occurrences, 1);                               // exactly once
});

test("codex ensureTrust respects an existing untrusted decision", async () => {
  const { root, projectDir, abs } = await tmpProject("trust-codex-");
  const file = join(root, "config.toml");
  await writeFile(file, `[projects."${abs}"]\ntrust_level = "untrusted"\n`);
  const provider = getProvider("codex");
  await provider.ensureTrust(projectDir, { CODEX_HOME: root });

  const toml = await readFile(file, "utf8");
  assert.match(toml, /trust_level = "untrusted"/);
  assert.doesNotMatch(toml, /trust_level = "trusted"/);
});
