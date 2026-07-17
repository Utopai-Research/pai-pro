import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

test("Docker image installs Codex CLI with an overridable latest build arg", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /bubblewrap/);
  assert.match(dockerfile, /ARG CODEX_VERSION=latest/);
  assert.match(dockerfile, /ARG CODEX_INSTALL_REFRESH=manual/);
  assert.match(dockerfile, /npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"/);
  assert.match(dockerfile, /codex --version/);
  assert.match(dockerfile, /codex CLI install failed - Codex PTY will be degraded/);
});

test("Docker launcher refreshes the Codex latest install layer", async () => {
  const script = await readFile(join(REPO_ROOT, "scripts", "docker-start.sh"), "utf8");
  assert.match(script, /docker compose build "\$\{build_args\[@\]\}"/);
  assert.match(script, /--build-arg CODEX_VERSION="\$\{CODEX_VERSION:-latest\}"/);
  assert.match(script, /if \[ "\$PAI_DEFAULT_AGENT_ID" = "codex" \]; then/);
  assert.match(script, /CODEX_INSTALL_REFRESH:-\$\(date -u \+%Y%m%d%H%M%S\)/);
  assert.match(script, /build_args\+=\(--build-arg CODEX_INSTALL_REFRESH="\$codex_install_refresh"\)/);
});

test("Docker launcher builds the current checkout and recreates the container", async () => {
  const compose = await readFile(join(REPO_ROOT, "docker-compose.yml"), "utf8");
  const script = await readFile(join(REPO_ROOT, "scripts", "docker-start.sh"), "utf8");
  assert.match(compose, /context:\s+\./);
  assert.match(script, /PAI_REPO_ROOT="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/);
  assert.match(script, /cd "\$PAI_REPO_ROOT"/);
  assert.match(script, /git pull --ff-only/);
  assert.match(script, /docker compose up -d --force-recreate --remove-orphans/);
});

test("Docker launcher never pulls over local work", async () => {
  const script = await readFile(join(REPO_ROOT, "scripts", "docker-start.sh"), "utf8");
  // Escape hatch + dev-checkout guards: PAI_NO_PULL=1, dirty tree, no upstream.
  assert.match(script, /PAI_NO_PULL:-0/);
  assert.match(script, /git diff --quiet \|\| ! git diff --cached --quiet/);
  assert.match(script, /git rev-parse --abbrev-ref --symbolic-full-name '@\{upstream\}'/);
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
