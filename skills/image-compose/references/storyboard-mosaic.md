# NxN storyboard mosaic — prompt template

Bracketed-section format for `node "$PAI_REPO_ROOT/server/cli/generate_image.js"` (the standard image tier). Produces ONE composite image of N×M storyboard panels on a single sheet, with a per-cell number badge so downstream video-compose can crop each panel individually for I2V. Layout fidelity is best at ≤4 cells on the standard tier; warn the user before firing anything larger.

## Contents

- Pre-flight: current canvas state
- Per-location iteration
- Prompt template (use verbatim, fill the bracketed parts)
- Style presets (pick one — paste into [STYLE])
- Default per-panel coverage when the user didn't specify

## Pre-flight: current canvas state

This flow needs the current canvas, so per AGENTS.md § "Choosing context", read `./workflow.json` and identify:

- script note (id starts `note_`, label starts `"Script:"`)
- shot notes (label matches `"Shot <N> (<a>–<b>s)"`)
- location nodes (`image_result` with `data.subtype = "location"`)
- character nodes (`image_result` with `data.subtype = "character"`)

Decide how many mosaics to emit:

- **No shot notes (script not analyzed yet).** Behave as the bare mosaic pattern: ONE 2×2 mosaic. Refs are optional — pass any characters / user-uploaded images on the canvas via repeated `--ref-source-id` flags (≤16) for identity lock; if the canvas is empty of refs, pass none.
- **Shot notes exist + ≥1 location node.** ONE mosaic PER LOCATION. Group shots by which location they happen at (slug lines, body context, location names). For each group: refs = `[location.id, …each character.id appearing in the group's shots]` capped at 16; `[SCRIPT SLICE]` = verbatim shot-note bodies in shot-number order.
- **Shot notes exist + 0 location nodes.** ONE mosaic. Say in chat first: `"Storyboard works best with location stills — want me to design them first? I can also storyboard from the script directly."` Unless the user accepts the offer, proceed with a single 2×2 mosaic using the script + character refs.

Default grid: 2×2 unless the user specified otherwise. Before each `generate_image.js` call, announce in chat: `"Generating a 2×2 mosaic for <location_name>"` (per-location case) or `"Generating a 2×2 mosaic."` (single-mosaic case). Don't paste the prompt; one short line.

## Per-location iteration

If the canvas has N locations and shot notes exist, fill the prompt template N times — once per location — and call `generate_image.js` N times. Don't try to combine locations into one mosaic.

## Prompt template (use verbatim, fill the bracketed parts)

```
[STYLE]
[paste one preset block from "Style presets" below — verbatim]

[GRID LAYOUT]
[N]×[M] cells, identical size, separated by thin solid pure opaque BLACK gutters (#000000) between every adjacent cell — horizontally and vertically — and a thin black border around the outer edge of the sheet. Each cell is composed in 16:9 cinematic landscape inside its own bounds. Gutters are thin but clearly visible — like the gap between postage stamps. Each cell fills its space edge-to-edge with the rendered shot, stopping cleanly at the gutter.

[CELL ORDER]
Numbered LEFT-TO-RIGHT, ROW BY ROW: cell 1 = top-left, cell 2 = next-right, …, cell [N×M] = bottom-right.

[PER CELL]
- TOP-LEFT CORNER: a small bold white-on-black number badge showing the cell's panel number (1, 2, 3 …). Roughly 6% of the cell's height. Sans-serif. Placed INSIDE the cell, flush against the top and left gutters, with a few pixels of inset. The badge sits cleanly on top of the rendered shot — no transparency, no glow, no drop shadow.
- CENTER / REMAINDER: the shot rendered per [PANEL LIST] below.
- The number badge is the ONLY text anywhere inside the cell.

[CHARACTER]
The same character(s) appear consistently across every panel where they appear — same face, same build, same age, same wardrobe, same hair, same accurate proportions. [If refs provided] every detail of identity matches the attached reference images. Identity does not drift between cells.

[SCRIPT SLICE]
[Only when shot notes feed this mosaic — paste verbatim shot-note bodies, in shot-number order, for the shots assigned to this location. The panels visualize this verbatim slice; do not paraphrase, do not embellish.]

[SHOT]
[paste the user's scene description verbatim]

[PANEL LIST]
Panel 1 — [framing / beat]
Panel 2 — [framing / beat]
...
Panel [N×M] — [framing / final beat]

[CONTINUITY]
Same wardrobe, same props, same locations across all panels. Same lighting state across every cell — same sun position or key-light direction, same ambient color, same time of day. Same color palette and grading across cells. The style chosen in [STYLE] is locked for every cell — never mix photoreal with sketch. [If a location ref is passed] Same location across all panels — the location matches the attached @Image1 reference exactly.

[NEGATIVE]
No captions, subtitles, panel titles, dialogue text, or any text inside cells other than the corner number badge. No watermarks, logos, or signatures. Gutters are solid pure opaque black — no gradient, no texture, no line art, no labels, no numbering in the gutter. All cells are the same size — no varying frame proportions. No camera/director annotations. No motion arrows or directional overlays unless requested.
```

## Style presets

Pick ONE and paste verbatim into `[STYLE]`. Don't combine. Each preset gives the model concrete render cues, not abstract labels.

**Photoreal cinematic**
```
Photoreal cinematic still. Shot on a full-frame digital cinema camera, fast prime lens, shallow depth of field. Soft key light with ambient fill. Restrained naturalistic color palette. Subtle film grain. Anamorphic feel. No HDR oversaturation, no over-sharpening.
```

**Pencil-and-ink storyboard**
```
Hand-drawn storyboard style. Graphite pencil with black ink wash on cream paper. Loose gestural linework, visible construction lines, minimal value shading. Slight paper grain visible across the sheet. Monochrome or near-monochrome — no full color. Hand-drawn feel, not vector-clean.
```

**Painted concept art**
```
Digital painted concept-art finish. Soft brushwork, atmospheric perspective, painterly edges (not photographic). Restrained palette of 3–5 hues. Visible brush direction in skies and surfaces. Cinematic but illustrative, never photorealistic.
```

## Default per-panel coverage when the user didn't specify

If the user gave a scene description but no per-panel breakdown, propose cinematic shot coverage — wide, medium, close-up, end beat. A 2×2 default coverage:

1. WIDE ESTABLISHING
2. CLOSE-UP on subject's face
3. REACTION / CUT-AWAY to secondary character or environment
4. END BEAT (subject moving toward / away from frame)

Use the user's scene description to fill in the action for each. Don't ask the user to specify all N×M panels themselves unless they explicitly asked for input control.
