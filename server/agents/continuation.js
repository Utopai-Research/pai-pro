import { spawn } from "node:child_process";

export const DEFAULT_CONTINUATION_TIMEOUT_MS = 120_000;
export const DEFAULT_CONTINUATION_BUDGET_USD = 0.25;

export function continuationBudgetUsd(meta = {}, env = process.env) {
  const raw = meta.agent_continuation_budget_usd ?? env.PAI_CONTINUATION_MAX_BUDGET_USD;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_CONTINUATION_BUDGET_USD;
}

export function continuationTimeoutMs(meta = {}, env = process.env) {
  const raw = meta.agent_continuation_timeout_ms ?? env.PAI_CONTINUATION_TIMEOUT_MS;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 1000) return value;
  return DEFAULT_CONTINUATION_TIMEOUT_MS;
}

export function runCommandWithStdin(command, args, {
  cwd,
  env = process.env,
  stdin = "",
  timeoutMs = DEFAULT_CONTINUATION_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ ok: false, code: null, signal: "SIGTERM", timedOut: true });
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, code: null, signal: null, error }));
    child.on("close", (code, signal) => finish({ ok: code === 0, code, signal }));
    child.stdin.end(stdin);
  });
}

export function extractJsonObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty JSON output");
  try {
    return JSON.parse(raw);
  } catch {
    // Continue below.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue below.
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error("no JSON object found");
}
