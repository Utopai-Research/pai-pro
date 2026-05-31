import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

async function sharedInstructionFiles() {
  const files = [join(REPO_ROOT, "agent-templates", "PROJECT_AGENT.md")];
  const skillsRoot = join(REPO_ROOT, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(join(skillsRoot, entry.name, "SKILL.md"));
  }
  return files;
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
