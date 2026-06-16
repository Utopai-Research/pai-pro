import crypto from "node:crypto";

const AUTO_RUN_PREFIX = "auto_";
const VALID_TERMINAL_STATUSES = new Set(["completed", "cancelled", "blocked"]);

export class AutoRunError extends Error {
  constructor(http, klass, message, extra = {}) {
    super(message);
    this.http = http;
    this.klass = klass;
    this.extra = extra;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return +n.toFixed(3);
}

export function newAutoRunId() {
  return AUTO_RUN_PREFIX + crypto.randomUUID().replace(/-/g, "");
}

export function parseBudgetCap(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? +n.toFixed(2) : null;
}

export function publicAutoRun(run) {
  if (!run || typeof run !== "object") return null;
  return {
    id: typeof run.id === "string" ? run.id : null,
    status: typeof run.status === "string" ? run.status : "unknown",
    budget_cap_usd: money(run.budget_cap_usd),
    spent_usd: money(run.spent_usd) ?? 0,
    estimate_usd: money(run.estimate_usd),
    planned_runtime_seconds:
      typeof run.planned_runtime_seconds === "number"
        ? run.planned_runtime_seconds
        : null,
    brief: typeof run.brief === "string" ? run.brief : "",
    created_at: typeof run.created_at === "string" ? run.created_at : null,
    updated_at: typeof run.updated_at === "string" ? run.updated_at : null,
    jobs: Array.isArray(run.jobs)
      ? run.jobs.map((job) => ({
          job_id: typeof job.job_id === "string" ? job.job_id : null,
          kind: typeof job.kind === "string" ? job.kind : null,
          model: typeof job.model === "string" ? job.model : null,
          cost_usd: money(job.cost_usd) ?? 0,
          created_at: typeof job.created_at === "string" ? job.created_at : null,
        })).filter((job) => job.job_id)
      : [],
  };
}

export function createAutoRun({
  budgetCapUsd,
  estimateUsd,
  plannedRuntimeSeconds,
  brief,
} = {}) {
  const cap = parseBudgetCap(budgetCapUsd);
  if (cap === null) {
    throw new AutoRunError(400, "bad_args", "budget_cap_usd must be a positive number");
  }
  const now = nowIso();
  return {
    id: newAutoRunId(),
    status: "approved",
    budget_cap_usd: cap,
    spent_usd: 0,
    estimate_usd: money(estimateUsd),
    planned_runtime_seconds:
      typeof plannedRuntimeSeconds === "number" && Number.isFinite(plannedRuntimeSeconds)
        ? Math.max(1, Math.round(plannedRuntimeSeconds))
        : null,
    brief: typeof brief === "string" ? brief.trim().slice(0, 4000) : "",
    jobs: [],
    created_at: now,
    updated_at: now,
  };
}

export function reserveAutoRunBudget(meta, {
  runId,
  jobId,
  costUsd,
  kind,
  model,
  prompt,
} = {}) {
  if (!meta || typeof meta !== "object") {
    throw new AutoRunError(500, "infra", "project meta is unavailable");
  }
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new AutoRunError(400, "bad_args", "auto run id is required");
  }
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new AutoRunError(400, "bad_args", "job id is required");
  }
  const cost = money(costUsd);
  if (cost === null || cost < 0) {
    throw new AutoRunError(400, "bad_args", "cost_usd must be a non-negative number");
  }

  const run = meta.auto_run;
  if (!run || run.id !== runId) {
    throw new AutoRunError(404, "not_found", "auto run not found");
  }
  if (run.status !== "approved" && run.status !== "running") {
    throw new AutoRunError(409, "conflict", `auto run is ${run.status}`);
  }
  const cap = parseBudgetCap(run.budget_cap_usd);
  if (cap === null) {
    throw new AutoRunError(409, "conflict", "auto run has no valid budget cap");
  }
  if (!Array.isArray(run.jobs)) run.jobs = [];
  const existing = run.jobs.find((job) => job?.job_id === jobId);
  if (existing) {
    return { run, job: existing, already_reserved: true };
  }

  const spent = money(run.spent_usd) ?? 0;
  const nextSpent = money(spent + cost) ?? spent + cost;
  if (nextSpent > cap + 0.0005) {
    throw new AutoRunError(
      402,
      "budget_exceeded",
      `auto budget cap $${cap.toFixed(2)} would be exceeded by this $${cost.toFixed(3)} job; reserved $${spent.toFixed(3)}`,
      { budget_cap_usd: cap, spent_usd: spent, attempted_cost_usd: cost },
    );
  }

  const job = {
    job_id: jobId,
    kind: typeof kind === "string" ? kind : null,
    model: typeof model === "string" ? model : null,
    cost_usd: cost,
    prompt: typeof prompt === "string" ? prompt.slice(0, 1000) : "",
    created_at: nowIso(),
  };
  run.jobs.push(job);
  run.spent_usd = nextSpent;
  run.status = "running";
  run.updated_at = job.created_at;
  return { run, job, already_reserved: false };
}

export function finishAutoRun(meta, { runId, status = "completed" } = {}) {
  if (!VALID_TERMINAL_STATUSES.has(status)) {
    throw new AutoRunError(400, "bad_args", "status must be completed, cancelled, or blocked");
  }
  const run = meta?.auto_run;
  if (!run || run.id !== runId) {
    throw new AutoRunError(404, "not_found", "auto run not found");
  }
  if (VALID_TERMINAL_STATUSES.has(run.status) && run.status !== status) {
    throw new AutoRunError(409, "conflict", `auto run is already ${run.status}`);
  }
  run.status = status;
  run.updated_at = nowIso();
  return run;
}
