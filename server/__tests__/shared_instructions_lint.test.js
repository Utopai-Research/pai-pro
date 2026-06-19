import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const FORBIDDEN = [
  "run_in_background",
  "BashOutput",
  "CLAUDE.md",
  ".claude",
  "claudeMdExcludes",
  "/tmp/claude-",
  "slash command",
  "Claude Code",
  "claude-",
  "[task-notification]",
];

// Claude-only slash commands. Checked with a word-boundary regex rather than
// a plain substring so a relative-path link such as
// ../../image-compose/references/character-sheet.md doesn't false-positive —
// only a real invocation like "/image-compose" (at line start or after
// whitespace/punctuation) is flagged.
const FORBIDDEN_SLASH_COMMANDS = [
  "image-compose",
  "video-compose",
  "voice-compose",
  "script-compose",
  "groups-compose",
];

const STALE_SHARED_GUIDANCE = [
  "./uploads/",
  "filename-reference",
  "waits for the terminal JSON result",
  "prints the terminal result as its final JSON line",
  "--draft-only",
  "wait_for_generations.js",
];

async function sharedInstructionFiles() {
  const files = [
    join(REPO_ROOT, "agent-templates", "PROJECT_AGENT.md"),
  ];
  files.push(...await skillMarkdownFiles(join(REPO_ROOT, "skills")));
  return files;
}

async function skillMarkdownFiles(dir) {
  const files = [];
  await collectSkillMarkdownFiles(dir, files);
  return files;
}

async function collectSkillMarkdownFiles(dir, files) {
  const skillsRoot = join(REPO_ROOT, "skills");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSkillMarkdownFiles(fullPath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (fullPath === join(skillsRoot, "CLAUDE.md")) continue;
    files.push(fullPath);
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "missing YAML frontmatter");
  const fields = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    const topLevel = line.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (topLevel) {
      currentKey = topLevel[1];
      const rawValue = topLevel[2]?.trim() ?? "";
      fields[currentKey] = [">", ">-", "|", "|-"].includes(rawValue) ? "" : rawValue;
      continue;
    }
    if (currentKey && /^\s+/.test(line)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function normalizeSectionTitle(title) {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function projectAgentSections(text) {
  const sections = new Set();
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{2,6}\s+(.+?)\s*#*$/);
    if (heading) sections.add(normalizeSectionTitle(heading[1]));
  }
  return sections;
}

test("shared project instructions and skills do not contain Claude-only phrases", async () => {
  for (const file of await sharedInstructionFiles()) {
    const text = await readFile(file, "utf8");
    for (const phrase of FORBIDDEN) {
      assert.equal(
        text.includes(phrase),
        false,
        `${file} contains forbidden phrase ${JSON.stringify(phrase)}`,
      );
    }
    for (const name of FORBIDDEN_SLASH_COMMANDS) {
      const re = new RegExp(String.raw`(?<![\w./])/${name}\b`);
      assert.equal(
        re.test(text),
        false,
        `${file} invokes the Claude-only slash command "/${name}"; reference the skill's recipe path instead of the slash command`,
      );
    }
  }
});

test("shared project instructions and skills do not point agents at stale upload paths", async () => {
  for (const file of await sharedInstructionFiles()) {
    const text = await readFile(file, "utf8");
    for (const phrase of STALE_SHARED_GUIDANCE) {
      assert.equal(
        text.includes(phrase),
        false,
        `${file} contains stale upload guidance ${JSON.stringify(phrase)}`,
      );
    }
  }
});

test("PROJECT_AGENT.md section citations resolve", async () => {
  const projectAgentPath = join(REPO_ROOT, "agent-templates", "PROJECT_AGENT.md");
  const sections = projectAgentSections(await readFile(projectAgentPath, "utf8"));
  for (const file of await sharedInstructionFiles()) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/§\s*"([^"]+)"/g)) {
      const citation = match[1];
      assert.equal(
        sections.has(normalizeSectionTitle(citation)),
        true,
        `${file} cites missing PROJECT_AGENT.md section ${JSON.stringify(citation)}`,
      );
    }
  }
});

test("dollar prices live only in PROJECT_AGENT.md, not in skills", async () => {
  // First-use generation pricing is single-sourced to PROJECT_AGENT.md §
  // "First-use generation choices"; skills cite it rather than restating
  // figures that drift when server/model_registry.js costs change. Match a
  // decimal dollar amount ($0.10) so node-id placeholders ($0, $1) don't trip.
  const skillFiles = await skillMarkdownFiles(join(REPO_ROOT, "skills"));
  for (const file of skillFiles) {
    const text = await readFile(file, "utf8");
    assert.equal(
      /\$\d+\.\d/.test(text),
      false,
      `${file} hardcodes a dollar price; cite PROJECT_AGENT.md § "First-use generation choices" instead`,
    );
  }
});

test("skill frontmatter avoids unquoted YAML colon traps", async () => {
  for (const file of await sharedInstructionFiles()) {
    if (!file.endsWith("/SKILL.md")) continue;
    const text = await readFile(file, "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, `${file} is missing YAML frontmatter`);
    const lines = match[1].split("\n");
    for (const line of lines) {
      if (!line.trim() || /^\s/.test(line)) continue;
      const keyValue = line.match(/^([A-Za-z0-9_-]+):\s+(.+)$/);
      if (!keyValue) continue;
      const value = keyValue[2].trim();
      if (
        value.startsWith("\"")
        || value.startsWith("'")
        || value === ">"
        || value === ">-"
        || value === "|"
        || value === "|-"
      ) {
        continue;
      }
      assert.equal(
        /:\s/.test(value),
        false,
        `${file} frontmatter line has an unquoted colon-space; quote it or use a block scalar: ${line}`,
      );
    }
  }
});

test("skill metadata and body stay within provider-neutral skill limits", async () => {
  let sawStoryToVideo = false;
  for (const file of await sharedInstructionFiles()) {
    if (!file.endsWith("/SKILL.md")) continue;
    const text = await readFile(file, "utf8");
    const fields = parseFrontmatter(text);
    const expectedName = basename(dirname(file));
    if (expectedName === "story-to-video-workflow") sawStoryToVideo = true;
    assert.equal(fields.name, expectedName, `${file} name must match directory`);
    assert.ok(fields.description, `${file} must have a description`);
    assert.ok(
      fields.description.length <= 1024,
      `${file} description is ${fields.description.length} chars`,
    );
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.ok(
      body.split("\n").length <= 500,
      `${file} body must stay at or below 500 lines`,
    );
  }
  assert.equal(sawStoryToVideo, true, "skills/story-to-video-workflow/SKILL.md is required");
});
