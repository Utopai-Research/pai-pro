# Docker setup

Pai-pro's recommended onboarding path — every system dependency (ffmpeg, poppler, cloudflared, Claude CLI) bundled into a single image, one command to bring it up.

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

In the embedded terminal, pick a Claude Code theme and run `/login` once. After that the canvas is fully wired — generate images, chain into videos, drop notes, scrub the timeline.

Your work lives in the `pai_projects` named volume and survives `docker compose restart` / `down`; only `docker compose down -v` wipes it.

## Prerequisites

[Docker Desktop](https://www.docker.com/products/docker-desktop) (macOS / Windows, WSL2 backend on Windows) or Docker Engine + Compose v2 (Linux). Tested on Docker 28.

### Windows users

Run the commands in **PowerShell** or a **WSL2 terminal** — not `cmd.exe` (which doesn't expand `~` or `${HOME}` the same way). Make sure Docker Desktop is using the **WSL2 backend** (default for new installs on Windows 10/11). If you use WSL2, clone into your WSL2 home for best file-system performance.

## What the image gives you

- **Non-root runtime** as the `node` user (UID 1000).
- **Multi-stage build** — native modules (`sharp`, `node-pty`) rebuilt against linux/glibc; runtime layer ships only what's needed.
- **`/healthz` probe** verifies ffmpeg, poppler, Claude CLI, volume writability, and PTY availability on every healthcheck interval. Codex CLI availability is reported separately in the `agents` object, but a missing Codex binary does not fail the Docker healthcheck yet.
- **In-container Cloudflare quick tunnel** for video-gen reference fetching (PAI's `video-generation-assets` endpoint fetches refs server-side and `localhost` is unreachable to it). Anonymous, no account required, ~3s to land a URL. Set `PUBLIC_VIEWER_URL` in `.env` to skip the tunnel and use your own named domain instead.
- **Hardened build context** — `.dockerignore` keeps `.env`, `.tunnel_url`, `projects/`, and other state out of any image layer. Credentials cannot land in the image even by accident.
- **No published image.** Build-locally only, so a maintainer's laptop can never push secrets to a registry.

## Ports

Container port `:7488` maps to host `:7588`. This is intentional so a parallel `./scripts/start.sh` host-mode setup on `:7488` keeps working alongside Docker. Set `HOST_VIEWER_PORT=7488` in `.env` if you don't run host mode and want the canonical port.

## Verbose logs

Default Docker output waits for the tunnel check before printing the ready banner. Set `DEBUG=1` in `.env` and rebuild to bring back the full URL table + cloudflared chatter. The tunnel URL is always written to `.tunnel_url.log` in the container regardless of `DEBUG`.

## Volume management

The `pai_projects` named volume holds your projects directory across container rebuilds. To wipe everything (e.g., for a clean-slate test):

```bash
docker compose down -v
docker compose up --build
```

> **Heads up:** `down -v` permanently deletes every project + every generated asset in the volume. Use only when you intend a clean reset.

## Side-by-side with host mode

The Docker container binds to host `:7588`; host mode (`./scripts/start.sh`) binds to `:7488` and `:7443`. They don't collide — useful for catching "works on my machine" regressions before they ship. See [development.md](development.md).
