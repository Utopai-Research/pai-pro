import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Everything tracked here reaches the public mirror except `internal/`, which
// export-to-public.sh removes wholesale. So every other tracked file is
// published, and certain terms should not survive into it:
//
//   INTERNAL TOPOLOGY — the names of our own services, repos and deploy
//   targets. Nothing outside the company can act on these, and together they
//   map our private infrastructure for anyone reading.
//
//   COMMERCIAL TERMS — wholesale rates and margin multiples. What we pay and
//   what we keep.
//
// 🔴 THE LIST ITSELF LIVES UNDER internal/, AND THAT IS THE POINT.
//
// It was inline here until 2026-09-11. That made this file — which is
// exported like any other — a verbatim index of every name we were trying to
// withhold: each project, each repo, each service, each task type, in one
// place, annotated. The lint could not catch it either: a gate that matched
// its own rule list would fail on every run, so it exempted itself, and the
// leak was the one thing it was structurally blind to.
//
// Moving the list to internal/export-forbidden-terms.json fixes both halves.
// export-to-public.sh hard-excludes internal/, and trackedFiles() below
// already skips it, so the list is invisible from the public side and from
// the scan. In the public mirror the file is simply absent and these tests
// skip, saying why.
//
// Vendor and model names are deliberately NOT in the list — see the note on
// the allow-listed compatibility doc inside it.
const TERMS_PATH = join(REPO_ROOT, "internal", "export-forbidden-terms.json");

function loadRules() {
  let raw;
  try {
    raw = readFileSync(TERMS_PATH, "utf8");
  } catch {
    return null; // public mirror: internal/ does not exist here
  }
  const parsed = JSON.parse(raw);
  return {
    terms: parsed.terms,
    servicePatterns: parsed.servicePatterns.map((p) => new RegExp(p.source, p.flags)),
    vendorPatterns: parsed.vendorPatterns.map((p) => new RegExp(p.source, p.flags)),
    allowed: new Set(Object.keys(parsed.allowed)),
  };
}

const RULES = loadRules();
const SKIP = RULES
  ? false
  : { skip: "internal/export-forbidden-terms.json is absent — this gate only runs in the private mirror, which is the only place an export can be made from" };

// Wholesale rates, e.g. a dollar figure per million units.
const WHOLESALE_RATE = /\$\d+(?:\.\d+)?\s*\/\s*M\b/g;

// A decimal multiplier sitting near cost / margin / markup / wholesale.
// Deliberately not illustrated with a literal one: this file is exported, and
// the gate now scans itself.
//
// Up to FOUR decimals, and matched against a window rather than one line. Both
// widenings come from real misses: a rate being tuned was written to four
// places, and a wrapped comment put the word "cost" two lines away from the
// multiple it qualified, so a same-line guard read it as harmless.
const MARGIN_MULTIPLE = /\b\d\.\d{1,4}x\b/g;
const MARGIN_CONTEXT = /\b(cost|margin|markup|wholesale|per\s+1m|upstream\s+price)\b/i;
const MARGIN_CONTEXT_WINDOW = 3;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => !p.startsWith("internal/"))
    .filter((p) => !RULES.allowed.has(p))
    // Binary and vendored files carry no prose to leak.
    .filter((p) => !/\.(png|jpe?g|webp|gif|svg|ico|woff2?|mp4|pdf)$/i.test(p))
    .filter((p) => !p.endsWith("package-lock.json"));
}

async function scan(matcher) {
  const hits = [];
  for (const rel of trackedFiles()) {
    let body;
    try {
      body = await readFile(join(REPO_ROOT, rel), "utf8");
    } catch {
      continue; // unreadable / binary
    }
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      const found = matcher(line, i, lines);
      if (found) hits.push(`${rel}:${i + 1}  ${found}  — ${line.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

test("no internal service, repo or environment names in the exported surface", SKIP || {}, async () => {
  const hits = await scan((line) => {
    const term = RULES.terms.find((t) => line.includes(t));
    if (term) return term;
    const svc = RULES.servicePatterns.find((re) => re.test(line));
    return svc ? line.match(svc)[0] : null;
  });
  assert.deepEqual(
    hits,
    [],
    "These name our own infrastructure and would be published verbatim.\n" +
      "Say 'the backend' / 'upstream' / 'the provider' instead:\n  " +
      hits.join("\n  "),
  );
});

test("no upstream vendor or model names in the exported surface", SKIP || {}, async () => {
  const hits = await scan((line) => {
    const m = RULES.vendorPatterns.find((re) => re.test(line));
    return m ? line.match(m)[0] : null;
  });
  assert.deepEqual(
    hits,
    [],
    "These name the companies and models behind the product, or cite a private\n" +
      "backend source file. Say 'upstream' / 'the provider' / 'the vendor':\n  " +
      hits.join("\n  "),
  );
});

test("no wholesale rates or margin multiples in the exported surface", SKIP || {}, async () => {
  const hits = await scan((line, i, lines) => {
    const rate = line.match(WHOLESALE_RATE);
    if (rate) return rate[0];
    const margin = line.match(MARGIN_MULTIPLE);
    // A pixel or dimension ratio is legitimate product prose; a margin is not.
    // Distinguished by the words AROUND it, not by the number itself — see the
    // note on MARGIN_CONTEXT_WINDOW for why one line is not enough.
    if (margin) {
      const from = Math.max(0, i - MARGIN_CONTEXT_WINDOW);
      const window = lines.slice(from, i + MARGIN_CONTEXT_WINDOW + 1).join("\n");
      if (MARGIN_CONTEXT.test(window)) return margin[0];
    }
    return null;
  });
  assert.deepEqual(
    hits,
    [],
    "These state what we pay or what we keep. Prices belong in the file;\n" +
      "the arithmetic behind them belongs with the backend pricing rows:\n  " +
      hits.join("\n  "),
  );
});

test("the allow-list only exempts files that still exist", SKIP || {}, async () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
  );
  for (const rel of RULES.allowed) {
    assert.ok(
      tracked.has(rel),
      `${rel} is exempt from the export-surface lint but no longer tracked — ` +
        "drop it from the rules file so the exemption cannot silently cover a new " +
        "file that happens to take the same path.",
    );
  }
});
