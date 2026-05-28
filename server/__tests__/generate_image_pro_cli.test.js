import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { PAI_REPO_ROOT } from "../lib/paths.js";

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
  const projectId = `pro_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function makePaiServer() {
  const captures = { generateBodies: [] };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/out.png") {
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/generate") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        captures.generateBodies.push(raw ? JSON.parse(raw) : {});
        const { port } = server.address();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          outcome: {
            media_urls: [{ url: `http://127.0.0.1:${port}/out.png` }],
          },
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

function makeViewerServer({ assignedNodeId = "image_pro_cli_1" } = {}) {
  const captures = { mutateBodies: [], preuploadBodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const parsed = raw ? JSON.parse(raw) : {};
      if (req.url.includes("/mutate")) {
        captures.mutateBodies.push(parsed);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          assigned: { node_ids: [assignedNodeId] },
          version: 3,
        }));
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

test("generate_image_pro.js direct fire writes pro metadata without provider_model", async (t) => {
  const { projectId, dir } = await setupProject(t);
  const pai = await makePaiServer();
  t.after(() => new Promise((resolve) => pai.server.close(resolve)));
  const viewer = await makeViewerServer();
  t.after(() => new Promise((resolve) => viewer.server.close(resolve)));

  const { code, stdout, stderr } = await runCli({
    script: "generate_image_pro.js",
    args: [
      "--prompt", "a clean production still",
      "--size", "2560x1440",
      "--output-format", "png",
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
  const reply = parseReply(stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.model, "image-generation-pro");
  assert.equal(reply.size, "2560x1440");
  assert.equal(reply.aspect_ratio, "16:9");
  assert.equal(reply.image_size, "2K");
  assert.equal(reply.local_path, "assets/images/image_pro_cli_1.png");

  assert.equal(pai.captures.generateBodies.length, 1);
  assert.equal(pai.captures.generateBodies[0].model, "image-generation-pro");
  assert.equal(pai.captures.generateBodies[0].payload.size, "2560x1440");
  assert.equal(pai.captures.generateBodies[0].payload.image, undefined);

  assert.equal(viewer.captures.mutateBodies.length, 1);
  const node = viewer.captures.mutateBodies[0].payload.nodes[0];
  assert.equal(node.type, "image_result");
  assert.equal(node.data.metadata.model, "image-generation-pro");
  assert.equal(node.data.metadata.size, "2560x1440");
  assert.equal(node.data.metadata.aspect_ratio, "16:9");
  assert.equal(node.data.metadata.image_size, "2K");
  assert.equal(node.data.metadata.provider_model, undefined);
  assert.equal(node.data.metadata.size_tier, undefined);
  assert.ok(node.tmp_path.endsWith(".png"));

  assert.equal(viewer.captures.preuploadBodies.length, 1);
  assert.equal(viewer.captures.preuploadBodies[0].local_path, "assets/images/image_pro_cli_1.png");
  assert.equal(viewer.captures.preuploadBodies[0].mime_type, "image/png");
});
