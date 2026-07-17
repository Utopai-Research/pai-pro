// Full-path spawn tests for cli/generate_image.js (standard image tier).
//
// Cloned from generate_image_pro_cli.test.js: fake PAI server (PAI_API_BASE),
// fake viewer HTTP server for /mutate + /preupload-asset, runCli spawn
// helper, throwaway project under PAI_REPO_ROOT/projects (local_mirror.js
// hardcodes that root, so PAI_PROJECTS_DIR can't redirect the CLIs).
// One deliberate upgrade over the pro harness: the fake viewer routes
// /mutate through the real canvas_mutator, so tests can assert the node
// actually landed in workflow.json and the staged tmp file was renamed
// into assets/images/<node-id>.png.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { PAI_REPO_ROOT } from "../lib/paths.js";
import { mutate, initProjectMutatorState } from "../canvas_mutator.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_DIR = join(__dirname, "..", "cli");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function runCli({ script, args, cwd, env }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [join(CLI_DIR, script), ...args],
      { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReply(stdout) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return JSON.parse(lines[lines.length - 1]);
}

async function setupProject(t) {
  const projectId = `img_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(PAI_REPO_ROOT, "projects", projectId);
  await mkdir(join(dir, "assets", ".tmp"), { recursive: true });
  await mkdir(join(dir, "assets", "images"), { recursive: true });
  await writeFile(
    join(dir, "workflow.json"),
    JSON.stringify({ version: 2, workflow_id: projectId, title: "T", nodes: [], edges: [] }) + "\n",
  );
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ id: projectId, title: "T", created_at: new Date().toISOString() }) + "\n",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { projectId, dir };
}

// generateStatus !== 200 makes every /api/v1/generate attempt fail with that
// HTTP status, so retry classification can be asserted deterministically.
function makePaiServer({ generateStatus = 200 } = {}) {
  const captures = { generateBodies: [] };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/generate") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        captures.generateBodies.push(raw ? JSON.parse(raw) : {});
        res.setHeader("content-type", "application/json");
        if (generateStatus !== 200) {
          res.statusCode = generateStatus;
          res.end(JSON.stringify({ detail: "synthetic upstream failure" }));
          return;
        }
        res.end(JSON.stringify({
          candidates: [{
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: PNG_BYTES.toString("base64") } }],
            },
            finishReason: "STOP",
          }],
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, captures });
    });
  });
}

// Fake viewer that applies /mutate envelopes through the real mutator, so
// workflow.json + the assets/ rename behave exactly like production.
async function makeViewerServer({ dir, projectId }) {
  const p = {
    id: projectId,
    canvasState: JSON.parse(await readFile(join(dir, "workflow.json"), "utf8")),
  };
  initProjectMutatorState(p, {
    workflowPath: join(dir, "workflow.json"),
    mutationLogPath: join(dir, "mutations.jsonl"),
  });
  const captures = { mutateBodies: [], preuploadBodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsed = raw ? JSON.parse(raw) : {};
      if (req.url.includes("/mutate")) {
        captures.mutateBodies.push(parsed);
        mutate(p, { ...parsed, project_id: projectId }).then((reply) => {
          res.statusCode = reply.ok ? 200 : 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(reply));
        }).catch((e) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, klass: "infra", message: e.message }));
        });
        return;
      }
      if (req.url.includes("/preupload-asset")) {
        captures.preuploadBodies.push(parsed);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, captures });
    });
  });
}

test("generate_image.js direct fire lands node + asset and emits one JSON line", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const pai = await makePaiServer();
  t.after(() => new Promise((resolve) => pai.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const prompt = "a quiet mountain lake at dawn";
  const { code, stdout, stderr } = await runCli({
    script: "generate_image.js",
    args: [
      "--prompt", prompt,
      "--project-id", projectId,
    ],
    cwd: dir,
    env: {
      PAI_KEY: "PAI_test",
      PAI_API_BASE: pai.url,
      VIEWER_HOST: "127.0.0.1",
      VIEWER_PORT: String(viewer.port),
    },
  });

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.equal(stdout.trim().split("\n").length, 1, "exactly one stdout JSON line");
  const reply = parseReply(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.model, "image-generation");
  assert.equal(reply.aspect_ratio, "16:9");
  assert.equal(reply.image_size, "2K");
  assert.equal(reply.cost_usd, null);
  assert.equal(typeof reply.duration_seconds, "number");
  assert.equal(reply.local_path, "assets/images/image_1.png");
  assert.equal(reply.output_url, `/projects/${projectId}/assets/images/image_1.png`);
  assert.equal(reply.canvas_mutation.node_id, "image_1");
  assert.equal(reply.canvas_mutation.version, 1);

  // Upstream wire contract.
  assert.equal(pai.captures.generateBodies.length, 1);
  const sent = pai.captures.generateBodies[0];
  assert.equal(sent.model, "image-generation");
  assert.deepEqual(sent.payload.contents[0].parts, [{ text: prompt }]);
  assert.equal(sent.payload.generationConfig.imageConfig.aspectRatio, "16:9");
  assert.equal(sent.payload.generationConfig.imageConfig.imageSize, "2K");
  assert.equal(sent.payload.safetySettings.length, 4);

  // Node landed in workflow.json via the real mutator.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 1);
  const node = wf.nodes[0];
  assert.equal(node.id, "image_1");
  assert.equal(node.type, "image_result");
  assert.equal(node.data.label, prompt);
  assert.equal(node.data.prompt, prompt);
  assert.equal(node.data.local_path, "assets/images/image_1.png");
  assert.equal(node.data.metadata.source, "pai");
  assert.equal(node.data.metadata.task_type, "image_generation");
  assert.equal(node.data.metadata.model, "image-generation");
  assert.equal(node.data.metadata.aspect_ratio, "16:9");
  assert.equal(node.data.metadata.image_size, "2K");
  assert.ok(node.data.metadata.pending_job_id.startsWith("pending_"));
  assert.deepEqual(wf.edges, []);

  // The staged tmp file was renamed into assets/images/ (not copied).
  const assetBytes = await readFile(join(dir, "assets", "images", "image_1.png"));
  assert.deepEqual(assetBytes, PNG_BYTES);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);

  // Envelope carried the pending job id; preupload kicked for the final path.
  const jobId = node.data.metadata.pending_job_id;
  assert.equal(viewer.captures.mutateBodies.length, 1);
  assert.equal(viewer.captures.mutateBodies[0].pending_job_id, jobId);
  assert.equal(viewer.captures.preuploadBodies.length, 1);
  assert.equal(viewer.captures.preuploadBodies[0].local_path, "assets/images/image_1.png");
  assert.equal(viewer.captures.preuploadBodies[0].mime_type, "image/png");

  // Sidecars: durable result written, pending removed.
  const sidecar = JSON.parse(await readFile(join(dir, ".results", `${jobId}.json`), "utf8"));
  assert.equal(sidecar.ok, true);
  assert.equal(sidecar.job_id, jobId);
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});

test("generate_image.js PAI 500 on every attempt exits 1 with transient_exhausted", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const pai = await makePaiServer({ generateStatus: 500 });
  t.after(() => new Promise((resolve) => pai.server.close(resolve)));
  const viewer = await makeViewerServer({ dir, projectId });
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const { code, stdout } = await runCli({
    script: "generate_image.js",
    args: [
      "--prompt", "a doomed request",
      "--project-id", projectId,
    ],
    cwd: dir,
    env: {
      PAI_KEY: "PAI_test",
      PAI_API_BASE: pai.url,
      VIEWER_HOST: "127.0.0.1",
      VIEWER_PORT: String(viewer.port),
    },
  });

  assert.equal(code, 1);
  const reply = parseReply(stdout);
  assert.equal(reply.ok, false);
  // 500 → transient; the single pai_client retry also 500s → re-tagged.
  assert.equal(reply.klass, "transient_exhausted");
  assert.match(reply.message, /after 2 attempts/);
  assert.equal(reply.limits.max_image_refs, 16);
  assert.deepEqual(reply.sent, { ref_source_ids: [], aspect_ratio: "16:9", image_size: "2K" });
  assert.equal(pai.captures.generateBodies.length, 2);

  // No node, no asset, no leftover tmp; failure sidecar persisted.
  const wf = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
  assert.equal(wf.nodes.length, 0);
  assert.equal(viewer.captures.mutateBodies.length, 0);
  assert.deepEqual(await readdir(join(dir, "assets", ".tmp")), []);
  assert.deepEqual(await readdir(join(dir, "assets", "images")), []);
  const results = await readdir(join(dir, ".results"));
  assert.equal(results.length, 1);
  const sidecar = JSON.parse(await readFile(join(dir, ".results", results[0]), "utf8"));
  assert.equal(sidecar.ok, false);
  assert.equal(sidecar.klass, "transient_exhausted");
  assert.deepEqual(await readdir(join(dir, ".pending")), []);
});
