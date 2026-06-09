# Video — multi-shot prompt construction

For ad / MV / brand pieces, or short scripts that need ≥2 distinct beats inside ONE rendered clip. The 4-section scaffold below is the standard shape.

## When to skip

- Single-beat clips ≤6s — that's a single-shot polish job.
- Scripts where total duration exceeds 15s — split across multiple clips (each its own render).

## Cross-skill source — script shot notes

When script shot notes exist on canvas (from `script-compose`), the 4-section timeline below can be populated from their verbatim bodies instead of fresh prompt design. Locate shot notes structurally via `data.subtype === "shot"` (the truth source); fall back to the legacy `label: "Shot N (a–b s)"` pattern for pre-subtype notes. For each canvas shot note:

- The note's body is a verbatim screenplay slice (slug + action + dialogue).
- Translate the action lines into Visuals + Action wording in the timeline.
- Every dialogue/VO line from the shot note must appear in the video prompt verbatim.
- Preserve dialogue verbatim — write as `[Character] says exactly: "…"`. If a character image ref is also attached, use *"the character in @Image1 says exactly: …"*.
- If an audio ref is a final read, include the text and add: *"Use @Audio1 for timing, cadence, and voice. Keep the words unchanged."* If it is a voice sample, use it only as a timbre anchor.
- Preserve shot ordering — Shot 1 → SHOT 1 in the timeline, etc. Use the incoming `kind: "derived"` edge from the script note (`subtype === "script"`) to group shots that share a parent.

## Cross-skill source — storyboard mosaic

When a storyboard mosaic exists on canvas (`image_result.data.subtype === "storyboard"`; legacy fallback: label `Storyboard` / `Storyboard — Shot <N>` or prompt panel-list evidence), render the entire mosaic as **one 15s video** — every panel becomes one SHOT block in the prompt timeline. The mosaic itself is passed as a reference image (the video model reads the panels visually and follows their order); the mosaic is **not** cropped, and the render is never split into multiple videos per mosaic.

- **Pass the mosaic via `--ref-source-id <mosaic.id>`** alongside the character / location refs originally used to author it. The corner number badges and grid layout make the panel sequence machine-legible.
- **Do not use opening-frame language.** A storyboard ref is a sequence source. Never start with `Opening frame @Image1`.
- **Open the prompt with an explicit directive.** *"Multi-shot sequence built from the storyboard panels in @Image1. Follow the storyboard sequence in panel-number order (cell 1 top-left → cell N×M bottom-right; left-to-right, row-by-row)."* Without this directive, the model may interpret panels out of order.
- **Do not render the mosaic UI.** The panel borders, corner number badges, and grid layout are reading aids only. The output is a normal video sequence.
- **Beat length is constrained by panel count.** 2×2 ≈ 3.75s/panel, 3×3 ≈ 1.67s/panel, 4×4 ≈ 0.94s/panel. Distribute across the 15s budget — beats can vary slightly within the budget if the storyboard implies a rhythm (e.g. slower setup, faster action), but the total stays at 15s.
- **Per-panel timeline content.** Read the mosaic node's `data.prompt` field — it carries the per-panel briefs in its `[PANEL LIST]` section. Each brief becomes one SHOT block; tag each block with `(panel N)` so the panel-to-shot mapping stays legible.
- **Identity continuity.** Re-use the character / location image refs that authored the mosaic (read them from the mosaic node's incoming `kind: "derived"` edges). The mosaic locked identity across cells; the video inherits that lock.
- **Grid ceiling.** 4×4 (16 panels at ~0.94s each) is the practical ceiling — past that, beats are too short to register. Warn the user before rendering a 5×5+ mosaic.
- **Don't drop panels by default.** Use every panel. If the user wants only a subset, SUGGEST splitting the mosaic into per-tile nodes so they can name the ones to keep and re-ask: `node "$PAI_REPO_ROOT/server/cli/split_image.js" --url <mosaic URL> --cols <C> --rows <R> --source-node-id <mosaic.id>`, with `--cols`/`--rows` set to the mosaic's own panel grid (each 1-8; 1x1 rejected). `--url` is an image URL, not a node id — pass the mosaic's `output_url` (from its generation result) or the viewer URL for its `local_path` (`/projects/<id>/<local_path>`). Splitting is the explicit cherry-pick gesture — never something the agent does unprompted to make the math nicer.

## The 4-section scaffold

Write plainly — describe what happens. Prompt length should scale with complexity: add detail only when it locks timing, continuity, audio, camera behavior, or constraints.

**1. Shot-by-shot timeline** — one block per shot. For action/ad/social/story clips, open mid-action in the first 2s:

```
SHOT N (a-bs) — [name]: [visual]. [camera]. [effect]. Sound: [ambient/SFX/music or No Music].
```

Distribute the total `duration` across shots — sub-second beats are fine for fast-cut storyboard previews. Name effects precisely (*"speed ramp (deceleration)"* not *"speed ramp"*). Describe what the viewer sees, not editor tricks.

**2. Effects inventory** — one line listing every distinct effect with count + role:

```
speed ramp ×2 (shots 1, 4) — energy punch-ins; whip pan ×1 (shot 3) — venue transition; bloom flash ×1 (shot 5) — hero reveal.
```

**3. Density map** — call out peaks vs. calm:

```
0-3s HIGH (3 stacked), 3-6s LOW (clean hold), 6-10s HIGH (whip pan + zoom + bloom).
```

**4. Energy arc** — one sentence naming the arc: *open with an impact beat, calm to a hero product shot, resolve on a held close-up.*

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Character image refs:** identity locks across all shots in the timeline.
- **Spoken audio:** assign to shots. Voice sample: *`Use @Audio1 as the voice/timbre reference only; speak the quoted line once, no echo.`* Final read: *`Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`*
- **Camera-move source:** rare — borrow camera grammar into one specific shot.

## What to lock vs. what to change

- **Lock across shots:** wardrobe, props, locations, lighting state, color palette, character identity (via `@ImageN` refs).
- **Vary across shots:** framing, camera move, density, momentary atmosphere.
- The continuity guarantee is in the timeline's wording — any time wardrobe / palette / time-of-day differs between shots, name it explicitly.

## Troubleshooting

- **Density too uniform** — split the timeline into HIGH / LOW blocks; viewers need recovery time between peaks.
- **Effects drift** — use precise names (*"speed ramp (deceleration)"* not *"speed ramp"*). Vague effect names produce vague effects.
- **Character drift across shots** — re-reference the character explicitly per shot (*"the character in @Image1"*); don't assume continuity from one early reference.

## Fallback branch

Non-ad / MV multi-shot (e.g. a multi-shot single scene — two characters in one room across 3 framings): keep the 4-section scaffold but replace "energy arc" with a **narrative arc** — one sentence naming the dramatic progression rather than the rhythm.
