# Setup and agents

PAI-Pro setup is one decision with two parts: which agent owns new projects,
and whether you want Docker mode or host development mode. Claude Code and
Codex CLI can run inside the embedded browser terminal.

## Choose your path

| Goal | Mode | Agent | Use |
|---|---|---|---|
| Try PAI-Pro or use it for daily filmmaking | Docker | Claude Code default | `./scripts/docker-start.sh` |
| Try PAI-Pro or use it for daily filmmaking | Docker | Codex CLI | `PAI_DEFAULT_AGENT_ID=codex ./scripts/docker-start.sh` |
| Hack on the web or server source | Host mode | Claude Code default | `./scripts/setup --agent claude` then `./scripts/start.sh` |
| Hack on the web or server source | Host mode | Codex CLI | `./scripts/setup --agent codex` then `PAI_DEFAULT_AGENT_ID=codex ./scripts/start.sh` |

Generation behavior differs slightly by agent. Claude Code uses backgrounded
staged Bash calls and reads each final JSON result with `BashOutput`; Codex uses
foreground staged calls and a foreground batch waiter. We keep Codex foreground
because upstream background completion/wake support is still an open area:
openai/codex issues
[#15723](https://github.com/openai/codex/issues/15723),
[#22003](https://github.com/openai/codex/issues/22003), and
[#22099](https://github.com/openai/codex/issues/22099) cover background
subprocess completion, output injection, and nonblocking task management. If
Codex gains reliable background completion delivery, PAI-Pro can switch Codex
generation to the same background pattern.

`PAI_DEFAULT_AGENT_ID` only affects projects created after the viewer starts.
Existing projects keep their saved `meta.json` `agent_id`, so a Claude project
continues to open Claude and a Codex project continues to open Codex regardless
of the current default.

## Quick start

Clone the repo, add a PAI key, then start either Docker or host mode.

```bash
git clone https://github.com/Utopai-Research/pai-pro.git ~/pai-pro
cd ~/pai-pro
cp .env.example .env
# Get your PAI_KEY at https://pai-pro.utopaistudios.com/keys (format: PAI_<random>)
printf "Paste your PAI_KEY: " && read -r key && sed -i.bak "s|^PAI_KEY=.*|PAI_KEY=$key|" .env && rm -f .env.bak
```

| Mode | Claude Code | Codex CLI | Open |
|---|---|---|---|
| Docker | `./scripts/docker-start.sh` | `PAI_DEFAULT_AGENT_ID=codex ./scripts/docker-start.sh` | <http://localhost:7588> |
| Host | `./scripts/setup --agent claude && npm --prefix server install && npm --prefix web install && ./scripts/start.sh` | `./scripts/setup --agent codex && npm --prefix server install && npm --prefix web install && PAI_DEFAULT_AGENT_ID=codex ./scripts/start.sh` | <http://localhost:7443> |

In the embedded terminal, sign in to the selected CLI if prompted. Claude users
can run `/login`; Codex users can complete the Codex login prompt. In Docker,
you can also run `docker exec -it pai-pro codex login` if host Codex auth
was not imported.

## Agent support

| Agent | Embedded terminal | Skills path |
|---|---|---|
| Claude Code | Supported | `~/.claude/skills/` via `./scripts/setup --agent claude` |
| Codex CLI | Supported | Project-local `.agents/skills/` |

Claude and Codex have provider shims for startup flags, session resume, trust
setup, and stdin behavior.

`PAI_AGENT` is not a supported alias. Leave it unset and use
`PAI_DEFAULT_AGENT_ID`.

## Docker mode

Docker is the recommended path for trying PAI-Pro and for day-to-day filmmaking.
It bundles the runtime dependencies and keeps the unattended agent inside a
container boundary.

Use `./scripts/docker-start.sh` to launch Docker. It pulls the latest git state
with `git pull --ff-only`, rebuilds the Docker image from this checkout, and
force-recreates the container while preserving the named Docker volumes that
store projects and agent auth/session state. When Codex is selected, it also
refreshes the Codex npm `latest` install layer during the rebuild.

Prerequisite: Docker Desktop on macOS/Windows, or Docker Engine plus Compose v2
on Linux. On Windows, use PowerShell or WSL2 rather than `cmd.exe`; WSL2 users
should clone into the WSL2 home directory for better file-system performance.

The image includes:

- ffmpeg, poppler, cloudflared, Claude Code, and Codex CLI.
- Native Node modules rebuilt for Linux.
- Bubblewrap for Codex's normal Linux sandbox path.
- `/healthz` checks for media tools, volume writability, and the selected
  default agent CLI.
- A Cloudflare quick tunnel so PAI can fetch local image/video references for
  server-side provider calls.

Docker stores project files in the `pai_projects` named volume. Docker-created
Codex auth/config/session state lives in the `pai_codex` named volume; host
`~/.codex` is mounted read-only and only `auth.json` is imported on first boot
when needed. Host-to-container Codex session resume is intentionally unsupported
because Codex sessions store absolute cwd paths.

Container port `:7488` maps to host `:7588`, so Docker can run next to host
mode, which uses `:7488` and `:7443`. Set `HOST_VIEWER_PORT=7488` in `.env` if
you do not run host mode and want Docker on the canonical viewer port.

Set `PUBLIC_VIEWER_URL` in `.env` to skip the anonymous Cloudflare quick tunnel
and use your own public viewer URL for provider reference fetching. Set
`DEBUG=1` and rebuild to show verbose Docker startup logs.

To reset Docker project data:

```bash
COMPOSE_PROJECT_NAME=pai-pro docker compose down -v
./scripts/docker-start.sh
```

`down -v` permanently deletes every project and generated asset in the Docker
volume.

## Host development mode

Host mode is for hacking on PAI-Pro source itself. It gives you Vite HMR for
`web/src/`, direct server logs, and no Docker rebuild loop.

Prerequisites:

- Node.js 20 or newer and npm.
- A supported embedded agent CLI installed and logged in: `claude` by default,
  or `codex` when starting with `PAI_DEFAULT_AGENT_ID=codex`.
- tmux for `./scripts/start.sh` sessions.
- cloudflared so PAI can fetch local refs for video generation and image pro
  edits.
- poppler (`pdftotext`) for PDF upload text extraction.

Useful commands:

```bash
npm --prefix server install
npm --prefix web install
./scripts/start.sh                    # viewer :7488, web :7443
./scripts/stop.sh                     # stop tmux sessions
cd server && npm test                 # server test suite
```

Debugging panes:

- Viewer logs: `tmux attach -t pai_pro_viewer_7488`
- Vite logs: `tmux attach -t pai_pro_web_7443`
- PTY logs: visible in the browser's embedded terminal

## Permissions and trust

Each project's embedded agent launches fully unattended by default:

1. Claude uses `claude --dangerously-skip-permissions`; Codex uses
   `codex --dangerously-bypass-approvals-and-sandbox`.
2. The project folder is pre-trusted in the agent's own trust store right before
   launch.

This lets the agent edit project files and run media CLIs without per-action
prompts. Docker is the safer default for this behavior because the agent runs as
a non-root user inside an isolated project volume. In host mode, the same bypass
can touch anything the viewer's user can touch, so disable it if you feed the
agent untrusted prompts:

```bash
PAI_AGENT_BYPASS=0 ./scripts/start.sh
PAI_AGENT_BYPASS=0 ./scripts/docker-start.sh
```

Any value other than `0`, `false`, `no`, or `off` keeps the bypass enabled.

## Contributing changes

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the PR process, the
proprietary-skills carve-out, and the CLA flow.

## Troubleshooting

- Missing `PAI_KEY`: canvas, terminal, and notes work, but media generation
  fails until `.env` has a key.
- Missing Codex CLI: Claude-default starts warn only; Codex-default starts fail
  during preflight.
- Local refs fail: restart with `./scripts/start.sh` or Docker so cloudflared
  writes a tunnel URL.
- Port conflicts in host mode: run `./scripts/stop.sh`, then start again.
