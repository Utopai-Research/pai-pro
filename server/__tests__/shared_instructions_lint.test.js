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
  "/image-compose",
  "/video-compose",
  "/voice-compose",
  "/script-compose",
  "/groups-compose",
];

const STALE_SHARED_GUIDANCE = [
  "./uploads/",
  "filename-reference",
];

async function sharedInstructionFiles() {
  const files = [
    join(REPO_ROOT, "agent-templates", "PROJECT_AGENT.md"),
  ];
  const skillsRoot = join(REPO_ROOT, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(join(skillsRoot, entry.name, "SKILL.md"));
  }
  return files;
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
