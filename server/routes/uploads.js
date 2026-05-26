// User-dropped / pasted file uploads.
//
// POST /projects/:id/upload (multipart form, field name "file"; repeated for
// multi-file uploads — paste of N files goes through as one HTTP, one addBatch
// mutation, one canvas-state broadcast → the client merge layer sees N fresh
// ids together and routes them through gridPackBatch instead of N spirals.)
//   - Body fields (optional): x, y (drop coords; only honored for single-file
//     uploads — multi-file batches let gridPackBatch on the client choose
//     the layout from lastPlaced / viewport center). Image dimensions are
//     measured server-side via sharp; no need to send them.
//   - Media uploads stage in assets/.tmp/ and let the mutator rename into
//     the per-kind bucket. Non-media (PDFs, text, etc.) become inline notes
//     without file persistence — re-upload if you need the bytes again.
//   - Response: { ok: true, nodes: [...] } — one entry per uploaded file,
//     in submission order.
//
// No upload notice goes to the terminal. Uploads fire at arbitrary times
// while the user is typing — pty.write() landed mid-sentence in their
// input box, and socket.emit("pty:output") collided with the agent TUI
// status-bar redraw. User feedback for uploads already lives in the
// inflight pill + the canvas node landing.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import multer from "multer";
import sharp from "sharp";

import { mutate } from "../canvas_mutator.js";
import { preuploadCanvasUrl } from "../pai_assets_client.js";
import { classifyAttachment } from "../upload_classify.js";
import { tryExtractPdfText } from "../pdf_extract.js";
import { statusForKlass } from "../lib/broadcasters.js";
import { projectDir } from "../lib/paths.js";
import {
  buildUploadedNodePayload,
  sanitizeBasename,
} from "../lib/upload_payload.js";
import {
  withProjectMutationLock,
  writeCanvasPositions,
} from "../lib/writers.js";

const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES },
  // Browsers send Content-Disposition filename= as raw UTF-8 bytes; busboy's
  // default decodes them as latin1, producing mojibake for non-ASCII names.
  defParamCharset: "utf8",
});

export function registerUploadRoutes({ app, io, projects, mutatorHooks }) {
  app.post(
    "/projects/:id/upload",
    upload.array("file", 64),
    async (req, res) => {
      const id = req.params.id;
      const p = projects.get(id);
      if (!p) return res.status(404).json({ ok: false, error: "not found" });
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) return res.status(400).json({ ok: false, error: "missing 'file' field" });
      if (!p.canvasState || !Array.isArray(p.canvasState.nodes)) {
        return res.status(409).json({ ok: false, error: "no canvas state to append to" });
      }

      // dropPos is single-file-only — it only makes sense for the single
      // drag-and-drop path. Multi-file batches let the client's
      // gridPackBatch decide placement, so we skip it.
      const singleFile = files.length === 1;
      const xRaw = singleFile ? parseFloat(req.body?.x) : NaN;
      const yRaw = singleFile ? parseFloat(req.body?.y) : NaN;
      const dropPos =
        Number.isFinite(xRaw) && Number.isFinite(yRaw) ? { x: xRaw, y: yRaw } : null;

      // Stage each media file into assets/.tmp/ first; non-media files become
      // inline notes (no tmp). On any staging failure, roll back the tmps we
      // wrote so far before returning the error.
      const tmpAbsList = [];
      const nodePayloads = [];
      const mimeList = [];
      try {
        for (const f of files) {
          const buf = f.buffer;
          const mime = f.mimetype || "application/octet-stream";
          const originalName = f.originalname || "file";
          const { kind, textual } = classifyAttachment(mime);
          const hasAsset = kind === "image" || kind === "video" || kind === "audio";
          let tmpAbs = null;
          if (hasAsset) {
            const ext = path.extname(sanitizeBasename(originalName)).toLowerCase() || ".bin";
            const tmpFilename = `tmp_${crypto.randomBytes(8).toString("hex")}${ext}`;
            tmpAbs = path.join(projectDir(id), path.posix.join("assets", ".tmp", tmpFilename));
            await fsp.mkdir(path.dirname(tmpAbs), { recursive: true });
            await fsp.writeFile(tmpAbs, buf);
          }
          tmpAbsList.push(tmpAbs);
          mimeList.push(mime);
          const pdfText = mime === "application/pdf" ? await tryExtractPdfText(buf) : null;
          // Measure every uploaded image so each node's aspect_ratio is the
          // real shape — not a 1:1 / 16:9 fallback that throws off canvas
          // placement when N>1 files are pasted at once. On failure the
          // node simply lacks aspect_ratio; placement falls back to the
          // canonical 16:9 default in pickSize.
          let perFileDims = null;
          if (kind === "image") {
            try {
              const meta = await sharp(buf).metadata();
              if (meta.width > 0 && meta.height > 0) {
                perFileDims = { width: meta.width, height: meta.height };
              }
            } catch (e) {
              console.warn(
                `[viewer] sharp.metadata failed for ${originalName} (${mime}): ${e.message}`,
              );
            }
          }
          const payload = buildUploadedNodePayload({
            kind, textual, buf, mime, originalName,
            dims: perFileDims,
            pdfText,
          });
          nodePayloads.push(tmpAbs ? { ...payload, tmp_path: tmpAbs } : payload);
        }
      } catch (e) {
        for (const t of tmpAbsList) if (t) await fsp.unlink(t).catch(() => {});
        console.warn(`[viewer] upload write failed for ${id}:`, e.message);
        return res.status(500).json({ ok: false, error: `local write failed: ${e.message}` });
      }

      const reply = await mutate(
        p,
        {
          request_id: `viewer-upload-${id}-${crypto.randomUUID()}`,
          op: "addBatch",
          payload: { nodes: nodePayloads, edges: [], groups: [] },
          actor: "viewer:upload",
        },
        mutatorHooks,
      );
      if (!reply.ok) {
        for (const t of tmpAbsList) if (t) await fsp.unlink(t).catch(() => {});
        const status = statusForKlass(reply.klass);
        console.warn(`[viewer] upload mutate failed for ${id}: ${reply.message}`);
        return res.status(status).json({ ok: false, error: reply.message });
      }

      const assignedIds = reply.assigned.node_ids;
      const byId = new Map(p.canvasState.nodes.map((n) => [n.id, n]));
      const nodes = assignedIds.map((nid) => byId.get(nid)).filter(Boolean);

      // Hand each minted node's local_path to the asset-preupload step so
      // video-reference reuse downstream is pre-cleared. Index-align mime
      // to the assignedIds order, which matches submission order.
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        const localPath = node?.data?.local_path ?? null;
        if (localPath) preuploadCanvasUrl({ projectId: id, localPath, mimeType: mimeList[i] });
      }

      // Drop position is single-file only; multi-file batches flow through
      // the client's gridPackBatch instead. Sidecar uses its own per-project
      // mutex to stay consistent with workflow.json.
      if (dropPos && singleFile && assignedIds[0]) {
        try {
          await withProjectMutationLock(id, async () => {
            p.canvasPositions.positions[assignedIds[0]] = dropPos;
            await writeCanvasPositions(id, p.canvasPositions);
          });
          io.to(id).emit("canvas-positions", { projectId: id, state: p.canvasPositions });
        } catch (e) {
          console.warn(`[viewer] upload position write failed for ${id}/${assignedIds[0]}:`, e);
        }
      }

      res.json({ ok: true, nodes });
    },
  );

  // Multer error handler: clean error JSON for oversize / parse failures.
  app.use("/projects/:id/upload", (err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          ok: false,
          klass: "bad_args",
          error: `file exceeds ${UPLOAD_LIMIT_BYTES} bytes`,
        });
      }
      return res.status(400).json({ ok: false, klass: "bad_args", error: err.message });
    }
    return res.status(500).json({ ok: false, error: err?.message || "upload failed" });
  });
}
