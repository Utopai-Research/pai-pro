# Video — multi-shot prompt construction

For ad / MV / brand pieces, or short scripts that need ≥2 distinct beats inside ONE rendered clip. The 4-section scaffold below is the standard shape.

## Contents

- When to skip
- Cross-skill source — script shot notes
- Cross-skill source — storyboard mosaic
- The 4-section scaffold
- Adjacent roles
- Worked examples
- What to lock vs. what to change
- Troubleshooting
- Fallback branch

## When to skip

- Single-beat clips ≤6s — that's a single-shot polish job.
- Scripts where total duration exceeds 15s — split across multiple clips (each its own render).

## Cross-skill source — script shot notes

When script shot notes exist on canvas (from `script-compose`), the 4-section timeline below can be populated from their verbatim bodies instead of fresh prompt design. Locate shot notes structurally via `data.subtype === "shot"` (the truth source); fall back to the legacy `label: "Shot N (a–b s)"` pattern for pre-subtype notes. For each canvas shot note:

- The note's body is a verbatim screenplay slice (slug + action + dialogue).
- Translate the action lines into Visuals + Action wording in the timeline.
- Every dialogue/VO line from the shot note must appear in the video prompt verbatim.
- Preserve dialogue verbatim — write as `[Character] says exactly: "…"`. If a character image ref is also attached, use *"the character in @Image1 says exactly: …"*.
- If an audio ref exists for that line, still include the exact text and add: *"Use @Audio1 for timing, cadence, and voice. Keep the words unchanged."*
- Preserve shot ordering — Shot 1 → SHOT 1 in the timeline, etc. Use the incoming `kind: "derived"` edge from the script note (`subtype === "script"`) to group shots that share a parent.

## Cross-skill source — storyboard mosaic

When a storyboard mosaic exists on canvas (usually an `image_result` labeled `Storyboard` or `Storyboard — Shot <N>` whose prompt contains `[PANEL LIST]`), render the entire mosaic as **one 15s video** — every panel becomes one SHOT block in the prompt timeline. The mosaic itself is passed as a reference image (the video model reads the panels visually and follows their order); the mosaic is **not** cropped, and the render is never split into multiple videos per mosaic.

- **Pass the mosaic via `--ref-source-id <mosaic.id>`** alongside the character / location refs originally used to author it. The corner number badges and grid layout make the panel sequence machine-legible.
- **Open the prompt with an explicit directive.** *"Multi-shot sequence built from the storyboard panels in @Image1. Follow the storyboard sequence in panel-number order (cell 1 top-left → cell N×M bottom-right; left-to-right, row-by-row)."* Without this directive, the model may interpret panels out of order.
- **Beat length is constrained by panel count.** 2×2 ≈ 3.75s/panel, 3×3 ≈ 1.67s/panel, 4×4 ≈ 0.94s/panel. Distribute across the 15s budget — beats can vary slightly within the budget if the storyboard implies a rhythm (e.g. slower setup, faster action), but the total stays at 15s.
- **Per-panel timeline content.** Read the mosaic node's `data.prompt` field — it carries the per-panel briefs in its `[PANEL LIST]` section. Each brief becomes one SHOT block; tag each block with `(panel N)` so the panel-to-shot mapping stays legible.
- **Identity continuity.** Re-use the character / location image refs that authored the mosaic (read them from the mosaic node's incoming `kind: "derived"` edges). The mosaic locked identity across cells; the video inherits that lock.
- **Grid ceiling.** 4×4 (16 panels at ~0.94s each) is the practical ceiling — past that, beats are too short to register. Warn the user before rendering a 5×5+ mosaic.
- **Don't drop panels by default.** Use every panel. If the user wants only a subset, SUGGEST `split_image(mosaic, cols, rows)` so they can pick tiles by id and re-ask. Splitting is the explicit cherry-pick gesture — never something the agent does unprompted to make the math nicer.

## The 4-section scaffold

Total prompt ≤1000 chars. Write plainly — describe what happens.

**1. Shot-by-shot timeline** — one block per shot:

```
SHOT N (a-bs) — [name]: [visual]. [camera]. [effect].
```

Distribute the total `duration` across shots — sub-second beats are fine for fast-cut storyboard previews (a 4×4 mosaic at 15s is ~0.94s/panel and still legible). Name effects precisely (*"speed ramp (deceleration)"* not *"speed ramp"*; *"digital zoom (scale-in)"* not *"zoom"*). Describe what the viewer sees, not editor tricks (*"the frame scales inward rapidly"* > *"apply keyframed scale"*).

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
- **Spoken audio:** assign to specific shots — *`SHOT 3: the character in @Image1 says exactly: "...". Use @Audio1 for timing, cadence, and voice.`*
- **Camera-move source:** rare — borrow camera grammar into one specific shot.

## Worked examples

**1. A 12s brand piece, 6 shots, with a canvas character `@Image1`:**

```
SHOT 1 (0-2s) — opener: matte black perfume bottle, sharp rim light. Push-in. Speed ramp (deceleration).
SHOT 2 (2-4s) — texture insert: macro on a single dewdrop sliding down the glass. Static. (no effect).
SHOT 3 (4-7s) — model: the character in @Image1 holds the bottle to the light, eyes half-closed. Slow orbit. (no effect).
SHOT 4 (7-9s) — pour: the perfume hits a polished surface, ribbon of liquid arcs. High-speed snap. Speed ramp (acceleration → deceleration).
SHOT 5 (9-11s) — hero: the bottle reassembled on a black pedestal, label centered. Pull-back. Bloom flash.
SHOT 6 (11-12s) — close-out: tight on the engraved cap. Static hold. (no effect).

Effects inventory: speed ramp ×2 (shots 1, 4) — energy beats; bloom flash ×1 (shot 5) — hero reveal.
Density map: 0-2s MED (push + ramp), 2-7s LOW (clean texture, slow orbit), 7-9s HIGH (high-speed pour + ramp), 9-12s MED (pull-back + bloom + held cap).
Energy arc: open on a controlled push-in, settle into texture and model, peak on the pour, resolve on a held hero.
```

**2. A 3×3 storyboard mosaic rendered as one 15s video:**

A 3×3 storyboard mosaic on canvas (authored from `@Image2`, a detective character ref). 9 panels distributed across 15s (~1.67s each). Refs attached: `--ref-source-id <mosaic.id> --ref-source-id <detective.id>` → `@Image1` is the storyboard, `@Image2` is the detective.

```
Multi-shot sequence built from the storyboard panels in @Image1. Follow the storyboard sequence in panel-number order (cell 1 top-left → cell 9 bottom-right; left-to-right, row-by-row). Preserve composition, character identity, and lighting state as established by the storyboard — but render with real camera behavior and grounded motion. The character in @Image2 is the detective.

SHOT 1 (0-1.7s) — diner exterior (panel 1): the detective approaches the diner door at night, neon sign buzzing overhead. Slow handheld follow.
SHOT 2 (1.7-3.3s) — door push (panel 2): the detective pauses at the threshold, hand on the door handle. Static medium-close on his face.
SHOT 3 (3.3-5s) — interior step (panel 3): low-angle on the detective's boots stepping across the checkered floor. Camera tilts up as he walks.
SHOT 4 (5-6.7s) — booth approach (panel 4): medium shot, the detective slides into a booth, removing his coat. Static.
SHOT 5 (6.7-8.3s) — close-up (panel 5): tight on his face as he opens a notebook, eyes scanning the page. Slow push-in.
SHOT 6 (8.3-10s) — waitress (panel 6): the waitress arrives with a coffee, places it on the table. Slight pan to follow.
SHOT 7 (10-11.7s) — sip (panel 7): the detective lifts the cup, takes a slow sip, stares ahead. Static.
SHOT 8 (11.7-13.3s) — entry (panel 8): a new figure pushes the door open in the background. Rack focus from foreground booth to door.
SHOT 9 (13.3-15s) — recognition (panel 9): tight on the detective's eyes as he registers the new arrival. Slow push-in.

Effects inventory: rack focus ×1 (shot 8) — narrative pivot.
Density map: 0-11.7s LOW (observational build-up), 11.7-15s MED (rack focus + recognition).
Energy arc: open with quiet approach, settle into the detective's process, pivot on the new arrival.
```

## What to lock vs. what to change

- **Lock across shots:** wardrobe, props, locations, lighting state, color palette, character identity (via `@ImageN` refs).
- **Vary across shots:** framing, camera move, density, momentary atmosphere.
- The continuity guarantee is in the timeline's wording — any time wardrobe / palette / time-of-day differs between shots, name it explicitly.

## Troubleshooting

- **Density too uniform** — split the timeline into HIGH / LOW blocks; viewers need recovery time between peaks.
- **Effects drift** — use precise names (*"speed ramp (deceleration)"* not *"speed ramp"*). Vague effect names produce vague effects.
- **Character drift across shots** — re-reference the character explicitly per shot (*"the character in @Image1"*); don't assume continuity from one early reference.
- **Prompt over budget (>1000 chars)** — collapse the Density map to a one-liner; trim shot-block adjectives.

## Fallback branch

Non-ad / MV multi-shot (e.g. a multi-shot single scene — two characters in one room across 3 framings): keep the 4-section scaffold but replace "energy arc" with a **narrative arc** — one sentence naming the dramatic progression rather than the rhythm.
