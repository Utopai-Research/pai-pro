// System routes — health, model registry, cost estimator, and the
// `/projects` listing (rows-only; the per-project bundle lives in
// routes/projects.js).

import { exec } from "node:child_process";
import { constants as fsc } from "node:fs";
import { promises as fsp } from "node:fs";
import { promisify } from "node:util";

import { getProvider, resolveAgentIdForMeta } from "../agents/index.js";
import { MODELS, getCost } from "../model_registry.js";
import { PROJECTS_DIR } from "../lib/paths.js";
import { viewerUrlForLocalPath } from "../local_mirror.js";

const execAsync = promisify(exec);

async function binaryOk(name) {
  try { await execAsync(`command -v ${name}`); return true; }
  catch { return false; }
}
async function canWrite(dir) {
  try { await fsp.access(dir, fsc.W_OK); return true; }
  catch { return false; }
}

export function rowFor(meta, project) {
  const agentId = resolveAgentIdForMeta(meta);
  const provider = getProvider(agentId);
  const cover = project?.canvasState?.nodes?.find(
    (n) => n.type === "video_result" && !n.data?.archived && n.data?.local_path,
  );
  const coverUrl = cover?.data?.local_path
    ? viewerUrlForLocalPath({ localPath: cover.data.local_path, projectId: meta.id })
    : null;
  return {
    id: meta.id,
    title: meta.title,
    agent_id: agentId,
    agent_label: provider?.label ?? agentId,
    saved: !!(meta.agent_session_id ?? meta.claude_session_id),
    created_at: meta.created_at,
    last_active_at: meta.last_active_at,
    cover_url: coverUrl,
    dangerously_skip_draft_gate: !!meta.dangerously_skip_draft_gate,
  };
}

async function safeCheck(fn) {
  try {
    return (await fn()) === true;
  } catch {
    return false;
  }
}

export function registerSystemRoutes({ app, projects, nodePty, healthChecks = {} }) {
  app.get("/", (_req, res) => {
    res.json({
      service: "pai-pro viewer",
      status: "ok",
      projects: projects.size,
      pty_available: !!nodePty,
    });
  });

  // Real health probe — what compose / k8s should hit.
  // Checks dependency binaries we ship in the Docker image and the
  // writable mutability of the projects volume. Returns 503 on any
  // failure so `restart: unless-stopped` can loop a degraded container.
  app.get("/healthz", async (_req, res) => {
    const checkBinary = healthChecks.binaryOk ?? binaryOk;
    const checkWritable = healthChecks.canWrite ?? canWrite;
    const [ffmpeg, poppler, claude_cli, volume_writable, codex_cli] = await Promise.all([
      safeCheck(() => checkBinary("ffmpeg")),
      safeCheck(() => checkBinary("pdftotext")),
      safeCheck(() => healthChecks.claudeCli ? healthChecks.claudeCli() : getProvider("claude").healthCheck()),
      safeCheck(() => checkWritable(PROJECTS_DIR)),
      safeCheck(() => healthChecks.codexCli ? healthChecks.codexCli() : getProvider("codex")?.healthCheck?.()),
    ]);
    const checks = { ffmpeg, poppler, claude_cli, volume_writable };
    const ok = Object.values(checks).every(Boolean);
    const agents = {
      claude: { binary: claude_cli },
      codex: { binary: codex_cli },
    };
    res.status(ok ? 200 : 503).json({ ok, checks, agents, pty_available: !!nodePty });
  });

  // Renderer reads this once at mount to resolve metadata.model → label.
  // cost_approx_usd is included only when it's a number; functions drop to
  // null so the field is always present. Internal-only models (hidden:
  // true — e.g. the asset-upload row) are filtered out: they have no
  // canvas card or cost chip.
  app.get("/models", (_req, res) => {
    res.json(
      MODELS
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          kind: m.kind,
          label: m.label,
          capabilities: m.capabilities,
          cost_approx_usd: typeof m.cost_approx_usd === "number" ? m.cost_approx_usd : null,
        })),
    );
  });

  // Per-asset cost estimator. Body: { model: "<id>", params: { ... } }.
  // Params shape matches what the registry's cost functions expect
  // (image_size for standard image, size for image pro,
  // resolution+duration for video). Suffixed IDs fall through to a
  // -YYYYMMDD strip before lookup.
  app.post("/cost", (req, res) => {
    const { model, params = {} } = req.body ?? {};
    if (typeof model !== "string" || model === "") {
      return res.status(400).json({ error: "model required" });
    }
    let cost = getCost(model, params);
    if (cost === null) {
      const stripped = model.replace(/-\d{8}$/, "");
      if (stripped !== model) cost = getCost(stripped, params);
    }
    res.json({ cost });
  });

  app.get("/projects", (_req, res) => {
    const rows = Array.from(projects.values())
      .map((p) => rowFor(p.meta, p))
      .sort((a, b) => Date.parse(b.last_active_at) - Date.parse(a.last_active_at));
    res.json(rows);
  });
}
