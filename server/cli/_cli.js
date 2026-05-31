// Shared CLI plumbing for cli/. Each generator script imports this to:
//   1. load .env from PAI_REPO_ROOT (handled by lib/paths.js as a side-effect),
//   2. parse argv,
//   3. emit a single JSON line on stdout (success or failure).
//
// Convention for skills: read the JSON line, branch on `ok`. On `ok: false`
// the `klass` field maps 1:1 to the failure-class taxonomy in PROJECT_AGENT.md
// (rate_limited, content_filtered, bad_args, transient_exhausted, infra).

import { parseArgs as nodeParseArgs } from "node:util";
import { PAI_REPO_ROOT } from "../lib/paths.js";

export { PAI_REPO_ROOT };

export function parseArgs(options) {
  try {
    return nodeParseArgs({ options, allowPositionals: false, strict: true }).values;
  } catch (e) {
    emitFailure("bad_args", `argv: ${e.message}`);
    process.exit(2);
  }
}

export function emitSuccess(payload) {
  const obj = { ok: true, ...payload };
  process.stdout.write(JSON.stringify(obj) + "\n");
  return obj;
}

export function emitFailure(klass, message, extra = {}) {
  const obj = { ok: false, klass, message, ...extra };
  process.stdout.write(JSON.stringify(obj) + "\n");
  return obj;
}

export function classify(e) {
  return e?.klass || "infra";
}

export function isoNow() {
  return new Date().toISOString();
}

// Trim a free-form caption / prompt down to a ≤30-char label suitable for
// data.label on a canvas node. Shared by generate_image[_pro] and
// generate_video — the only difference between their old in-file copies
// was whitespace.
export function truncateLabel(s, cap = 30) {
  const cleaned = String(s ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= cap) return cleaned;
  return cleaned.slice(0, cap - 1) + "…";
}
