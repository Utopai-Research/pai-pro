# Video — single-shot prompt construction

For one polished cinematic clip. Patterns 1, 2, 3 dispatch here for polish.

## Contents

- When to skip
- Slot-by-slot bracket scaffold
- Adjacent roles
- Worked examples
- What to lock vs. what to change
- Troubleshooting
- Fallback branch

## When to skip

A quick T2V request where a direct sentence works ("a runner at sunset, slow dolly-in"). Don't add the bracket scaffold reflex — direct prose is faster and produces the same result.

## Slot-by-slot bracket scaffold

For ordinary single-shot polish (non-storyboard), use this scaffold. Fill each slot deliberately:

```
[Style] one dense one-liner — camera, palette, grain, lens
[Duration] N seconds
[Scene] location, light, time, weather — one paragraph
[Character] one paragraph per character — face, wardrobe, posture
[Shot]
  Visuals: …
  Action: …
  Sound / Atmosphere: …
[Negative] no captions, watermarks, distortion, stretching
```

- **Duration** — also pass `--duration N`; split or chain >15s totals.
- **Style** — concrete equipment cues land better than adjectives. *"Shot on a full-frame digital cinema camera, fast prime lens, shallow DOF, naturalistic palette, subtle grain"* beats *"cinematic, high-quality"*.
- **Scene** — one paragraph; weather and time matter (fog, golden hour, dusk).
- **Character** — name each character's face / build / wardrobe; if there's a canvas character, reference it as `@Image1` and bind by role.
- **Shot.Action** — one motion beat, one sentence.
- **Sound / Atmosphere** — diegetic sounds (rain, footsteps), ambient mood; mention BGM only if you're attaching audio.
- **Negative** — closing line every time for brand / portrait work.

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Lip-sync:** combine character image ref + spoken audio. Use *`The character in @Image1 says exactly: "...". Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`* Never `@Image1 says` (images don't talk).
- **Camera-move source:** borrow camera grammar from `@Video1` without re-rendering the source.

## Worked examples

**1. Character close-up:**

```
[Style] Photoreal cinematic still. Full-frame cinema camera, 50mm prime, shallow DOF, soft key light with ambient fill, restrained palette, subtle film grain.
[Duration] 6 seconds
[Scene] Empty diner at 3am, blue-green fluorescents, drizzle out the window.
[Character] The character in @Image1: middle-aged detective, trench coat, three-day stubble, focused gaze.
[Shot]
  Visuals: Medium close-up on the detective's face, slight tilt down to a coffee cup as he sets it on the formica.
  Action: He looks up slowly, eyes lifting into focus.
  Sound: Distant rain, quiet diner ambience, the faint clink of the cup.
[Negative] no captions, watermarks, distortion, stretching.
```

**2. Brand / product:**

```
[Style] High-fashion product film. Macro lens, 24fps, soft rim light + warm fill, glossy palette, no oversaturation.
[Duration] 5 seconds
[Scene] Matte black turntable against a deep navy seamless backdrop.
[Character] (none — product hero shot.)
[Shot]
  Visuals: A perfume bottle in slow rotation, dust motes catching the rim light.
  Action: One slow 180° rotation; the label glides into frame and stops centered.
  Sound: Low ambient drone, single faint chime as the label centers.
[Negative] no captions, watermarks, distortion, stretching.
```

## What to lock vs. what to change

- **Lock from refs:** identity, wardrobe, location continuity, lighting state.
- **The prompt carries:** the action, the camera beat, the atmosphere, the sound design.
- Don't re-describe what's already in `@Image1` — name the role and let the ref bind it.

## Troubleshooting

- **Output looks generic / vague** — Shot.Visuals or Action under-described; add concrete sensory cues.
- **Identity drifts** — character image ref missing, or the prompt re-describes the character; replace re-description with `@Image1` reference.
- **Camera does the wrong thing** — Style or Shot has conflicting instructions ("static camera" + "orbit shot"). Pick one.

## Fallback branch

When the user's ask doesn't fit a slot — e.g., a clip with ambiguous framing, or a creative experiment that doesn't have a clear "scene" — default rule: describe the resulting frame, not the editor process. Tell the model what the viewer sees, not what tool did it.
