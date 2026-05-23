# pai-pro — repo maintainer guide

This file is dev-only. The per-project filmmaking agent's operating manual is at `agent-templates/AGENTS.md` (copied into each project as `projects/<id>/AGENTS.md`).

When you `cd pai-pro && claude` to work on this repo, this is the file Claude Code auto-loads. Per-project Claude sessions exclude it via `claudeMdExcludes` in their own `.claude/settings.local.json`.

## Maintaining this repo

Below is for when you're editing the pai-pro repo itself, not running a project session. Skip if the user is asking for filmmaking work.

### Architecture

- `server/local_viewer.js` — single Node server. Project CRUD, pty spawn for per-project `claude` sessions (cwd = `projects/<id>/`), canvas file watcher, Socket.IO push to the browser. Routes: `/projects` (list / create), `/projects/:id` (bundle), `/projects/:id/activate`, `/projects/:id/positions`, `/projects/:id/group-frames/...`, `/projects/:id/nodes/...`. Socket events: `canvas-state`, `canvas-positions`, `title`, `pending-generations`, `pty:spawned` / `pty:output` / `pty:exit` / `pty:error`.
- `server/scripts/*.js` — synchronous CLI wrappers (image, video, voice, split, switch_project, reel_stitch). Each prints one `{ ok, ... }` JSON line on stdout; non-zero exit with `{ ok: false, klass, message }` on failure. Shared arg parser + emit helpers in `server/scripts/_cli.js`.
- `server/pai_*.js` — PAI Lite clients imported by the CLIs:
  - **Shared HTTP**: `pai_client.js` (auth, retry policy, classified errors, `callGenerate` / `callSubmit` / `pollStatus`).
  - **Image**: `pai_image_client.js`.
  - **Video**: `pai_video_client.js` (upstream payload forwarded byte-for-byte; async submit + poll).
  - **Voice**: `pai_voice_client.js` (PAI raw `tts`, `body_base64`-decoded).
  - **Asset uploads**: `pai_assets_client.js` (`video-generation-assets` raw; chip-UX cache + event-emitter surface — exports `paiAssetEvents`, `snapshotAssetStates`, `seedAssetCache`, `uploadReferenceUrl`, `preuploadReferenceUrl`, `preuploadCanvasUrl`, `uploadReferences`).
  - `local_mirror.js` handles the project-side I/O (write bytes, build viewer URLs, resolve refs to data URIs).
- `web/src/` — React + Vite + React Flow + Socket.IO client.
- `skills/*` — local Claude Code skills. `./setup` symlinks them into `~/.claude/skills/`. Skill-authoring rules live at `skills/CLAUDE.md` (auto-loaded when working in that subtree).
- `agent-templates/AGENTS.md` — canonical per-project agent operating manual. `server/services/projects.js` copies it into `projects/<id>/AGENTS.md` at project create time, alongside a thin `projects/<id>/CLAUDE.md` wrapper that `@import`s it.
- `projects/<id>/` — runtime project data. Gitignored. Created via `POST /projects` or by `local_viewer.js`'s bootstrap on first run. Each contains `workflow.json`, `meta.json`, `assets/{images,videos,audios,notes,.tmp}/`, `canvas_positions.json`, `AGENTS.md`, `CLAUDE.md`, `.claude/`.

### When adding a new media CLI

1. Add a new `pai_<x>_client.js` wrapping `callGenerate({ model: "<pai-raw-model>", payload, ... })` (sync) or `callSubmit + pollStatus` (async). Decode the upstream model's response shape and return `{ bytes, mime, model, durationSeconds, costUsd }` so the CLI is decode-agnostic. See `pai_image_client.js` for the sync template, `pai_video_client.js` for async.
2. Add `server/scripts/generate_<x>.js`. Mirror `generate_image.js`'s shape: import the new `pai_<x>_client.js`, plus `local_mirror.js` (`writeBytesToTmp` or `mirrorToTmp` for byte-vs-URL outputs, plus `viewerUrlForLocalPath` and `buildProviderRefs`), `_cli.js`, `_mutate_helper.js`; parse args; call the client; stage the output in `assets/.tmp/`; hand the absolute path to `postNodeAddBatch({ ..., tmpPath })` (or `postMutation({ op: "addBatch", payload: { nodes: [{ ..., tmp_path }] } })` for multi-node flows); compute the final URL/local_path from the assigned node id + extension; clean up the temp file if the mutation failed or was skipped; print one JSON line including `canvas_mutation`. On failure print `{ ok: false, klass, message }` and exit non-zero.
3. Add the model entry to `server/model_registry.js` and look up `getDefault(kind).id` in the CLI rather than hardcoding the string. Set `hidden: true` if the model is internal (not user-facing as a canvas card, e.g. the asset-upload row).
4. Add a row to the "Media CLIs" table in `agent-templates/AGENTS.md` (and update the Failure-handling table if the CLI surfaces a new class). Existing projects need to re-copy the template to pick up the change — see `### Updating the agent template across existing projects` below.
5. Add a skill `skills/<x>-compose/SKILL.md` per `skills/CLAUDE.md` rules. The recipe should pass `--ref-source-id` (byte refs) and `--source-node-id` (authorship edge) flags rather than asking the agent to write the node itself.
6. Add a row to the Skills-routing table at the top of `agent-templates/AGENTS.md`.

### When adding a new node type

1. Update `web/src/types/canvas.ts` (renderer source of truth). Add a React component to `web/src/pages/CanvasPage/nodes.tsx` and a `NODE_SIZES` entry in `web/src/pages/CanvasPage/nodeData.ts`.
2. Mirror the type into `server/canvas_schema.js`: add the data-validator (`#<type>Data`), the node-validator (`#<type>Node`), add it to `#canvasNode.oneOf`, and add a `NODE_ID_PREFIX` entry + `dataValidatorIdByType` entry in `server/canvas_mutator.js`.
3. Run `npm test` in `server/` — the `real <project>/workflow.json validates against doc schema` test catches drift.
4. Update the "Node grammar (what to put in payloads)" section in `agent-templates/AGENTS.md`. If a media CLI emits this type, update the relevant `<x>-compose` skill recipe.

### When changing the agent template

`agent-templates/AGENTS.md` is the canonical source. Keep it lean — push per-tool recipes and reference detail into the relevant skill; this file is the index. Update the Skills-routing table at the top whenever you add or remove a skill. Existing projects keep their copy until manually re-synced.

### When changing this file

This file is the maintainer guide. Architecture overview, contributor recipes, debugging notes — keep it focused on the dev experience. Per-agent operating instructions belong in `agent-templates/`, not here.

### Debugging

- Viewer / spawn / pty: `start.sh` runs the viewer; `stop.sh` tears it down. The viewer logs to its tmux pane.
- Per-project Claude sessions: JSONLs at `~/.claude/projects/<encoded-cwd>/` (encoding maps `/`, `_`, `.` to `-`). The viewer pulls the latest session id into `meta.claude_session_id` so resume-on-refresh works.
- CLI failures: every CLI prints `{ ok: false, klass, message }`. Replay with the same flags to reproduce.
- Browser ↔ viewer: DevTools → Network → WS frames. Canvas updates fan out as `canvas-state` (after every mutation); sidecar drag positions as `canvas-positions`; in-flight generation placeholders as `pending-generations`; title changes as `title`. The Home grid does NOT subscribe — it re-fetches on mount.
- Mutator audit: `projects/<id>/mutations.jsonl` is an append-only log of every applied mutation (ts, request_id, op, payload, reply). Useful for "who added this node and when".
