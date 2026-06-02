# Skill authoring — skills/

Auto-loaded when working under the repo's `skills/` subtree (deployed via symlink to `~/.claude/skills/` and per-project `.agents/skills/`). Canonical source for how to write or edit skills in this repo.

## Editing this file

Keep it tight. Add only rules that change author behavior. Don't restate Anthropic's docs at length — link them. State each rule once.

Shared always-on agent behavior belongs in `agent-templates/PROJECT_AGENT.md`, not in individual skills. Workflow skills may hold longer multi-stage policies that would bloat the always-loaded manual; capability skills may point to generated project `PROJECT_AGENT.md` sections such as "Choosing context", "Draft gate", and "Failure handling", but should not duplicate or override those rules.

## What a skill is

A `.claude/skills/<name>/SKILL.md` is markdown with YAML frontmatter. Claude Code reads the frontmatter (L1) into the system prompt. The body (L2) is read on demand when the description matches the user's turn. Bundled files in the same dir (L3) are read on further demand. See [Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

## When to write a skill vs inline into PROJECT_AGENT.md

Not every recipe needs a separate skill folder. The skill invocation mechanism has overhead (~100-400 tokens per invocation: tool-call envelope + agent reasoning + result wrapper). For tiny bodies, that overhead exceeds the body itself and progressive disclosure stops paying off.

**Rule of thumb: ~30-50 lines of body content is the threshold.**

- **Body < 30-50 lines** → inline the recipe directly into `agent-templates/PROJECT_AGENT.md`, next to the routing-table entry that describes WHEN to use it. Agent executes inline without an invocation hop.
- **Body ≥ 30-50 lines** → create a skill folder. The on-demand body load is worth the invocation overhead.

The threshold isn't a hard cutoff. Consider also:

- **Frequency**: if a recipe fires in nearly every session, inline regardless of size — the body lands in context after first invocation anyway; inlining just removes the round trip.
- **Composability**: if multiple skills will reference the same recipe, leave it as a skill (or extract to a shared reference file).
- **Versioning**: if the recipe evolves independently of the operating manual, keep it as a skill.

When in doubt, tilt inline. Easier to extract a skill from inlined content later than to inline a skill that grew without good reason.

## Hard rules (don't relax without explicit user approval)

1. **SKILL.md body ≤500 lines.** Move verbose templates / per-domain detail to `.claude/skills/<name>/references/<topic>.md`.
2. **Reference files one level deep only.** Never chain `SKILL.md → A.md → B.md` — Claude head-previews nested files and misses content.
3. **Reference files >100 lines start with a table of contents.** Claude sometimes previews rather than reading the whole file.
4. **Each reference link states *when* to follow it.** E.g. `**For the verbatim NxN prompt template**: see [references/storyboard-mosaic.md](references/storyboard-mosaic.md)`.
5. **One skill = one bundle.** No "sub-skill" concept; hierarchy lives in the filesystem inside one skill.

## Frontmatter spec

- `name`: lowercase + digits + hyphens, ≤64 chars, must match directory name, no `anthropic` / `claude`.
- `description`: ≤1024 chars, **third person** ("Generates X…", not "I can…"), covers **WHAT** and **WHEN** to trigger. This is the only field Claude sees by default — make trigger phrases concrete.

## The three progressive-disclosure patterns (from Anthropic docs)

Pick the one that fits when adding new content:

- **Pattern 1 — High-level guide with references.** SKILL.md is a short overview; verbose detail lives in named sibling files (`FORMS.md`, `REFERENCE.md`). Use when the skill has a few discrete sub-topics.
- **Pattern 2 — Domain-specific organization.** A `references/` subdir, one file per domain (`references/character.md`, `references/location.md`). Use when the skill has many parallel patterns. **This is what `image-compose` uses.**
- **Pattern 3 — Conditional details.** Inline the basics in SKILL.md, link out for advanced cases ("**For tracked changes**: see REDLINING.md"). Use when 90% of triggers stay in the basic flow.

## Directory layout

```
.claude/skills/<name>/
├── SKILL.md                # required, has frontmatter, body ≤500 lines
├── references/             # optional; only if SKILL.md grows
│   ├── <topic>.md          # plain markdown, NO frontmatter
│   └── ...
└── scripts/                # optional; only if the skill needs deterministic ops
    └── <name>.py
```

Forward slashes only. No nested skill dirs.

## Pre-commit checklist

- [ ] `description` is specific: WHAT + WHEN triggers, third person, ≤1024 chars
- [ ] `name` matches the directory name
- [ ] SKILL.md body ≤500 lines
- [ ] Each reference link in SKILL.md states *when* to follow it
- [ ] Reference files one level deep (no chained links)
- [ ] Reference files >100 lines start with a TOC
- [ ] No frontmatter in reference files (only SKILL.md has frontmatter)
- [ ] Forward slashes in all paths
- [ ] No time-sensitive info ("before Aug 2025" rots — use "## Old patterns" sections instead)
- [ ] One default per choice point, not a menu of options

## Anti-patterns to avoid

- Verbose explanations of what Claude already knows ("PDF stands for…").
- Multiple options where one default would do — pick a default, mention escape hatch.
- Inconsistent terminology — pick one term and stick to it ("character", not "character/protagonist/lead").
- Magic constants in scripts (`TIMEOUT = 47`) — justify every value or omit it.

## Testing a skill change

1. Save the file.
2. In a fresh Claude Code session in this project, trigger the skill with a phrase from its `description`.
3. Confirm Claude reads the SKILL.md body, follows the recipe, and reads any referenced files only when their trigger condition fires.

## Sources

- Skills overview — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Authoring best practices — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Anthropic engineering blog — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
