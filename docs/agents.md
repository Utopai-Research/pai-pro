# AI coding agent compatibility

Pai-pro is "bring-your-own AI coding agent" — the skills are standard SKILL.md format and consume the same way across any agent that understands it. The web UI's embedded terminal currently only talks to Claude Code, but the skills + CLI scripts run anywhere.

## Current status

| Compatible agent | Status |
|---|---|
| **Claude Code** | ✅ Tested. Embedded PTY + auto-discovered skills via `./scripts/setup`. |
| **Codex CLI** | ⏳ New Codex-owned projects get repo-local `.agents/skills/`; embedded terminal swap-in pending. |
| **Cursor agent** | ⏳ Skills work via `.cursor/rules/`; embedded terminal swap-in pending. |
| **Gemini CLI** | ⏳ Skills work via `~/.gemini/skills/`; embedded terminal swap-in pending. |

The "⏳ pending" agents currently use the host-mode flow with their own native CLI shell — pai-pro's React Flow canvas + WebSocket bridge are Claude-Code-specific for now. Multi-agent first-class support is on the roadmap.

## Installing skills for non-Claude-Code agents

The `SKILL.md` files live in `skills/`. To install for a different agent, symlink the `skills/` dir into wherever that agent looks for skills:

| Agent | Skill discovery path |
|---|---|
| Claude Code | `~/.claude/skills/` (run `./scripts/setup`) |
| Codex CLI | project-local `.agents/skills/` |
| Cursor agent | `.cursor/rules/` |
| Gemini CLI | `~/.gemini/skills/` |

For other agents, follow your agent's docs for SKILL.md format support.

## What you lose without the canvas

If you only install skills (not the canvas + viewer):

- ❌ No visual project state — the agent generates files but you can't see the graph
- ❌ No timeline view — no drag-to-reorder, no scrub, no reel preview
- ❌ No mention-pill references between nodes and chat
- ✅ Skills still work — generation CLIs land assets on disk where you can preview manually
- ✅ All `generate_*.js` CLIs still write proper output JSON

The skills alone get you a 20% experience. The canvas + skills together is the full pai-pro.

## Why Claude Code first?

The embedded terminal is built on a `node-pty` bridge to a real `claude` process — the canvas can:

- Watch the agent's filesystem activity in real time (chokidar on `projects/<id>/`)
- React to skill outputs as they land (re-render the canvas without page refresh)
- Survive page reloads (the PTY persists; reattach replays the last 256 KB of scrollback)

Generalizing this to Codex / Cursor / Gemini CLI requires writing equivalent shims for their respective process bootstrap. Each agent ships a CLI binary that behaves slightly differently w.r.t. session resumption + stdin protocol, so each is its own integration. Contributions welcome — file an issue if you'd like to take one on.
