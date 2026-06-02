#!/usr/bin/env node
// CLI wrapper around server/image_split.js. Synchronous — slices the
// source image into cols × rows tiles, mirrors each tile under
// projects/<active>/assets/images/ as its own image_result node,
// prints one JSON line with the node ids.

import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs, emitSuccess, emitFailure, classify, isoNow } from "./_cli.js";
import { splitImage } from "../image_split.js";
import { postMutation } from "./_mutate_helper.js";
import { viewerUrlForLocalPath, readActiveProject } from "../local_mirror.js";

const args = parseArgs({
  url:  { type: "string", short: "u" },
  cols: { type: "string", short: "c" },
  rows: { type: "string", short: "r" },
  // canvas-mutate integration
  "source-node-id":  { type: "string" }, // id of the source image_result node
  "project-id":      { type: "string" },
  "request-id":      { type: "string" },
  "no-canvas-write": { type: "boolean" },
});

if (!args.url)  { emitFailure("bad_args", "missing --url");  process.exit(2); }
if (!args.cols) { emitFailure("bad_args", "missing --cols"); process.exit(2); }
if (!args.rows) { emitFailure("bad_args", "missing --rows"); process.exit(2); }

try {
  const cols = Number(args.cols);
  const rows = Number(args.rows);
  const projectId = args["project-id"] || (await readActiveProject());
  const result = await splitImage({
    url: args.url,
    cols,
    rows,
    projectId,
  });
  const pieces = result.pieces;
  const generatedAt = isoNow();
  const grid = `${cols}x${rows}`;

  let assignedNodeIds = [];
  let canvasFragment = null;
  if (!args["no-canvas-write"]) {
    if (!args["source-node-id"]) {
      canvasFragment = { canvas_mutation_skipped: "no --source-node-id provided" };
    } else {
      const sourceId = args["source-node-id"];
      const nodes = pieces.map((p) => ({
        type: "image_result",
        tmp_path: p.tmp_path,
        data: {
          label: `tile ${p.row},${p.col}`,
          subtype: "split",
          source_id: sourceId,
          grid_position: [p.row, p.col],
          metadata: {
            source: "split",
            task_type: "image_split",
            grid,
            aspect_ratio: p.aspect_ratio,
            generated_at: generatedAt,
          },
        },
      }));
      const edges = pieces.map((_, i) => ({
        from: sourceId,
        to: `$${i}`,
        kind: "derived",
      }));
      const m = await postMutation({
        op: "addBatch",
        payload: { nodes, edges },
        requestId: args["request-id"],
        projectId: args["project-id"],
        actor: "cli:split_image",
      });
      if (m.ok) {
        assignedNodeIds = m.reply.assigned?.node_ids || [];
        canvasFragment = {
          canvas_mutation: {
            node_ids: assignedNodeIds,
            version: m.reply.version,
            request_id: m.request_id,
          },
        };
      } else {
        canvasFragment = {
          canvas_mutation_error: {
            klass: m.reply.klass || "infra",
            message: m.reply.message || `viewer ${m.status}`,
            request_id: m.request_id,
          },
        };
      }
    }
  }
  const enrichedPieces = pieces.map((p, i) => {
    const ext = path.extname(p.tmp_path);
    const nodeId = assignedNodeIds[i] ?? null;
    if (!nodeId) {
      fs.unlink(p.tmp_path).catch(() => {});
      const { tmp_path, ...rest } = p;
      return rest;
    }
    const localPath = `assets/images/${nodeId}${ext}`;
    return {
      row: p.row,
      col: p.col,
      url: viewerUrlForLocalPath({ localPath, projectId }),
      local_path: localPath,
      width: p.width,
      height: p.height,
      aspect_ratio: p.aspect_ratio,
    };
  });

  const payload = {
    source_url: args.url,
    cols,
    rows,
    pieces: enrichedPieces,
    grid,
    generated_at: generatedAt,
    ...(canvasFragment || {}),
  };

  emitSuccess(payload);
} catch (e) {
  emitFailure(classify(e), e.message);
  process.exit(e?.klass === "bad_args" ? 2 : 1);
}
