#!/usr/bin/env node
// CLI to mirror an external URL into a canvas reference node so it can
// be used as `--ref-source-id` for a later generation.
//
// Downloads the URL bytes, classifies the mime, and mints a node via the
// same buildUploadedNodePayload path used by the browser upload route —
// a URL-mirrored asset is indistinguishable from a drag-drop upload
// from the renderer's POV. The original URL lives at metadata.source_url.

import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";

import { parseArgs, emitSuccess, emitFailure, classify } from "./_cli.js";
import {
  writeBytesToTmp,
  viewerUrlForLocalPath,
  readActiveProject,
} from "../local_mirror.js";
import { postMutation } from "./_mutate_helper.js";
import { classifyAttachment } from "../upload_classify.js";
import { buildUploadedNodePayload } from "../lib/upload_payload.js";
import { kickPreupload } from "./_preupload_hook.js";

const args = parseArgs({
  url:                { type: "string", short: "u" },
  kind:               { type: "string" }, // override mime sniff (image|audio|video)
  label:              { type: "string" },
  "project-id":       { type: "string" },
  "request-id":       { type: "string" },
  "no-canvas-write":  { type: "boolean" },
});

function fail(klass, message, extra = {}) {
  emitFailure(klass, message, extra);
}

if (!args.url) {
  fail("bad_args", "missing --url");
  process.exit(2);
}

const VALID_KIND_OVERRIDES = new Set(["image", "audio", "video"]);
if (args.kind && !VALID_KIND_OVERRIDES.has(args.kind)) {
  fail("bad_args", `invalid --kind: ${args.kind} (expected image | audio | video)`);
  process.exit(2);
}

let tmpAbsPath = null;
let exitCode = 0;
try {
  const projectId = args["project-id"] || (await readActiveProject());

  // Fetch the URL. Network / 4xx / 5xx all surface as bad_args with the
  // original URL in the message — the agent's recourse is to fix the
  // URL or pick a different ref.
  let resp;
  try {
    resp = await fetch(args.url);
  } catch (e) {
    fail("bad_args", `fetch failed for ${args.url}: ${e.message}`);
    process.exit(1);
  }
  if (!resp.ok) {
    fail("bad_args", `fetch failed for ${args.url}: ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }
  const ct = resp.headers.get("content-type") || "application/octet-stream";
  // Strip "; charset=…" / "; boundary=…" suffixes for cleaner classify.
  const mime = ct.split(";")[0].trim().toLowerCase();
  const buf = Buffer.from(await resp.arrayBuffer());

  // Kind resolution: explicit --kind override wins; otherwise sniff from
  // the response Content-Type via the same classifier the upload route uses.
  const classified = classifyAttachment(mime);
  const kind = args.kind || classified.kind;
  if (!VALID_KIND_OVERRIDES.has(kind)) {
    // classifyAttachment returns "note" for text/* and unknown mimes.
    // Mirror is media-only — agents can drop text/PDFs via the browser
    // upload UI instead.
    fail("bad_args", `URL classified as ${kind} (mime: ${mime}). Mirror is for media (image, audio, video).`);
    process.exit(2);
  }

  // Derive a sensible originalName so buildUploadedNodePayload's
  // source_filename ends up as the URL's basename, mirroring the
  // drag-drop convention. Falls back to a stamp if the URL has no path.
  let originalName;
  try {
    const u = new URL(args.url);
    originalName = path.basename(u.pathname) || `mirror_${Date.now()}`;
  } catch {
    originalName = `mirror_${Date.now()}`;
  }

  // Measure image dimensions for the renderer's aspect_ratio hint
  // (parallel to what the upload route does at routes/uploads.js).
  let dims = null;
  if (kind === "image") {
    try {
      const m = await sharp(buf).metadata();
      if (m.width > 0 && m.height > 0) dims = { width: m.width, height: m.height };
    } catch {
      /* best-effort; node renders fine without dims */
    }
  }

  // Reuse the upload payload builder — same shape as a drag-drop upload.
  // We then patch metadata.source_url to record provenance; that's the
  // sole field that distinguishes a URL mirror from a UI upload.
  const payload = buildUploadedNodePayload({
    kind, textual: false, buf, mime, originalName, dims,
  });
  if (args.label) payload.data.label = args.label;
  payload.data.metadata.source_url = args.url;

  // Stage bytes to assets/.tmp/; mutator renames into assets/<bucket>/<node>.<ext>.
  const staged = await writeBytesToTmp({ bytes: buf, mimeType: mime, projectId });
  tmpAbsPath = staged.absolute_path;
  const ext = path.extname(tmpAbsPath);

  if (args["no-canvas-write"]) {
    // Confirm fetch + decode worked without minting a node. Caller is
    // responsible for cleaning the tmp file (or letting the next sweep
    // pick it up).
    await fs.unlink(tmpAbsPath).catch(() => {});
    emitSuccess({
      kind,
      source_url: args.url,
      content_type: mime,
      size_bytes: buf.length,
    });
    process.exit(0);
  }

  const m = await postMutation({
    op: "addBatch",
    payload: { nodes: [{ ...payload, tmp_path: tmpAbsPath }], edges: [] },
    requestId: args["request-id"],
    projectId: args["project-id"],
    actor: "cli:mirror_url",
  });
  if (!m.ok) {
    await fs.unlink(tmpAbsPath).catch(() => {});
    fail(m.reply.klass || "infra", m.reply.message || `viewer ${m.status}`);
    process.exit(1);
  }
  const nodeId = m.reply.assigned?.node_ids?.[0] ?? null;
  const bucket = kind === "image" ? "images" : kind === "video" ? "videos" : "audios";
  const localPath = nodeId ? `assets/${bucket}/${nodeId}${ext}` : null;
  const outputUrl = localPath ? viewerUrlForLocalPath({ localPath, projectId }) : null;

  // Pre-clear the asset against PAI's video-generation-assets cache so
  // later --ref-source-id chains don't re-pay the preupload step.
  if (localPath) {
    await kickPreupload({ projectId, localPath, mimeType: mime });
  }

  emitSuccess({
    node_id: nodeId,
    output_url: outputUrl,
    local_path: localPath,
    kind,
    source_url: args.url,
    content_type: mime,
    size_bytes: buf.length,
    canvas_mutation: {
      node_id: nodeId,
      version: m.reply.version,
      request_id: m.request_id,
    },
  });
} catch (e) {
  if (tmpAbsPath) await fs.unlink(tmpAbsPath).catch(() => {});
  fail(classify(e), e.message);
  exitCode = 1;
}
process.exit(exitCode);
