# Architecture

Three layers, each independent enough to hack on alone.

## At a glance

```
┌─ Canvas │ Timeline ──────────────────┬─ Terminal │ History ─┐
│                                      │                      │
│   Detective Morris ──► Diner shot    │  > design morris,    │
│        │                    │        │    weathered, noir   │
│        ▼                    ▼        │  ✓ image_3 created   │
│   Morris voice         Morgue still  │  > animate the diner │
│                                      │  ⠋ rendering 8s…     │
└──────────────────────────────────────┴──────────────────────┘
```

The canvas on the left, the embedded agent terminal on the right, both sharing the same project state via WebSocket.

## System layout

```
┌─ Browser (web/) ──────────────┐         ┌─ server/local_viewer.js ──────┐
│                               │         │                               │
│  React Flow canvas  ◄── Socket.IO ─────►│  chokidar watcher             │
│  xterm.js terminal  ◄── PTY bridge ────►│    projects/<id>/             │
│                               │         │      workflow.json            │
└───────────────────────────────┘         │      assets/  (served HTTP)   │
                                          │  node-pty → zsh → claude      │
                                          └───────────────────────────────┘
                                                       ▲ writes
                                                       │
                ┌─ skills/ ─┐   ┌─ server/cli/ ────────┴────┐
                │  *.md     │──►│ generate_image.js          │
                │           │   │ generate_video.js          │  local mirror
                │ Claude in │   │ generate_voice.js          │  → assets/
                │ the PTY   │   │ split_image.js             │
                │ reads     │   │ switch_project.js          │
                └───────────┘   └────────────────────────────┘
```

1. **Skills** are plain markdown read by the agent inside the embedded terminal.
2. **CLI scripts** call PAI Lite (one key, one base URL — image, video, voice, asset uploads all route through `/api/v1/generate` or `/api/v1/submit`), write each result into `projects/<slug>/assets/`, and print one JSON line.
3. **Viewer** watches every project's files and pushes deltas to the browser over Socket.IO, bridges xterm.js ↔ `claude` via node-pty, and serves the mirrored assets at `/projects/:id/assets/...`.

## Directory layout

```
pai-pro/
├── skills/                        # filmmaking skills + skills/CLAUDE.md author guide
├── server/
│   ├── local_viewer.js            # Express + Socket.IO + chokidar + node-pty + asset routes
│   ├── local_mirror.js            # writes/mirrors generated media into projects/<active>/assets/
│   ├── cli/                       # CLI wrappers (generate_*, canvas_mutate, split_image, …)
│   ├── pai_client.js              # shared HTTP plumbing for /api/v1/generate, /submit, /task/status
│   ├── pai_image_client.js        # image (PAI raw `image-generation`)
│   ├── pai_video_client.js        # video (PAI raw `video-generation`)
│   ├── pai_voice_client.js        # voice (PAI raw `tts`)
│   └── pai_assets_client.js       # asset preupload for video refs (PAI raw `video-generation-assets`)
├── web/                           # Vite + React 18 + TS + Tailwind + xyflow + xterm
├── projects/                      # gitignored — your work lives here
├── CLAUDE.md                      # repo maintainer guide (dev sessions auto-load this)
├── agent-templates/AGENTS.md      # canvas schema + agent persona + skill routing (copied into each project)
├── .claude-plugin/marketplace.json
└── scripts/                       # tmux launcher (start.sh) + teardown (stop.sh) + skills symlinker (setup)
```

## Where each layer is documented

- **Canvas schema + agent persona + skill routing:** [agent-templates/AGENTS.md](../agent-templates/AGENTS.md) — the canonical per-project agent operating manual. The viewer copies it into each project at create time as `projects/<id>/AGENTS.md`. The most important reference for the agent's behavior contract.
- **Repo maintainer guide:** [CLAUDE.md](../CLAUDE.md) at the repo root — what you (the maintainer) auto-load when running `claude` at the repo root. Architecture overview, contributor recipes, debugging notes. Per-project agent sessions exclude it via `claudeMdExcludes`.
- **Skill authoring:** [skills/CLAUDE.md](../skills/CLAUDE.md) — when to write a new skill, when to extend an existing one.
- **Individual skill recipes:** [skills/<name>/SKILL.md](../skills/) — one file per skill; together they describe the entire skill surface.

## Why this shape

- **Skills are markdown, not code.** Agent-portable across Claude Code / Codex / Cursor / Gemini CLI. Adding a skill is editing a `SKILL.md`, not writing a TypeScript plugin.
- **CLI scripts are stdout-JSON wrappers.** Each one does one thing, prints one structured line, can be invoked from any agent that can call shell commands.
- **Canvas state is just files on disk.** No database. `chokidar` watches; `workflow.json` is the source of truth. You can hand-edit it (carefully) and the viewer picks up the change.
- **PTY bridge is opt-in.** If the embedded terminal is broken or you'd rather drive your agent in your own terminal, everything still works — just stripped of the live-canvas-in-browser experience.
