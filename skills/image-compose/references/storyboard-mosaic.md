# NxN storyboard mosaic — prompt template

Bracketed-section format for `generate_image_pro.js`. Produces ONE N×M storyboard sheet with per-cell number badges so `video-compose` can read panel order. Default `--size 2560x1440`.

## Pre-flight: current canvas state

Read `workflow.json` and identify:

- script note (`data.subtype === "script"`; fall back to label starting `"Script:"` for legacy notes)
- shot notes (`data.subtype === "shot"`; fall back to label matching `"Shot <N> (<a>–<b>s)"` for legacy notes)
- location nodes (`image_result` with `data.subtype = "location"`)
- character nodes (`image_result` with `data.subtype = "character"`)

Decide how many mosaics to emit:

- **Shot notes exist:** one mosaic per shot note. Pass `--source-node-id <shot_note_id>`, relevant location/character refs (≤32), and verbatim shot body as `[SCRIPT SLICE]`.
- **No shot notes, one <=15s brief:** one 2×2 mosaic. Pass `--source-node-id <script_note_id>` if applicable plus relevant refs.
- **Longer script/story:** recommend `script-compose` splitting first unless user explicitly asks for overview board.

Missing anchors do not change storyboard unit. If needed, recommend `Make the missing anchor first`; offer `Storyboard from text`.

Default grid 2×2. Announce one short line before each call; don't paste prompt.

## Per-shot-note iteration

If the canvas has N shot notes, fill/call once per shot note. Combine only if user asks for overview board.

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
[Only when a shot/script note feeds this mosaic — paste that one note body verbatim. The panels visualize this verbatim slice; do not paraphrase, do not embellish.]

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

Pick ONE and paste verbatim into `[STYLE]`.

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

If no per-panel breakdown, use 2×2 coverage:

1. WIDE ESTABLISHING
2. CLOSE-UP on subject's face
3. REACTION / CUT-AWAY to secondary character or environment
4. END BEAT (subject moving toward / away from frame)

Use the scene description for each panel. Ask for panel details only when the user wants input control.
