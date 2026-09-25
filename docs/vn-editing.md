# Editing in VN

[VN](https://vlognow.me/) ([download](https://vlognow.me/download/)) is a
cross-platform video editor for macOS, Windows, iOS, and Android. Its editor
covers the fine-grained work a canvas does not: multi-track editing,
picture-in-picture, text and subtitles, music, effects, AI transitions,
keyframes, speed curves, reverse, frame interpolation, voice change, auto
captions, image editing, and AI tools.

PAI-Pro bundles CawCut's [`cawcut-vn`](../skills/cawcut-vn/SKILL.md) skill, which
bridges the two: once a project has script, image, voice, and clip nodes on the
canvas, the agent hands the landed local files to the `cawcut vn` CLI, which
builds and validates a VN draft you open and edit in VN. It runs fully local — no
CawCut account, no upload.

The skill owns the VN conversation. This page covers the one thing that differs
by environment: **where the draft can actually be opened.**

## Requirements

- The `cawcut` CLI. Docker ships it; host mode installs it yourself:
  `npm install -g @ubnt/cawcut`.
- The VN app, on **macOS** (1.4.0+) or **Windows**.
- Check both with `cawcut vn status` (add `--json` for machine-readable output).

## Host mode (macOS / Windows)

Everything works end to end. The agent builds the draft, then either opens it for
you or packs a `.vn` you can double-click:

```bash
cawcut vn project pack --open --project projects/<id>/vn/<title>
```

## Docker mode (Linux container)

The container is Linux and VN is a macOS/Windows app, so `cawcut vn status`
reports `"platform": "unsupported"`. Inside the container you can still **build
and package** the draft:

```bash
cawcut vn project init --title "..." --aspect 16:9 --dir projects/<id>/vn/<title>
# add-clip / add-audio / add-sound-effect / add-text / add-srt / set-transition / set-cover
cawcut vn project validate --project projects/<id>/vn/<title>
cawcut vn project pack     --project projects/<id>/vn/<title>
```

The container can never run `--open`, `install`, or `vn import --open`. When VN
is unsupported, the agent says so plainly instead of pretending to open the
draft.

### Open it from the host

1. Pack the draft in the container (above) so `<title>.vn` sits next to the draft
   under `projects/<id>/vn/`.
2. Copy it out of the named volume to the host:

   ```bash
   docker cp pai-pro:/repo/projects/<id>/vn/<title>.vn .
   ```

3. Move the `.vn` to a macOS/Windows machine with VN installed and open it —
   double-click, or `cawcut vn project pack --open`.

After VN has opened and saved a draft, edit it further by copying it back out of
VN and re-importing with `cawcut vn project init --from <draft>`, not by pointing
the CLI at the installed copy.

## What the skill refuses

VN's draft format and the CLI are deliberately narrow — no clip delete, reorder,
or in-place edit, no overlays or extra tracks, no crop/reframe or speed changes,
no per-clip mute, no styled captions, and no speech recognition.
[`skills/cawcut-vn/references/capabilities.md`](../skills/cawcut-vn/references/capabilities.md)
is the authority; the agent turns an unsupported request down out loud rather
than faking it.

## See also

- [`skills/cawcut-vn/SKILL.md`](../skills/cawcut-vn/SKILL.md) — the full skill
- [`skills/cawcut-vn/references/capabilities.md`](../skills/cawcut-vn/references/capabilities.md) — supported operations and limits
- [`skills/cawcut-vn/references/install.md`](../skills/cawcut-vn/references/install.md) — delivery paths and troubleshooting
- [Setup and agents](setup.md) — Docker vs host mode
