---
version: 0.6.0
name: cawcut-vn
description: |
  The single entry point for every local VN action: opening a lightweight VN
  preview import, or planning and building a rough cut as a local VN
  video-editor draft with `cawcut vn`. Media can be the user's own local
  files supplied directly, or another CawCut skill's generated output — both
  are first-class. Always starts by asking whether the user wants a quick
  preview-and-import or the full editing flow. The editing flow inventories
  supplied media, confirms the project aspect ratio, recommends feasible
  editing styles, resolves missing music or sound effects, presents a
  shot-by-shot edit plan for approval, then assembles and validates the draft
  before asking whether to open it in VN. Use when creating or editing VN
  projects, assembling the user's own photos/clips or generated media into a
  timeline, making a slideshow or rough cut, previewing local files in the VN
  app, or invoking `/cawcut-vn`. Fully local; no login needed. NOT for
  generating source media.
argument-hint: "choose preview-import or editing flow → (editing: inventory media → confirm aspect → choose style → resolve audio → resolve text → confirm cover → approve edit plan → build and validate) → open in VN"
allowed-tools: Bash AskUserQuestion AskQuestion
---

# CawCut VN

The single entry point for every local VN action. The skill owns the VN
conversation and sequencing — whether to open a lightweight preview or build a
rough cut — and the `cawcut vn` CLI owns draft file generation and app
launching.

**Skill files are English-only.** Match the user's language in live replies via
`reply_language`, but keep this file and its references in English.

## pai-pro adaptation

Vendored from CawCut's `cawcut-vn` skill. Two things differ in pai-pro:

- Generation handoffs route through pai-pro's `story-to-video-workflow`
  orchestrator rather than any capability skill directly.
- Drafts are created inside the active project with `--dir` (see phase 8),
  never the CLI's `~/Downloads/cawcut-vn-projects/` default.

## References

- Read [references/capabilities.md](references/capabilities.md) before proposing
  an edit. It is the authority for supported `cawcut vn` operations, flags, and
  editing limits. Never promise an effect that is absent there.
- Read [references/install.md](references/install.md) only when packaging,
  opening, installing, or troubleshooting delivery to the VN app.

Never edit VN JSON by hand. Use only documented `cawcut vn` commands.

## Refusing what VN cannot do

`references/capabilities.md` — its **Not supported** list and **Common
refusals** table — is the boundary. Check the user's request against it before
proposing a style or plan, say the refusal out loud in the user's language then,
and never absorb it silently into a finished draft.

- Name the missing capability plainly ("`cawcut vn` cannot remove or mute the
  audio a source video already carries — no flag does that"), never with a hedge.
- Never let a refusal read as done: no success report for an effect the CLI
  never applied, no describing the source media as if it had been altered, no
  hand-edited JSON to fake it.
- Offer the closest supported behaviour, or say the media must be prepared
  outside this skill and re-supplied as a local file. If nothing close exists,
  refuse outright instead of substituting another effect, and list whatever is
  left unimplemented in the edit plan (phase 7).

## Asking the user

`AskUserQuestion` is for choices, so every call needs **at least two viable
options**. One option is not a question — state it in prose and carry on, never
padding it with a placeholder. Skip the call when the user or an upstream skill
already settled the answer, and use a numbered text menu only when the tool is
unavailable or the choice exceeds its cap.

## Bootstrap

Run this silently before the first `cawcut` operation in an AI session:

1. If a `cawcut` command already succeeded in this session, skip bootstrap.
2. Otherwise run only `cawcut upgrade check --json`. If an update is available,
   run `cawcut upgrade`. If the command is missing, ask the user to install it
   with `npm install -g @ubnt/cawcut`.
3. Never run `cawcut auth login`; VN operations are local.

## Workflow

Follow the phases in order. Reuse facts already established by the user or an
upstream skill; do not ask the same question twice.

### 0. Choose the VN action

This skill is the only place that decides what to do with VN, regardless of
where the media came from:

- The user invokes it directly (`/cawcut-vn` or an equivalent request) and
  supplies their own local image/video/audio files to edit. This is a
  first-class path, not a fallback — do not wait for or require an upstream
  skill's output.
- The pai-pro `story-to-video-workflow` orchestrator hands off unconditionally
  after delivering generated media — it does not pre-filter or ask its own VN
  menu.

1. Run `cawcut vn status` — see `references/capabilities.md` for exactly what
   counts as "usable". Read `platform` as well: `"unsupported"` (the CLI is
   running on Linux, e.g. inside the pai-pro Docker container) is a hard no —
   local preview, `--open`, and `install` can never work there, whatever
   `installed` says. Never offer or attempt them; phase 9 carries the
   host-handoff message.
2. If an upstream skill or the user already stated the action (preview-only,
   or editing), skip the question below and jump straight to the matching
   branch — this is the same decide-once guard used for every other handoff.
3. Otherwise ask with `AskUserQuestion`, localized to `reply_language`:
   - When VN is usable, offer three choices: **open a VN preview and import
     now (recommended for a quick look)**, **enter the editing flow** (build a
     rough cut), **not needed**.
   - When VN is not usable (not installed, or below `VN_MIN_VERSION`), omit
     the preview choice — offer only **enter the editing flow** and **not
     needed**. Do not offer a choice that cannot succeed.

Branches:

- **Preview and import** (only reachable when VN is usable): run
  `cawcut vn import <path_1> <path_2> ... --title "<name>" --open` with every
  supplied local path. Reuse a name the conversation already established (the
  user named the project, or an upstream skill delivered a titled result);
  otherwise name it yourself from what the files are. Keep it to a few words —
  this is the label VN shows in its project list, not a description. Report the
  project URL and asset count. Stop — do not continue into the editing phases
  below.
- **Not needed**: end without running any `cawcut vn` command.
- **Enter the editing flow**: continue to phase 1. This branch never depends
  on VN being installed — drafting and validating a rough cut is fully local
  and does not launch the app.

### 1. Inventory the supplied media

Before creating or changing a project:

- Resolve every supplied path and classify it as image, video, music, or sound
  effect. Record known video and audio durations and meaningful content/order
  cues from the conversation, an upstream generation result when present,
  filenames, or available local inspection tools. Never invent unseen
  content.
- Identify missing, unreadable, duplicate, or unsupported files immediately.
  Note here which videos carry their own soundtrack, and check the user's
  request against the refusal list while the inventory is fresh — an
  unsupported ask must be turned down now, not discovered at build time.
- Summarize the usable inventory to the user when it affects the edit.
- Do not generate replacement media. If generation is required, hand off to
  `story-to-video-workflow`, then resume with its delivered output paths.

### 2. Confirm the project shape

For a new project, explicitly ask the user to choose `9:16`, `16:9`, or `1:1`.
Recommend one from the stated destination, but do not create the project until
the user chooses. Also establish the title, intended platform/use, and target
duration when they are not already known.

For a copy of an existing draft, preserve its aspect ratio unless the user asks
for a new project; the CLI cannot change an existing draft's ratio in place.

### 3. Recommend feasible editing styles

#### Style

Use the inventory and intended use to recommend a style. Offer the recommended
option first and at most two meaningful alternatives:

- **Clean narrative** — chronological or semantic order, longer readable shots,
  restrained `dissolve` transitions. Use `fade-black` or
  `fade-white` only when a transition through color is intended. Fits
  explanatory or product footage.
- **Rhythm montage** — shorter usable video ranges, stronger supported
  transitions, and planned music/SFX cues. Offer only when enough varied
  footage exists; beat detection and automatic beat sync are not supported.
- **Photo story** — paced still images and `dissolve` transitions. Fits
  image-heavy sets.

Adapt these rather than forcing a label. Keep every proposal within the
capability reference: no manual crop/reframe, overlays, speed ramps, styled
typography, audio fades, or other unsupported operations.

Before continuing, use `AskUserQuestion` to let the user select the editing
style, unless they already named or clearly described one. Put the recommended
style first and label it recommended. Do not silently choose a style from the
inventory or defer this choice to the final plan approval — but offer only
styles this inventory can actually support, and when just one fits, say so in
prose instead of firing a one-option question (see **Asking the user**).

#### Canvas fill mode and transitions

Follow `references/capabilities.md` for `--scale-mode` and transition naming —
apply it, do not restate its reasoning here: default to `fill`, and only
switch to `fit` when the user explicitly wants the complete source frame kept
visible (call out the resulting letterbox/pillarbox space in the edit plan).
Do not infer `fit` merely because the source and project ratios look similar —
inspect their actual pixel ratios. Always name the exact canonical transition
type; never write or invoke the deprecated `fade` alias.

A transition belongs to a **boundary**, not a clip (see capabilities.md →
Transition model). Resolve "a transition on clip X" to X → X+1 and always write
it that way. Never use `add-clip --transition`; append every clip first, then
set each boundary with `set-transition --index N`.

### 4. Resolve music and sound effects

Treat background music and sound effects as separate decisions.

- If neither is supplied and the user has not requested silence, ask whether
  they want to provide local BGM, local sound effects, both, or neither.
- If one category is supplied, ask only about the missing category when it
  would materially improve the chosen style.
- If the user wants audio, wait for exact local paths. This skill does not find,
  download, or generate audio by itself.
- Plan audio timing only after the visual sequence and approximate duration are
  known. Do not claim automatic beat alignment.
- When an audio source is longer than the intended placement, select and show
  a source range using `--trim-start` / `--trim-end` (see
  `references/capabilities.md` for exact trim / `--duration` semantics).
- Added audio never replaces audio the source clips already carry. When any
  supplied video has its own soundtrack and the user expects their BGM to
  replace it, refuse that part here (see **Refusing what VN cannot do**) and
  state in the plan that both tracks will play together.

### 5. Resolve text

**A supplied `.srt` is a separate path.** When the user hands over one or more
`.srt` files, do not ask the questions below — those cues already carry their
own wording and timings. Confirm only the placement (whether to shift the whole
block with `--at`), show the cue count and the resulting time span in the edit
plan, and import with `add-srt`. Never retype, re-time, or re-word the cues, and
never split a file into individual `add-text` calls.

Ask whether the user wants text on this edit — this is a plain opt-in
question and belongs in the flow the same way phase 4 asked about music and
sound effects. Use `AskUserQuestion` once the visual sequence and style are
settled: **Add text** / **No text**. Skip the question only when the user
already requested text or supplied text content earlier in the conversation.

If they decline, do not ask again — move on to phase 6 with no text.

If they opt in (or already requested text), gather only what implementing it
needs: content, timing, and type (title/subtitle/caption). Do not invent
wording, timing, or type the user has not given or approved — asking whether
they want text at all is not the same as proposing what it should say.

Text is an overlay and never extends the main-track or project duration. Infer
the intended placement from the user's wording; do not append an end-card clip
by default:

- "during the final N seconds", "in the video's last N seconds", or equivalent
  means overlay the text on the existing final visual clip;
- "for N seconds after all shots", "append a standalone end card", or
  equivalent explicitly sequential wording means append a separate N-second
  visual clip, then place the text over that clip;
- when the wording could mean either, ask one focused timing question before
  presenting the edit plan instead of choosing silently.

Only the second case authorizes an extra main-track clip. Never satisfy an
explicit "after all shots" request by shortening or covering the preceding
shot. Because the CLI cannot create a solid-color clip, require a supplied
end-card image or hand off its generation when that separate clip is requested.

#### Font selection

Every text type has a default font and point size (see
`references/capabilities.md`), but once text is confirmed, ask about the font
too — do not leave it silent. Skip straight to resolving the font when the user
already named or described one; otherwise use `AskUserQuestion` with:

1. **Use the default (Recommended)** — the type's own default font and point
   size; leave `--font`/`--font-file`/`--font-size` unset.
2. **Show me some recommendations** — run `cawcut vn fonts --json` and offer up
   to 4 candidates (label = family + style, closest to the chosen edit style
   first and marked **(Recommended)**).
3. **I'll provide my own font** — a font name, or a local file path via the
   tool's free-text "Other" option (pass it to `--font-file`).

Pass the user's point size through unchanged — it is the number VN's *Font Size*
box shows, never a canvas-relative basis. Font flag semantics and portability
are in `references/capabilities.md`. Whenever the edit plan includes text, list
its font and point size (phase 7).

### 6. Confirm the cover

For a new project, explicitly confirm the cover choice before presenting the
edit plan unless the user already specified it:

- a supplied PNG used as an explicit photo cover via `set-cover`;
- another local PNG the user will provide; or
- VN's automatic first-frame cover.

Use `AskUserQuestion` for this choice. Recommend a suitable supplied image when
one clearly represents the project; otherwise recommend the automatic first
frame. Do not confuse a timeline opening shot with an explicit VN cover.

### 7. Present the edit plan and wait for approval

Before running `init`, `add-clip`, `add-audio`, `add-sound-effect`, `add-text`,
`add-srt`, or `set-transition`, show a concrete plan containing:

- project title, aspect ratio, selected style, cover choice, and estimated total duration;
- ordered shots with source path and image duration or video trim range;
- each transition as an explicit boundary `N → N+1: <type> (<duration>s)`,
  never attached to a single clip;
- only when text was explicitly requested: title/subtitle/caption content
  with start time, duration, font, and point size (the same number VN's text
  panel shows in its *Font Size* box);
- for a supplied `.srt`: the file name, cue count, any cues the parser will
  skip, the resulting time span, and any `--at` shift;
- BGM and SFX paths with timeline start, source trim range, duration, and volume;
- every request this plan does **not** implement, as a named refusal or a
  simplification — including one already refused earlier in the conversation.
  Never let an unimplemented effect sit in the plan as if it were covered.

A compact timeline table is preferred for multi-shot edits. After showing the
complete plan, **always use `AskUserQuestion` for the generation confirmation**;
do not ask for approval only in prose. Offer these choices, localized to the
user's language:

1. **Create from this plan (Recommended)** — approve the displayed plan and
   begin draft generation.
2. **Revise the plan** — collect the requested changes, update the full plan,
   and call `AskUserQuestion` again.
3. **Cancel** — stop without creating or modifying a draft.

Only the first choice authorizes phase 8. Do not treat silence, an unrelated
reply, or a previously stated general request to “make a video” as approval.
This gate is important because the CLI appends clips and does not support
delete, reorder, or in-place clip editing.

### 8. Build and verify the rough cut

After approval:

1. Initialize the draft, or copy an existing draft with `init --from`. Always
   pass `--dir "$PWD/vn/<title-slug>"` so the draft lives inside the active
   pai-pro project instead of the CLI's `~/Downloads` default, and reuse that
   directory for every later `--project` flag.
2. Add clips in approved order, using video source trim where planned.
3. Apply the approved explicit cover when selected. Add BGM and SFX with the approved timeline start and source trim, then set
   every approved transition with `set-transition --index N` (never
   `add-clip --transition`). Add text only when it was explicitly requested and included in
   the approved plan, and import an approved `.srt` with `add-srt` rather than
   replaying its cues through `add-text`.
4. Run `show --json`, compare the result against the approved plan, and correct
   any discrepancy that the CLI can express safely. A transition discrepancy is
   always correctable in place with `set-transition` (`--type none` to clear) —
   never rebuild the draft for a transition. If correction requires removing,
   retiming, replacing, or reordering a clip, create a fresh draft from the
   approved plan.
5. Run `validate`. Do not report completion until it passes. Never silently
   drop a failed asset or substitute an unsupported effect.

### 9. Ask whether to open VN

Only after `show` matches the plan and `validate` passes, run `cawcut vn
status` again — do not reuse the phase 0 result, since the user may have
installed or upgraded VN since then (or phase 0 never checked it, because they
went straight into editing).

- **Platform unsupported (`status.platform === "unsupported"` — Linux, e.g.
  pai-pro in Docker):** never run `--open`, `install`, or `vn import --open`;
  they cannot succeed here. Say plainly that VN cannot be opened in this
  environment — the app runs on macOS and Windows only — then still run
  `cawcut vn project pack --project <dir>` so the `.vn` deliverable exists (if
  `pack` itself fails, relay the CLI's error, for example a missing `zip` on
  Linux). Give the host handoff: the draft is at `<dir>`; copy it (or the
  packed `.vn`) to a macOS/Windows machine with VN installed and open it there
  (`cawcut vn project pack --open`, or double-click the `.vn`). In pai-pro
  Docker that is `docker cp pai-pro:<dir> .` on the host, then opening the
  copy. Do not ask a yes/no open question, and never imply the draft was
  opened.
- **VN usable:** tell the user the rough cut is complete and ask whether to
  open it in VN now.
  - **Yes:** run `cawcut vn project pack --open --project <dir>`. If the open
    fails, the CLI prints why and points at a route that works on that
    platform — relay that rather than retrying the same command.
  - **No:** run `cawcut vn project pack --project <dir>` so the `.vn`
    deliverable is still ready without launching the app.
- **VN not usable (platform supported, but the app is missing or too old):**
  skip the question — there is no working choice to offer. Run `cawcut vn
  project pack --project <dir>` directly, and mention the VN download/upgrade
  link as an optional aside.

Report the draft directory, `.vn` path, duration, clip/audio/text counts, and
any deliberate simplifications. Do not open VN before this final choice.

## Handoff boundaries

- Media can arrive two ways: the user supplies their own local files directly
  (treat this as the normal case, not an edge case), or an upstream skill
  hands off its generated output. When it is the latter, trust its valid
  paths, reuse any settled aspect, intent, or audio decisions, and trust a
  pre-decided action (preview vs. editing) instead of re-asking phase 0. In
  either case, still present the edit plan before timeline mutation.
- A request to only preview a few files, with no rough cut, is phase 0's
  preview-and-import branch — it stays inside this workflow, it does not hand
  off elsewhere.
- Keep commands, flags, and paths in English; converse in `reply_language`.
