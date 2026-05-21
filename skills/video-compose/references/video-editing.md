# Video — editing prompt construction

For transforming an existing canvas clip — restyle, partial edit, replace, or re-plot. The source video provides composition / motion / subject; the prompt names the change.

## Contents

- Sub-intent decision tree
- Slot-by-slot construction (per sub-intent)
- Adjacent roles
- What to lock vs. what to change (per sub-intent)
- Combinations to avoid
- Troubleshooting
- Worked example
- Fallback branch

## Sub-intent decision tree

Pick the closest mode based on the user's ask. If none fit, use **Fallback**.

- **Restyle** — change the visual treatment (regrade, anime, golden hour, monochrome). Preserve composition, motion, subject.
- **Partial edit** — change one element (rain, color, single object, single passerby). Preserve everything else.
- **Replace** — swap a subject or product for another, keep the scene composition.
- **Re-plot** — keep the characters and environment, rewrite the action.
- **Other / doesn't fit** — see Fallback branch.

## Slot-by-slot construction (per sub-intent)

Each mode has its own template. Preserve clauses differ — see "What to lock vs. what to change" below.

**Restyle:**

```
Re-render @Video1 in [transformation]. Preserve composition, motion, and subject.
```

Examples:
- *"Re-render @Video1 in golden-hour light with warm highlights and long shadows. Preserve composition, motion, and subject."*
- *"Re-render @Video1 as 2D anime with cel shading and bold outlines. Preserve composition, motion, and subject."*

**Partial edit:**

```
Re-render @Video1 with [single change]. Keep [list of preserves] unchanged.
```

Example: *"Re-render @Video1 with heavy rain and overcast sky. Keep the character's position, wardrobe, and camera movement unchanged."*

**Replace:**

```
Re-render @Video1 with [old subject/product] replaced by [new subject/product]. Preserve scene, lighting, composition.
```

Example: *"Re-render @Video1 with the silver perfume bottle replaced by a matte-black ceramic vase. Preserve scene, lighting, composition."*

**Re-plot:**

```
Re-render @Video1 keeping the characters and environment, but [new action].
```

Example: *"Re-render @Video1 keeping the detective and the diner, but the detective stands and walks out instead of staying seated."*

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Character image ref:** for Restyle and Partial that risk identity drift, attach a canvas character ref so the new render keeps the face.
- **Camera-move source:** rare — only when the user explicitly wants to swap camera grammar during the edit.

## What to lock vs. what to change (per sub-intent)

| Mode | Lock | Change |
|---|---|---|
| Restyle | composition, motion, subject | look (palette, light, style) |
| Partial | everything else | the named element |
| Replace | scene, lighting, composition | swapped subject / product |
| Re-plot | characters, environment | the action |

## Combinations to avoid

- **Re-plot + Replace at once** → identity drift. Do them in two steps: first Replace, then Re-plot the result.
- **Restyle + Re-plot at once** → both preserve clauses get diluted. Do separately if both are needed.

## Troubleshooting

- **Output looks too different from source** — over-described; the prompt is doing redescribe instead of transform. Reduce the prompt to the change clause + preserves clause.
- **Output looks identical to source** — under-described; the change clause is too vague. Be specific about *what* changes.
- **Identity drift in Restyle / Partial** — attach a character image ref; the source video alone may not be enough to lock identity through a style change.

## Worked example — Restyle

User: *"Re-render the detective interrogation clip in golden-hour light."*

```
Re-render @Video1 in warm golden-hour light, with low-angle sun streaming through the blinds and long shadows across the desk. Preserve composition, motion, and subject.
```

Adjacent ref attached: `--ref-source-id <detective.id>` — locks the detective's face through the regrade.

## Fallback branch

When the user's ask doesn't fit Restyle / Partial / Replace / Re-plot — e.g., a creative experiment that mixes modes, or an edit type that's genuinely novel: default rule — describe the *result*, not the motion. Preserve composition unless the user explicitly says otherwise. Name what stays and what changes.
