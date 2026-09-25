# `cawcut vn` capability reference

This file is the authority for what the VN skill can execute. All operations
are local. Project commands accept `--json`; changing project commands accept
`--project <dir>`, defaulting to the current directory only when it contains
`brief.json`.

## Windows PowerShell: redirecting stderr can abort the script

The CLI writes results to stdout, and progress, warnings and errors to stderr. Windows
PowerShell turns a native program's stderr into an ErrorRecord as soon as that stream is
redirected — `2>&1` and `2>$null` both count — and under `$ErrorActionPreference = 'Stop'` the
record is terminating. Measured: `cawcut vn project show 2>$null` aborts the script on a progress
line that reported no failure at all, while the same command without a redirect runs fine.

When driving the CLI from PowerShell:

- Leave stderr alone and read the result from stdout: `$out = cawcut vn project show --json`.
- If stderr has to be captured or silenced, relax the preference around the call and restore it:

  ```powershell
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = cawcut vn project show --json 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  ```

- Judge failure by `$LASTEXITCODE`, never by whether anything appeared on stderr.
- `--json` silences progress but not errors: a failing command still writes to stderr, so the
  wrapper above is what makes the failure path safe.
- cmd.exe, Git Bash, macOS and Linux shells are unaffected.
## Capability boundary

Supported rough-cut operations:

- Create a `9:16`, `16:9`, or `1:1` project, or edit a copied draft.
- Append images and MP4/MOV/M4V videos to one main track.
- Fill the canvas by default, or preserve the complete source frame on request.
- Set image duration and video source in/out trim.
- Add background music and uploaded sound effects with timeline position,
  source in/out trim, duration, and volume.
- Add semantic title, subtitle, or caption text with timeline position and
  duration, each with a preset default font and point size. Optionally
  override the font (a system font, a VN built-in font, or an imported
  third-party font file) and the point size.
- Import one or more `.srt` files as VN subtitle objects, at their own
  timings, optionally shifted as a block.
- Set one supported leaving (outgoing) transition per main-track clip
  boundary.
- Set a supplied PNG as the explicit VN photo cover.
- Inspect and validate the resulting draft, package it as `.vn`, optionally
  open it, or install it into the local VN draft library.

Not supported:

- Delete, reorder, replace, or edit an existing timeline item in place. A
  clip's **transition** is the one exception — `set-transition` changes it in
  place without a rebuild (see Transition model below).
- Multiple visual tracks, overlays, picture-in-picture, manual crop/reframe, arbitrary
  position, speed changes, filters, color correction, or keyframe animation.
- Custom text color, alignment, stroke, or position.
- Audio fade, ducking, beat detection/sync, recording, or access to
  VN's built-in music/SFX catalogs.
- Automatic speech recognition, or styled captions.
- Transcribing audio into subtitles: `add-srt` places text you already have,
  it never listens to the media. There is no way to generate an `.srt`.
- Setting subtitle position, so subtitles that overlap in time render on top
  of each other.
- Bilingual subtitle pairing (VN pairs translations by `captionID`, which
  SRT-imported subtitles do not carry).
- **Removing, muting, or replacing the audio a source video already carries.**
  An appended clip always plays its own audio track: there is no per-clip mute,
  detach, or volume control, and `--volume` exists only on `add-audio` /
  `add-sound-effect`, where it scales the *added* track. VN's draft format has a
  `muteMainTracks` flag — every draft the CLI writes fixes it at `false` — but
  no command exposes it, so hand-editing that flag is not a workaround this
  skill may use.
- Separating one element of a source clip's sound from the rest (music vs.
  speech vs. noise, vocal removal, stem separation), or balancing a source
  clip's own audio against added BGM.

Plan within these limits. If a confirmed edit must change item order or remove
an item, rebuild a fresh draft rather than editing JSON.

## Transition model

A transition is the **leaving (outgoing) transition of a clip**: it sits on the
boundary between clip N and clip N+1 and is stored on clip N in the draft.
There is no separate "incoming transition" on clip X — "the transition before
clip X" *is* clip X-1's leaving transition.

- Always name a transition by its boundary (`N → N+1`), never "on clip X".
- "A transition on clip X" resolves to clip X's leaving transition (X → X+1).
  When the user may mean the boundary *before* X (X-1 → X), ask one focused
  question and record the answer in the edit plan.
- The last clip has no leaving transition and must not be given one.

Set every transition with `set-transition` after all clips are appended. It is
the in-place transition path: unlike clip order or content, a wrong transition
is fixed with `set-transition --index N` (`--type none` clears it) and **never**
by rebuilding the draft.

## Common refusals — say it, never simulate it

These are the requests most likely to be waved through as if they had worked.
Say the refusal out loud, in the user's language, before proposing a plan that
would look as though it had been fulfilled.

| The user asks for | What is true | What to offer instead |
|---|---|---|
| "Remove the music / audio that comes with this video." | The clip's own audio always plays; nothing mutes, detaches, or replaces it. | A copy muted outside the skill and re-supplied as a local file. Adding BGM on top is supported, but it plays *alongside* the clip's own audio. |
| "Turn the original sound down, then put my music over it." | No ducking or per-clip audio automation; `--volume` on `add-audio` scales only the added track. | Add the BGM at the volume they want, and say the source audio has to be muted outside the skill first if it must drop. |
| "Keep only the music / cut out just the vocals." | No stem separation of any kind. | Nothing inside this skill — the media has to be re-prepared externally. |
| "Subtitle what they say in the video." | No speech recognition; `add-srt` only places a `.srt` that already exists. | They transcribe the audio elsewhere (or supply an `.srt`), then `add-srt` imports it. |
| "Delete that clip, or move it earlier." | Appends only — no delete, reorder, or in-place edit. | Rebuild a fresh draft from the corrected plan. |
| "Zoom into that part / add a decorative lower third / speed it up." | No crop/reframe, overlays, extra tracks, speed changes, or custom text styling — plain title/subtitle/caption text is supported, styling it is not. | The closest supported shot, transition, duration, or unstyled text; the difference is stated in the edit plan. |

## Checking whether VN is usable

```bash
cawcut vn status [--json]
```

Reports whether the VN app is installed and whether it meets the CLI's minimum
supported version. Two platforms are covered, each with its own install signal
and its own minimum:

| Platform | "Installed" means | Minimum version |
|---|---|---|
| macOS | `/Applications/VN.app` carries the `maccatalyst.com.frontrow.vlog` bundle id | `1.4.0` (build `838`) |
| Windows | a VN uninstall entry exists (HKCU first, then HKLM and its WOW6432Node twin) **and** `vn_editor.exe` is present — at the entry's `InstallLocation`, else `%LOCALAPPDATA%\VN\` | `0.4.1.165` |

A registry key without the executable is a stale uninstall, and reports as not
installed. On any other platform (Linux, …) local VN import is not supported at
all. On those platforms `status.platform` is `"unsupported"`; drafts can still
be built and packed, but opening them requires moving the draft (or its `.vn`)
to a macOS/Windows machine with VN installed.

Treat VN as usable only when `"installed": true` and `"meetsMinVersion"` is
`true` or absent from the JSON; any other combination means the app cannot be
launched right now. Only `vn import --open`, `pack --open`, and `install`
actually need VN usable — every other command on this page is a pure local file
operation and works regardless of whether VN is installed.

## Lightweight preview

```bash
cawcut vn import <files...> [--title <title>] [--open]
```

Use only when the user wants to open source files in VN without assembling a
timeline. It is not a rough-cut project workflow.

- `--title` becomes the manifest's `title` — the name VN gives the project it
  creates. Unlike `init --title` it is optional, and nothing else in this path
  carries a name, so an import without it lands unnamed. Keep it to a few
  words: VN shows it in the project list.

The files and their `manifest.json` are copied into a landing directory that
the `vn://createProject` link points at; `--open` hands that link to the OS
(`open` on macOS, PowerShell `Start-Process` on Windows — not `start`, which
fails in PowerShell). The manifest is identical on both — only
the landing root differs:

| Platform | Landing directory |
|---|---|
| macOS | `~/Library/Containers/maccatalyst.com.frontrow.vlog/Data/tmp/url-scheme-create-project/<id>/` |
| Windows | `%TEMP%\vn-edit-project\<id>\` |

## Discovering fonts

```bash
cawcut vn fonts [--json] [--source system|vn|draft|all] [--query <text>] [--family <name>] [--project <dir>]
```

Lists fonts from up to three sources, merged and deduplicated by PostScript
name (`--source` narrows to one):

- `system` — fonts installed on this machine. Not portable: a shared draft
  falls back on a machine that doesn't have them.
- `vn` — VN's own bundled fonts, read from the installed app on both
  platforms: the macOS app bundle's catalog and ODR language packs, and
  `<install dir>\fonts\` on Windows (the Inter and Noto stack, including the
  CLI's default `Inter-Regular`). Portable — every VN install on that platform
  carries them. The list is empty when VN is not installed, and `--json` then
  carries a `note` saying so; `"vnBuiltinFontsReadable": false` means the
  platform has no catalog at all, which is neither macOS nor Windows.
- `draft` — fonts already imported into `<draft>/Font/` (needs `--project`).
  Portable — the file travels with the draft.

`--query` matches family or PostScript name case-insensitively; `--family`
matches a family name exactly. `--json` returns
`{ fonts: [{ family, style, postscriptName, source, portable }] }` — use it
to drive an `AskUserQuestion` font picker.

## Project commands

### `init`

```bash
cawcut vn project init --title <title> --aspect 9:16|16:9|1:1 [--from <draft-dir>] [--dir <path>]
```

`--title` and `--aspect` are required unless `--from` is used. `--from` copies
an existing draft before editing. The CLI default output is
`~/Downloads/cawcut-vn-projects/<slug>-<id>/`; in pai-pro always override it with
`--dir "$PWD/vn/<title-slug>"` so the draft stays inside the active project.

### `add-clip`

```bash
cawcut vn project add-clip <files...> [--duration S | --trim-start S --trim-end S] [--scale-mode fill|fit] [--width PX --height PX] [--transition type:sec] [--project <dir>]
```

- Images: PNG/JPG/JPEG/GIF/WebP; default duration 3 seconds.
- Videos: MP4/MOV/M4V; duration and dimensions are probed automatically.
- Files append in argument order and are copied into `Asset/`.
- `--scale-mode` defaults to `fill`: images and videos cover the canvas without
  distortion, cropping only the overflow. Use `fit` only when keeping the full
  source frame is more important than avoiding letterbox or pillarbox space.
- Video trim uses source-media seconds. Either bound may be omitted; defaults
  are source start/end. Trim is video-only and cannot combine with `--duration`.
- When video probing fails without trim, explicit `--duration`, `--width`, and
  `--height` can provide fallback metadata. Trim requires successful probing.
- `--transition type:sec` sets the leaving transition of the **last existing
  clip** (the boundary into the first newly appended file), not the new clip.
  **Do not use it** — it is the wrong-boundary footgun this skill routes around.
  Append clips first, then set every boundary explicitly with `set-transition`.
- When present, the same names, defaults, and duration safety checks as
  `set-transition` apply, and it is ignored when the draft has no preceding
  clip.

### `add-audio`

```bash
cawcut vn project add-audio <file> --at S [--duration S | --trim-start S --trim-end S] [--volume 0-1] [--project <dir>]
```

Adds BGM (`mType=0`) under `Music/Custom/`. `--at` is the timeline position.
`--trim-start` and `--trim-end` are source-audio coordinates; either bound may
be omitted and defaults to source start/end. Source trim requires successful
duration probing and cannot combine with `--duration`. Without trim, duration
defaults to the shorter of the remaining main track and the source audio when
the source duration is known. Volume defaults to 1.

`mp3`, `m4a`, `wav` and `flac` are read from the file itself, so trim works on
every platform. Other formats fall back to an external probe — `afinfo` on
macOS, otherwise `ffprobe`, which a stock Windows machine does not have. When
the duration cannot be read, trim is refused outright: offer `--duration`
instead, or ask the user for one of the four formats above.

### `add-sound-effect`

```bash
cawcut vn project add-sound-effect <file> --at S [--duration S | --trim-start S --trim-end S] [--volume 0-1] [--project <dir>]
```

Adds an uploaded SFX (`mType=1`) under `SoundEffect/`. Timeline timing, source
trim, duration probing, and volume match `add-audio`.

### `add-text`

```bash
cawcut vn project add-text "<content>" --type title|subtitle|caption --at S \
  [--duration S] [--font <postscript-name>] [--font-file <path>] [--font-size <pt>] [--project <dir>]
```

`--type` is semantic: `title=2`, `subtitle=1`, `caption=0`; default is
`caption`. Each type carries a default point size and font, taken from VN's
own default-font-size rules:

| Type | Default point size | Default font |
|------|---------------------|--------------|
| `title` | 36 | `Inter-Bold` |
| `subtitle` | 24 | `Inter-Regular` |
| `caption` | 17 | `Inter-Regular` |

**Point sizes are VN's own text-size numbers, shown unchanged by VN.** The
value written into the draft is exactly the number the user reads in VN's
*Font Size* box, so pass the user's number straight through. Nothing in this
pipeline converts between units — see the `--font-size` bullet below.

`--at` is required; duration defaults to 3 seconds. Text is an overlay: it
does not extend the main track or project duration. Only when the requested
timeline explicitly includes a standalone title/end card does it need its own
visual main-track clip, followed by text placed within that clip's time range.

Font options (all optional — omit them to use the type's default):

- `--font <postscript-name>` sets `fontName` to a font already available on
  the machine or in VN (see `cawcut vn fonts`) — a system font, or one of
  VN's own built-in fonts. When it does not match anything in the local
  catalog, the command still succeeds (a warning is printed): `fontName` is a
  free PostScript-name string in the VN format, and VN falls back if it
  cannot resolve it.
- `--font-file <path>` imports a third-party `.ttf`/`.otf`/`.ttc` file into
  `<draft>/Font/` (renamed to its PostScript name) and sets both `fontName`
  and `fontFilePath`. Mutually exclusive with `--font`, except that a
  multi-face `.ttc` requires `--font <postscript-name>` to pick which face to
  import.
- `--font-size <pt>` overrides the type's default point size (a positive
  number, capped at 400). **This is the same number VN's text panel displays in
  its *Font Size* box, so pass the user's value verbatim.** Never convert it to
  or from a canvas-relative "basis": a request for `32` means `--font-size 32`,
  not `92.16` (`32 × 1080 / 375`) and not `11.11` (`32 × 375 / 1080`). VN's own
  presets run from 13 (subtitles) to 54, so a request far outside that range is
  usually a unit mistake — confirm with the user before running the command
  rather than rescaling it yourself.

A font from `--font` alone (no `--font-file`) is **not portable**: it relies
on the font already being present wherever the draft is opened. Only fonts
under `<draft>/Font/` (imported via `--font-file`) or VN's own built-in fonts
travel with the draft.

### `add-srt`

```bash
cawcut vn project add-srt <files...> [--at S] [--font-size <pt>] \
  [--allow-duplicate] [--force] [--project <dir>]
```

Imports one or more `.srt` files as **VN subtitle objects** — items with
`titleType = 81001` (`FRVE2TitleStickerTypeSRTCaption`) in `mSubtitleItems`,
each carrying its own start time and duration. This is what makes VN show them
as subtitles; adding an `.srt` any other way (for instance through
`vn import`) only files it as a plain asset.

- Cues keep the timings in the file. `--at S` shifts **every** cue later by `S`
  seconds (default `0`); it applies to all files at once.
- Each file's cues are appended in file order, one shared z-layer for the whole
  batch, matching VN's own import.
- The SRT caption preset VN uses is **`Inter-Bold` at 13** with a black stroke,
  anchored to the bottom of the frame. `--font-size` overrides only the point
  size, and takes the same number VN's text panel shows — no unit conversion.
- The parser is deliberately lenient: a missing cue index, `\n` or `\r\n`
  endings, a BOM, a one-digit seconds field, and `.` as the millisecond
  separator are all accepted. Cues with no text, no parsable time range, or an
  end at or before their start are **skipped and counted**, never written —
  an empty cue would also fail `validate`.
- Re-importing into a draft that already has SRT subtitles is refused, because
  the CLI cannot delete subtitle items. `--allow-duplicate` appends a second set
  anyway.
- More than 200 cues prints a warning; more than 500 is refused unless `--force`
  is passed. VN rebuilds the entire project on every edit, so a large subtitle
  track makes the draft slow from that point on — not just during the import.
- Cues that overlap in time, or that run past the end of the main track, only
  print a warning. Subtitles share one anchor, so overlapping cues draw on top
  of each other; and text never extends the project duration.

### `set-cover`

```bash
cawcut vn project set-cover <file.png> [--project <dir>]
```

Sets an explicit VN photo cover (`type=2`), copies the source and final cover
under `Cover/`, and updates the page thumbnail. The input must currently be a
PNG. Without this command, VN uses its automatic first-frame cover.

### `set-transition`

```bash
cawcut vn project set-transition --index N --type <name> [--duration S] [--project <dir>]
```

Sets zero-based clip N's leaving (outgoing) transition into N+1. This is the
only transition entry point this skill uses, and the in-place fixup: a wrong
transition is corrected here without rebuilding the draft (`--type none`
clears it). It rejects the last clip, because there is no following clip, and
rejects durations that VN would disable or clamp for the adjacent clip
lengths. Explicit non-`none` durations must be 0.2–5 seconds; the effective
maximum can be lower for short clips.

| Family (default) | CLI names → VN types |
|------------------|----------------------|
| None (0s) | `none` → 1000 |
| Fade/dissolve (0.8s) | `fade-black` → 1001; `fade-white` → 1002; `dissolve` → 1003; `color-difference-dissolve` → 2001 |
| Slide (0.6s) | `slide-top`, `slide-left`, `slide-bottom`, `slide-right` → 1004–1007 |
| Wipe (0.6s) | `wipe-top`, `wipe-left`, `wipe-bottom`, `wipe-right` → 1008–1011 |
| Blur/reveal (0.8s) | `blur` → 1012; `reveal-vertical`, `reveal-horizontal` → 1013–1014 |
| Zoom/rotate blur (0.8s) | `zoom-blur`, `zoom-blur-reverse`, `rotate-blur`, `rotate-blur-reverse` → 1015–1018 |
| Circle (0.6s) | `circle-crop`, `circle-crop-reverse` → 1019–1020 |
| Pixelate (0.8s) | `pixelate` → 1021 |
| Push (0.6s) | `push-top`, `push-left`, `push-bottom`, `push-right` → 1022–1025 |
| Blink (0.4s) | `blink` → 2011 |
| Shake (0.8s) | `shake-top-left`, `shake-bottom-left`, `shake-bottom-right`, `shake-top-right` → 2021–2024; `shake-top`, `shake-left`, `shake-bottom`, `shake-right` → 2031–2034 |
| Spin/light/rotate zoom (0.8s) | `spin`, `spin-reverse` → 2041–2042; `floodlight` → 2051; `rotate-zoom`, `rotate-zoom-reverse` → 2061–2062 |

`fade` remains accepted as a deprecated compatibility alias for `dissolve`.
Plans and commands must use the unambiguous canonical name `dissolve`; use
`fade-black` or `fade-white` only when the transition through a color is
intended. Prefer the broadly supported 1000-series effects. Color difference,
blink, shake, spin, floodlight, and rotate zoom require VN's Metal-capable
renderer and may be unavailable on older/non-Metal environments.

Script transitions (types 1101/1102) are intentionally unsupported because a
valid draft also needs a `scriptUUID` and its `.vntransition` asset package.

### `show`

```bash
cawcut vn project show [--project <dir>] [--json]
```

Returns project metadata, cover mode, and all main-track clips, video source trim ranges,
transitions, audio kinds/timing/source trim/volume, and text kinds/timing.

### `validate`

```bash
cawcut vn project validate [--project <dir>] [--json]
```

Checks the non-empty gapless main track, media references/files, geometry,
video trim and duration consistency, audio type/path and source-range validity,
and step/brief metadata. Any error returns exit code 1.

### `pack`

```bash
cawcut vn project pack [--project <dir>] [-o <output.vn>] [--open] [--json]
```

Validates and packages the complete draft as `.vn`. The default output is next
to the draft directory. `--open` hands the archive to the platform's file
handler (`open` on macOS, `Start-Process` on Windows) so VN can import it; use
it only after the user confirms opening. Archiving itself works on both
platforms. On Windows, VN PC has not been confirmed to register a `.vn`
handler — if the open fails the CLI says so and points at `cawcut vn import
--open`, which does not need one.

### `install`

```bash
cawcut vn project install [--project <dir>] [--open] [--force] [--json]
```

Special-case macOS delivery path that validates and copies the draft into
VN's local draft library. VN must be quit unless `--force` is used. Use it
only when `pack` does not work for some reason; read
[install.md](install.md) for details and troubleshooting.
