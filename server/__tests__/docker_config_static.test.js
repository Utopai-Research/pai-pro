import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

test("Docker image installs Codex CLI with a pinned build arg", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /bubblewrap/);
  assert.match(dockerfile, /ARG CODEX_VERSION=0\.134\.0/);
  assert.match(dockerfile, /npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"/);
  assert.match(dockerfile, /codex --version/);
  assert.match(dockerfile, /codex CLI install failed - Codex PTY will be degraded/);
});

test("docker compose passes default agent and isolates Docker Codex state", async () => {
  const compose = await readFile(join(REPO_ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /PAI_DEFAULT_AGENT_ID:\s+"\$\{PAI_DEFAULT_AGENT_ID:-\}"/);
  assert.match(compose, /pai_codex:\/home\/node\/\.codex/);
  assert.match(compose, /\.codex:\/home\/node\/\.codex-host:ro/);
  assert.doesNotMatch(compose, /\.codex:\/home\/node\/\.codex\s*$/m);
});

test("Docker entrypoint exports the normalized selected agent", async () => {
  const entrypoint = await readFile(join(REPO_ROOT, "docker", "entrypoint.sh"), "utf8");
  assert.match(entrypoint, /normalize_agent_id/);
  assert.match(entrypoint, /export PAI_DEFAULT_AGENT_ID="\$\{SELECTED_AGENT\}"/);
});
