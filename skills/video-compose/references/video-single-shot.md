# Video — single-shot prompt construction

For one polished cinematic clip. Patterns 1-3 dispatch here for polish.

## When to skip

For quick T2V ("runner at sunset, slow dolly-in"), use direct prose.

## Slot-by-slot bracket scaffold

For ordinary single-shot polish, fill:

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
- **Style** — use concrete camera/palette/lens cues, not generic quality adjectives. *"Shot on a full-frame digital cinema camera, fast prime lens, shallow DOF, naturalistic palette, subtle grain"* beats *"cinematic, high-quality"*.
- **Scene** — location, light, time, weather.
- **Character** — describe or bind canvas character by role (`the character in @Image1`).
- **Shot.Action** — one motion beat, one sentence.
- **Spoken lines** — copy script/shot/user dialogue and VO verbatim. Bind each quoted line to the intended character and, when available, the matching `@AudioN` timbre or final-read ref.
- **Sound / Atmosphere** — ambient + action SFX + music, or `No Music`.
- **Negative** — closing line every time for brand / portrait work.

## Adjacent roles

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

If no slot fits, describe the resulting frame/viewer-visible action, not the editor process.
