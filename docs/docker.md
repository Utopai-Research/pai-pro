# Docker setup

Pai-pro's recommended onboarding path — every system dependency (ffmpeg, poppler, cloudflared, Claude Code, and Codex CLI) bundled into a single image, one command to bring it up.

## Quick start

```bash
git clone https://github.com/Utopai-Research/pai-pro.git ~/pai-pro
cd ~/pai-pro
cp .env.example .env
# Get your PAI_KEY at https://pai-pro.utopaistudios.com/keys (format: PAI_<random>)
printf "Paste your PAI_KEY: " && read -r key && sed -i.bak "s|^PAI_KEY=.*|PAI_KEY=$key|" .env && rm -f .env.bak
docker compose up --build             # ~5-10 min first build, cached after
# Wait for "PAI Pro is ready", then open the browser entry:
open http://localhost:7588
```

New projects use Claude Code by default. To make newly-created projects use Codex CLI instead:

```bash
PAI_DEFAULT_AGENT_ID=codex docker compose up --build
```

In the embedded terminal, sign in to the selected CLI if prompted. Claude users can run `/login`; Codex users can complete Codex's login prompt, or run `docker compose exec pai-pro codex login` if Docker did not import a host Codex login.

Your work lives in the `pai_projects` named volume and survives `docker compose restart` / `down`; only `docker compose down -v` wipes it.

## Prerequisites

[Docker Desktop](https://www.docker.com/products/docker-desktop) (macOS / Windows, WSL2 backend on Windows) or Docker Engine + Compose v2 (Linux).

### Windows users

Run the commands in **PowerShell** or a **WSL2 terminal** — not `cmd.exe` (which doesn't expand `~` or `${HOME}` the same way). Make sure Docker Desktop is using the **WSL2 backend** (default for new installs on Windows 10/11). If you use WSL2, clone into your WSL2 home for best file-system performance.

## What the image gives you

- **Non-root runtime** as the `node` user (UID 1000).
- **Multi-stage build** — native modules (`sharp`, `node-pty`) rebuilt against linux/glibc; runtime layer ships only what's needed.
- **Both embedded agent CLIs** — Claude Code plus pinned Codex CLI.
- **Codex sandbox prerequisites** — `bubblewrap` is installed in the runtime image so Codex can use its normal Linux sandbox path.
- **`/healthz` probe** verifies ffmpeg, poppler, volume writability, and the selected default agent CLI. It reports all known agents under `agents`, but only the selected default gates `ok`.
- **In-container Cloudflare quick tunnel** for provider reference fetching (video refs and image pro edit refs are fetched server-side, and `localhost` is unreachable to PAI). Anonymous, no account required, ~3s to land a URL. Set `PUBLIC_VIEWER_URL` in `.env` to skip the tunnel and use your own named domain instead.
- **Hardened build context** — `.dockerignore` keeps `.env`, `.tunnel_url`, `projects/`, and other state out of any image layer. Credentials cannot land in the image even by accident.
- **No published image.** Build-locally only, so a maintainer's laptop can never push secrets to a registry.

## Agent selection

`PAI_DEFAULT_AGENT_ID` controls only the default owner for new projects created after the viewer starts. It does not convert existing projects. Each project stores its owner in `meta.json` as `agent_id`, and the Agent panel launches that project's owner.

```bash
# Claude default
docker compose up --build

# Codex default
PAI_DEFAULT_AGENT_ID=codex docker compose up --build
```

Docker stores Codex auth, config, and Docker-created sessions in the `pai_codex` named volume at `/home/node/.codex`. It also bind-mounts host `~/.codex` read-only at `/home/node/.codex-host` and imports only `auth.json` on first boot when the Docker Codex home has no auth yet. Host `config.toml`, MCP server config, and host session files are not loaded into the container, so host-only MCP tools cannot break Docker Codex startup.

Host-to-container Codex session resume is intentionally not supported because Codex session metadata records absolute cwd paths. Docker-to-Docker resume across container restarts should work through the `pai_codex` volume.

For non-interactive enterprise access-token workflows, pipe the token into `codex login --with-access-token` inside the container as documented by Codex. Do not set `CODEX_ACCESS_TOKEN` as a passive compose environment variable; Codex does not use it that way.

## Ports

Container port `:7488` maps to host `:7588`. This is intentional so a parallel `./scripts/start.sh` host-mode setup on `:7488` keeps working alongside Docker. Set `HOST_VIEWER_PORT=7488` in `.env` if you don't run host mode and want the canonical port.

## Verbose logs

Default Docker output waits for the tunnel check before printing the ready banner. Set `DEBUG=1` in `.env` and rebuild to bring back the full URL table + cloudflared chatter. The tunnel URL is always written to `.tunnel_url.log` in the container regardless of `DEBUG`.

## Volume management

The `pai_projects` named volume holds your projects directory across container rebuilds. Claude session JSONLs are bind-mounted from host `~/.claude/projects`, and Docker Codex auth/config/session state lives in the `pai_codex` named volume. To wipe project data (e.g., for a clean-slate test):

```bash
docker compose down -v
docker compose up --build
```

> **Heads up:** `down -v` permanently deletes every project + every generated asset in the volume. Use only when you intend a clean reset.

## Side-by-side with host mode

The Docker container binds to host `:7588`; host mode (`./scripts/start.sh`) binds to `:7488` and `:7443`. They don't collide — useful for catching "works on my machine" regressions before they ship. See [development.md](development.md).
