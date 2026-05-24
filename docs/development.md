# Development setup

Pai-pro can run in two modes:

- **Docker (production-shape)** — see [docker.md](docker.md). Use this for trying pai-pro or running it day-to-day.
- **Host mode (development)** — this doc. Use this when hacking on the canvas source itself (Vite HMR, live reload, easier debugging).

The two use different ports (`:7588` and `:7488`) so you can run both side by side, useful for catching "works on my machine" regressions before they ship.

## Prerequisites

- **Node.js ≥20** and **npm**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/setup)** installed and logged in (`claude` should run from any directory)
- **tmux** — `./scripts/start.sh` launches viewer + web in detached tmux sessions
- **[cloudflared](https://github.com/cloudflare/cloudflared)** — `brew install cloudflared` on macOS, or [binary download](https://github.com/cloudflare/cloudflared/releases) for Linux/Windows. `./scripts/start.sh` auto-launches it as a quick tunnel so PAI's `video-generation-assets` endpoint can fetch local video refs from a publicly-reachable URL. Only required for video generation.
- **[poppler](https://poppler.freedesktop.org/)** (`pdftotext`) — `brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu. `./scripts/start.sh` auto-installs on macOS. Used at upload time to inline a PDF's text into the note body so the agent can read it without a shell-out. Missing → PDF notes fall back to filename-only.

## Install

```bash
git clone https://github.com/Utopai-Research/pai-pro.git ~/pai-pro
cd ~/pai-pro
./scripts/setup                      # symlinks skills into your agent's skills dir
npm --prefix server install
npm --prefix web install
cp .env.example .env
# Get your PAI_KEY at https://pai-pro.utopaistudios.com/keys (format: PAI_<random>)
read -rp "Paste your PAI_KEY: " key && echo "PAI_KEY=$key" >> .env
./scripts/start.sh                   # tmux: viewer (:7488) + web (:7443)
open http://localhost:7443
```

The first run creates `projects/` (gitignored) and brings up the projects grid. Click **+ New project** to start.

## Running tests

```bash
cd server && npm test
```

90+ tests covering canvas mutator, pending sidecars, asset client, and provider refs.

## Debugging

- **Viewer logs:** `./scripts/start.sh` writes them to a tmux pane. `tmux attach -t pai-pro-viewer` to inspect; `stop.sh && start.sh` to recycle.
- **Vite logs:** same shape — `tmux attach -t pai-pro-web`.
- **PTY / embedded claude logs:** visible in the browser's terminal tab.

## When to use which mode

| Use Docker for | Use host mode for |
|---|---|
| Trying pai-pro out | Hacking on `web/src/` (Vite HMR ~50ms reloads) |
| Day-to-day filmmaking | Hacking on `server/` (no 5-min rebuild loop) |
| Testing the production code path | Debugging WebSocket protocols |
| One-command bring-up for non-devs | Adding new skills / extending existing ones |

## Stop everything

```bash
./scripts/stop.sh                    # kills tmux sessions
```

Doesn't touch `projects/` — your work survives.

## Contributing changes back

See [CONTRIBUTING.md](../CONTRIBUTING.md) in the repo root for the PR process, the proprietary-skills carve-out, and the CLA flow.
