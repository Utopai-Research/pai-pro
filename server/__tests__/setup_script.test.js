import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SETUP_PATH = join(REPO_ROOT, "scripts", "setup");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function skillNames() {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await pathExists(join(SKILLS_ROOT, entry.name, "SKILL.md"))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function tempHome(t, prefix = "pai-setup-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runSetup(args, { home, path = process.env.PATH } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PATH: path,
    PAI_REPO_ROOT: REPO_ROOT,
  };
  return await new Promise((resolve) => {
    const proc = spawn(SETUP_PATH, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeFakeCodexBin(t) {
  const dir = await mkdtemp(join(tmpdir(), "pai-fake-codex-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "codex");
  await writeFile(bin, "#!/bin/sh\necho 'codex-cli 9.9.9'\n");
  await chmod(bin, 0o755);
  return dir;
}

test("scripts/setup default installs Claude skill symlinks", async (t) => {
  const home = await tempHome(t);
  const result = await runSetup([], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /open a new Claude Code session/);

  const names = await skillNames();
  assert.ok(names.length > 0);
  for (const name of names) {
    const link = join(home, ".claude", "skills", name);
    const stat = await lstat(link);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(await readlink(link), join(SKILLS_ROOT, name));
  }
});

test("scripts/setup --agent codex validates CLI and does not install Claude symlinks", async (t) => {
  const home = await tempHome(t);
  const fakeBin = await makeFakeCodexBin(t);
  const result = await runSetup(["--agent", "codex"], {
    home,
    path: `${fakeBin}${delimiter}${process.env.PATH}`,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /codex CLI: codex-cli 9\.9\.9/);
  assert.match(result.stdout, /PAI_DEFAULT_AGENT_ID=codex \.\/scripts\/start\.sh/);
  assert.equal(await pathExists(join(home, ".claude", "skills")), false);
});

test("scripts/setup --agent codex fails clearly when Codex is missing", async (t) => {
  const home = await tempHome(t);
  const result = await runSetup(["--agent", "codex"], {
    home,
    path: "/bin:/usr/bin",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /codex CLI not found/);
});

test("scripts/setup --agent all keeps Claude setup working when Codex is missing", async (t) => {
  const home = await tempHome(t);
  const result = await runSetup(["--agent", "all", "--force"], {
    home,
    path: "/bin:/usr/bin",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /warning: codex CLI not found/);

  const names = await skillNames();
  const firstLink = join(home, ".claude", "skills", names[0]);
  const stat = await lstat(firstLink);
  assert.equal(stat.isSymbolicLink(), true);
});

test("scripts/setup --agent all validates Codex without host-mode instructions", async (t) => {
  const home = await tempHome(t);
  const fakeBin = await makeFakeCodexBin(t);
  const result = await runSetup(["--agent", "all"], {
    home,
    path: `${fakeBin}${delimiter}${process.env.PATH}`,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /codex CLI: codex-cli 9\.9\.9/);
  assert.doesNotMatch(result.stdout, /PAI_DEFAULT_AGENT_ID=codex \.\/scripts\/start\.sh/);
});
