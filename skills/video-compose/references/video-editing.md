# Video — editing prompt construction

For transforming an existing canvas clip. Source video provides composition/motion/subject; prompt names the change.

## Sub-intent decision tree

- **Restyle** — change the visual treatment (regrade, anime, golden hour, monochrome). Preserve composition, motion, subject.
- **Partial edit** — change one element (rain, color, single object, single passerby). Preserve everything else.
- **Replace** — swap a subject or product for another, keep the scene composition.
- **Re-plot** — keep the characters and environment, rewrite the action.
- **Other / doesn't fit** — see Fallback branch.

## Slot-by-slot construction (per sub-intent)

**Restyle:**

```
Re-render @Video1 in [transformation]. Preserve composition, motion, and subject.
```

**Partial edit:**

```
Re-render @Video1 with [single change]. Keep [list of preserves] unchanged.
```

**Replace:**

```
Re-render @Video1 with [old subject/product] replaced by [new subject/product]. Preserve scene, lighting, composition.
```

**Re-plot:**

```
Re-render @Video1 keeping the characters and environment, but [new action].
```

Example: *"Re-render @Video1 keeping the detective and the diner, but the detective stands and walks out instead of staying seated."*

## Adjacent roles

- **Character image ref:** attach for Restyle/Partial when identity may drift.
- **Camera-move source:** only when user explicitly swaps camera grammar.

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

## Fallback branch

When the user's ask doesn't fit Restyle / Partial / Replace / Re-plot — e.g., a creative experiment that mixes modes, or an edit type that's genuinely novel: default rule — describe the *result*, not the motion. Preserve composition unless the user explicitly says otherwise. Name what stays and what changes.
