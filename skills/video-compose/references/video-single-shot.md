# Video — single-shot prompt construction

For one polished cinematic clip. Patterns 1, 2, 3 dispatch here for polish.

## When to skip

A quick T2V request where a direct sentence works ("a runner at sunset, slow dolly-in"). Don't add the bracket scaffold reflex — direct prose is faster and produces the same result.

## Slot-by-slot bracket scaffold

For ordinary single-shot polish (non-storyboard), choose emotion, power holder, and key visual first, then fill:

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
- **Spoken lines** — copy script/shot/user dialogue and VO verbatim. Bind each quoted line to the intended character and, when available, the matching `@AudioN` timbre or final-read ref.
- **Sound / Atmosphere** — ambient + action SFX + music, or `No Music`.
- **Negative** — closing line every time for brand / portrait work.

## Adjacent roles

Pattern-specific notes (the role vocabulary itself is in SKILL.md):

- **Lip-sync:** character voice sample uses *`Use @Audio1 as the voice/timbre reference only. Speak the quoted line exactly once, no echo, no repeated reads.`* Final line audio uses *`Use @Audio1 for timing, cadence, and voice. Keep the words unchanged.`* Never `@Image1 says`; write `the character in @Image1 says`.
- **Camera-move source:** borrow camera grammar from `@Video1` without re-rendering the source.

## Example

```
[Style] Intimate close-up, 50mm prime, shallow DOF, handheld, subtle, cool window light.
[Duration] 6 seconds
[Scene] Rainy apartment hallway at night, elevator glow behind the character.
[Character] The character in @Image1, same face and wardrobe.
[Shot]
  Visuals: Medium close-up; her eyes lock on someone off-camera.
  Action: She says exactly: "Stay with me." Use @Audio1 as the voice/timbre reference only. Speak the quoted line exactly once, no echo, no repeated reads.
  Sound / Atmosphere: rain on glass, elevator hum. No Music.
[Negative] no captions, watermarks, distortion, stretching.
```

## What to lock vs. what to change

- **Lock from refs:** identity, wardrobe/state variant, location/detail variant, lighting state.
- **The prompt carries:** the action, the camera beat, the atmosphere, the sound design.
- Don't re-describe what's already in `@Image1` — name the role and let the ref bind it.

## Troubleshooting

- **Output looks generic / vague** — Shot.Visuals or Action under-described; add concrete sensory cues.
- **Identity drifts** — character image ref missing, or the prompt re-describes the character; replace re-description with `@Image1` reference.
- **Camera does the wrong thing** — Style or Shot has conflicting instructions ("static camera" + "orbit shot"). Pick one.

## Fallback branch

When the user's ask doesn't fit a slot — e.g., a clip with ambiguous framing, or a creative experiment that doesn't have a clear "scene" — default rule: describe the resulting frame, not the editor process. Tell the model what the viewer sees, not what tool did it.
