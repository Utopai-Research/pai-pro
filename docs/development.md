# Development setup

Pai-pro can run in two modes:

- **Docker (production-shape)** — see [docker.md](docker.md). Use this for trying pai-pro or running it day-to-day.
- **Host mode (development)** — this doc. Use this when hacking on the canvas source itself (Vite HMR, live reload, easier debugging).

The two use different ports (`:7588` and `:7488`) so you can run both side by side, useful for catching "works on my machine" regressions before they ship.

## Prerequisites

- **Node.js ≥20** and **npm**
- **A supported embedded agent CLI** installed and logged in: Claude Code (`claude`) by default, or Codex CLI (`codex`) when you start with `PAI_DEFAULT_AGENT_ID=codex`
- **tmux** — `./scripts/start.sh` launches viewer + web in detached tmux sessions
- **[cloudflared](https://github.com/cloudflare/cloudflared)** — `brew install cloudflared` on macOS, or [binary download](https://github.com/cloudflare/cloudflared/releases) for Linux/Windows. `./scripts/start.sh` auto-launches it as a quick tunnel so PAI can fetch local refs from a publicly-reachable URL for video generation and image pro edits.
- **[poppler](https://poppler.freedesktop.org/)** (`pdftotext`) — `brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu. `./scripts/start.sh` auto-installs on macOS. Used at upload time to inline a PDF's text into the note body so the agent can read it without a shell-out. Missing → PDF notes fall back to filename-only.

## Install

```bash
git clone https://github.com/Utopai-Research/pai-pro.git ~/pai-pro
cd ~/pai-pro
./scripts/setup --agent claude       # symlinks skills into Claude Code's user-scope skills dir
npm --prefix server install
npm --prefix web install
cp .env.example .env
# Get your PAI_KEY at https://pai-pro.utopaistudios.com/keys (format: PAI_<random>)
printf "Paste your PAI_KEY: " && read -r key && sed -i.bak "s|^PAI_KEY=.*|PAI_KEY=$key|" .env && rm -f .env.bak
./scripts/start.sh                   # tmux: viewer (:7488) + web (:7443)
open http://localhost:7443
```

The first run creates `projects/` (gitignored) and brings up the projects grid. Click **+ New project** to start.

## Codex host mode

For Codex-owned new projects:

```bash
./scripts/setup --agent codex        # validates codex on PATH
PAI_DEFAULT_AGENT_ID=codex ./scripts/start.sh
```

`PAI_DEFAULT_AGENT_ID` controls only projects created after the viewer starts. Existing projects keep their saved `meta.json` `agent_id`, so a Claude project still opens Claude and a Codex project still opens Codex regardless of the current default.

`./scripts/start.sh` runs `./scripts/setup --agent all --force` on boot. Missing Codex is a warning on Claude-only machines; starting explicitly with `./scripts/setup --agent codex` fails clearly if `codex` is not installed.

## Running tests

```bash
cd server && npm test
```

Tests cover canvas mutation, pending sidecars, asset clients, project setup, and agent providers.

## Debugging

- **Viewer logs:** `./scripts/start.sh` writes them to a tmux pane. `tmux attach -t pai_pro_viewer_7488` to inspect; `stop.sh && start.sh` to recycle.
- **Vite logs:** same shape — `tmux attach -t pai_pro_web_7443`.
- **PTY / embedded agent logs:** visible in the browser's terminal tab.

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
