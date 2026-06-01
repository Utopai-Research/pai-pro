# Skills

Each skill is a standard `SKILL.md` with YAML frontmatter. Claude Code auto-discovers user-scope skills after `./scripts/setup --agent claude`; every project also gets repo-local symlinks under `.agents/skills/` so Codex and other terminal agents can read the same recipes. You describe what you want, and the agent invokes or reads the right skill.

There are two skill types:

- Workflow skills sequence multiple capability skills without owning CLI recipes.
- Capability skills own one media/tool domain, including CLI flags, refs, node shape, and failure recovery.

## Reference table

| Skill | Triggers on phrases like | What it does |
|---|---|---|
| `story-to-video-workflow` | "Make this script into a video", "What next for this promo?" | Sequences script, refs, voices, render path, clip dispatch, and Timeline/reel handoff. Routes execution to capability skills. |
| `script-compose` | "Write a screenplay for…", "Break this into shots" | Triages screenplay vs. concept, iterates dialogue, splits into ≤15s shots. |
| `image-compose` | "Design a character", "Edit this image", "Storyboard mosaic" | Wraps `generate_image.js` (~10–30s) and `generate_image_pro.js` for storyboard mosaics and video-bound character sheets (~3–6 min). |
| `video-compose` | "Animate this", "Continue the clip", "Restyle the shot" | Wraps `generate_video.js`. Handles I2V, V2V continuation, voice-locked dubs, narrative sequencing. |
| `voice-compose` | "Give the detective a voice" | Wraps `generate_voice.js`. Attaches to the character node in place. |
| `groups-compose` | "Group these as Scene 2", "Frame the character refs" | Arranges related nodes and wraps them in visible canvas frames. |

Two more primitives — taking a note ("take a note", "jot down", "remember that") and summarizing the canvas ("what do we have?", "show the graph") — are tiny enough that they live inline in `agent-templates/PROJECT_AGENT.md` instead of as separate skill folders.

## Authoritative recipes

The reference table above is the at-a-glance view. Each skill's full recipe — when to invoke, what arguments to pass, what edge cases to watch for — lives in its own SKILL.md file:

- [`skills/script-compose/SKILL.md`](../skills/script-compose/SKILL.md)
- [`skills/story-to-video-workflow/SKILL.md`](../skills/story-to-video-workflow/SKILL.md)
- [`skills/image-compose/SKILL.md`](../skills/image-compose/SKILL.md)
- [`skills/video-compose/SKILL.md`](../skills/video-compose/SKILL.md)
- [`skills/voice-compose/SKILL.md`](../skills/voice-compose/SKILL.md)
- [`skills/groups-compose/SKILL.md`](../skills/groups-compose/SKILL.md)

The SKILL.md files are also the source of truth your AI agent reads — keep them updated, not this doc.

## First session

In a new project, drop these into the terminal:

> *"Design Detective Morris — weathered mid-40s homicide detective, noir style."*
>
> *"Give him a voice — gravelly, smoke-stained baritone."*
>
> *"Now a 6-second clip of Morris standing in the rain outside a diner, neon reflections."*
>
> *"Take a note: morgue scene opens with cold blue light."*

Each generation lands as a node, edges show provenance, assets mirror into `projects/<slug>/assets/`. Open the **Timeline** tab to play clips back as a reel.

## Adding a new skill

See [skills/CLAUDE.md](../skills/CLAUDE.md) for the authoring contract: SKILL.md body ≤500 lines, reference files one level deep, third-person description in frontmatter, etc. Claude users rerun `./scripts/setup --agent claude` after adding a skill; project-local `.agents/skills/` symlinks are created or healed by the viewer for every project.

## Parallel calls

When you ask the agent for multiple independent things at once ("design three character variations" or "generate three images of the diner from different angles"), pai-pro fires them concurrently. Three independent images render in ~20s, not ~60s. The *Parallel calls* rule in [agent-templates/PROJECT_AGENT.md](../agent-templates/PROJECT_AGENT.md) is the agent-side contract.
