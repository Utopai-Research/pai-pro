# FAQ

## Skills don't trigger

Restart your AI agent session after `./scripts/setup` — skills load at session start. If you're inside the embedded terminal, close the project and reopen.

## Generation fails with `bad_args`

Either `.env` is missing `PAI_KEY`, or you asked for a video with a local ref and the tunnel isn't running. Re-run `./scripts/start.sh`; if `cloudflared` is missing, install it (macOS: `brew install cloudflared`; Linux/Windows: <https://github.com/cloudflare/cloudflared/releases>) and re-run.

Last resort: pass a public URL via `--reference-image-url` / `--reference-audio-url` / `--reference-video-url`.

## Canvas is empty even though I see asset files on disk

The agent may have mirrored to the wrong project (stale `.active_project`). Reload the page — `CanvasView` POSTs `/projects/:id/activate` on mount to re-sync the symlinks.

## Can I run this without an API key?

Yes — canvas, terminal, and notes work. Media generation just fails with a clean `infra`-class error ("PAI_KEY not set in env") until you add the key.

## How do I add a new skill?

Read [skills/CLAUDE.md](../skills/CLAUDE.md) for the SKILL.md authoring contract. Drop a new directory under `skills/<your-skill>/` with a `SKILL.md` file and (optionally) any helper scripts. Claude users run `./scripts/setup` to symlink it into `~/.claude/skills/`; Codex-owned projects get `.agents/skills/` symlinks when the project is created. The agent picks it up at next session start.

## How do parallel generations work?

When you ask the agent for multiple independent things ("design three character variations" or "generate three images of the diner from different angles"), pai-pro fires them concurrently. Three independent images render in ~20s, not ~60s. See the *Parallel calls* rule in [agent-templates/PROJECT_AGENT.md](../agent-templates/PROJECT_AGENT.md) for the contract.

## What happens if I close the browser mid-generation?

Generation continues server-side; the sidecar in `projects/<id>/.pending/` tracks state. Refresh the page and the in-flight node reappears with its progress.

## How much do generations cost?

Per call: image ~$0.07–0.15 / voice $0.01 per 500 chars / asset upload $0.01 per ref / video several dollars depending on duration + resolution. CLIs only fire when you explicitly ask for media; chat suggestions don't burn credits. Watch your live balance at <https://pai-pro.utopaistudios.com/>.

## Docker vs host mode — which do I want?

[docs/development.md](development.md) has the full comparison. Short answer: Docker for trying it / daily filmmaking; host mode for hacking on pai-pro source itself.

## Can I use a different AI coding agent?

Today: Claude Code is fully wired with the embedded terminal. Skills work with Codex CLI / Cursor / Gemini CLI but those agents can't drive the canvas yet — see [docs/agents.md](agents.md).
