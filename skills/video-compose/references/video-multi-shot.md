# Video — multi-shot prompt construction

For ad/MV/brand pieces or short scripts with ≥2 beats inside ONE rendered clip.

## When to skip

- Single-beat clips ≤6s — that's a single-shot polish job.
- Scripts where total duration exceeds 15s — split across multiple clips (each its own render).

## Cross-skill source — script shot notes

When script shot notes exist, populate the timeline from verbatim bodies. Locate by `data.subtype === "shot"`; fallback label `Shot N (a-b s)`.

- The note's body is a verbatim screenplay slice (slug + action + dialogue).
- Translate action into Visuals + Action wording.
- Include every dialogue/VO line verbatim.
- Preserve dialogue verbatim — write as `[Character] says exactly: "…"`. If a character image ref is also attached, use *"the character in @Image1 says exactly: …"*.
- Final read: include text and *"Use @Audio1 for timing, cadence, and voice. Keep the words unchanged."* Voice sample: bind to speaker as timbre anchor with once/no-echo/no-repeat guard.
- Preserve shot order and use `derived` edge from script note to group shared parent shots.

## Cross-skill source — storyboard mosaic

When a storyboard mosaic exists (`subtype:"storyboard"` or legacy evidence), render the whole mosaic as **one 15s video**. Every panel becomes one SHOT block; pass the mosaic as a ref; do not crop or split it.

- Pass the mosaic via `--ref-source-id <mosaic.id>` alongside original character/location refs.
- **Do not use opening-frame language.** A storyboard ref is a sequence source. Never start with `Opening frame @Image1`.
- Open with: *"Multi-shot sequence built from the storyboard panels in @Image1. Follow panel-number order left-to-right, row-by-row."*
- **Do not render the mosaic UI.** The panel borders, corner number badges, and grid layout are reading aids only. The output is a normal video sequence.
- **Beat length:** distribute across 15s; 2×2 ≈3.75s/panel, 3×3 ≈1.67s, 4×4 ≈0.94s.
- **Per-panel content:** read `data.prompt` `[PANEL LIST]`; each brief becomes `SHOT ... (panel N)`.
- **Identity continuity:** re-use character/location refs from mosaic incoming `derived` edges.
- **Grid ceiling.** 4×4 (16 panels at ~0.94s each) is the practical ceiling — past that, beats are too short to register. Warn the user before rendering a 5×5+ mosaic.
- **Don't drop panels.** If user wants a subset, suggest `split_image.js --url <mosaic URL> --cols <C> --rows <R> --source-node-id <mosaic.id>` so they can choose tiles. Splitting is the explicit cherry-pick gesture — never something the agent does unprompted to make the math nicer.

## The 4-section scaffold

Write plainly. Add detail only to lock timing, continuity, audio, camera, or constraints.

**1. Shot-by-shot timeline** — one block per shot; open action/ad/social/story clips mid-action in first 2s:

```
SHOT N (a-bs) — [name]: [visual]. [camera]. [effect]. Sound: [ambient/SFX/music or No Music].
```

Distribute total `duration`; use precise effect names; describe what the viewer sees.

**2. Effects inventory** — one line listing every distinct effect with count + role:

```
speed ramp ×2 (shots 1, 4) — energy punch-ins; whip pan ×1 (shot 3) — venue transition; bloom flash ×1 (shot 5) — hero reveal.
```

**3. Density map** — call out peaks vs. calm:

```
0-3s HIGH (3 stacked), 3-6s LOW (clean hold), 6-10s HIGH (whip pan + zoom + bloom).
```

**4. Energy arc** — one sentence naming the arc.

## Adjacent roles

- **Character image refs:** identity locks across all shots in the timeline.
- **Spoken audio:** assign to shots and speakers. Voice sample: *`Use @Audio1 as the voice/timbre reference only; speak the quoted line exactly once, no echo, no repeated reads.`* Final read: *`Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`*
- **Camera-move source:** rare — borrow camera grammar into one specific shot.

## Examples
```
Timeline:
SHOT 1 (0-2s) — hook: bottle already falling toward wet stone. Locked off macro. Speed ramp (deceleration). Sound: glass rush, sub hit. No Music.
SHOT 2 (2-5s) — catch: the character in @Image1 catches it before impact. Handheld, subtle. Sound: breath, rain.
SHOT 3 (5-8s) — reveal: slow orbit as the label faces camera. Bloom flash. Sound: clean chime.
Effects inventory: speed ramp x1 (shot 1), bloom flash x1 (shot 3).
Density map: 0-2s HIGH, 2-5s LOW, 5-8s MED.
Energy arc: impact save, human beat, product reveal.
Storyboard:
Multi-shot sequence built from the storyboard panels in @Image1; follow panel order and do not render the grid. The detective in @Image2 stays in the same coat and rain-damp lighting.
SHOT 1 (0-5s) — panel 1: he enters the diner. Slow handheld follow. Sound: rain, bell.
SHOT 2 (5-10s) — panel 2: coffee lands beside the clue. Static close-up. Sound: ceramic tap.
SHOT 3 (10-15s) — panel 3: his eyes register the door opening. Slow dolly in. Sound: room tone drops. No Music.
No captions, subtitles, storyboard grid, panel numbers, or guide marks.
```

## What to lock vs. what to change

- **Lock across shots:** wardrobe/state variant, props, detailed location/location variant, lighting state, color palette, character identity (via `@ImageN` refs).
- **Vary across shots:** framing, camera move, density, momentary atmosphere.
- Name wardrobe/palette/time changes explicitly.

## Troubleshooting

- **Density too uniform** — split the timeline into HIGH / LOW blocks; viewers need recovery time between peaks.
- **Effects drift** — use precise names (*"speed ramp (deceleration)"* not *"speed ramp"*). Vague effect names produce vague effects.
- **Character drift across shots** — re-reference the character explicitly per shot (*"the character in @Image1"*); don't assume continuity from one early reference.

## Fallback branch

Non-ad / MV multi-shot (e.g. a multi-shot single scene — two characters in one room across 3 framings): keep the 4-section scaffold but replace "energy arc" with a **narrative arc** — one sentence naming the dramatic progression rather than the rhythm.
