// Workflow-contract drift catcher.
//
// CLAUDE.md's "adding a node type" checklist has always pointed at a test
// like this; this file makes it real. Two layers:
//
//   1. Internal consistency — the node-type list is enumerated in five
//      places today (mutator maps, addNodeInput enum, next_ids schema,
//      canvasNode oneOf, per-node id patterns). Until they collapse into a
//      single registry, this test fails the suite when any copy drifts.
//   2. Real-file validation — every projects/*/workflow.json present on
//      this machine must validate against the doc schema. Skips cleanly
//      when no projects exist (CI).
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ajv, validateWorkflow, formatErrors } from "../canvas_schema.js";
import { __mutatorInternals } from "../canvas_mutator.js";
import { PROJECTS_DIR } from "../lib/paths.js";

const { NODE_ID_PREFIX, ASSET_BUCKET_BY_TYPE, dataValidatorIdByType } =
  __mutatorInternals;

const TYPES = Object.keys(NODE_ID_PREFIX).sort();

function schemaById(id) {
  const v = ajv.getSchema(id);
  assert.ok(v, `schema ${id} is not registered`);
  return v.schema;
}

test("node-type enumerations agree across mutator maps and schemas", () => {
  // Mutator's own maps.
  assert.deepEqual(
    Object.keys(dataValidatorIdByType).sort(),
    TYPES,
    "dataValidatorIdByType and NODE_ID_PREFIX list different types",
  );
  for (const t of Object.keys(ASSET_BUCKET_BY_TYPE)) {
    assert.ok(
      TYPES.includes(t),
      `ASSET_BUCKET_BY_TYPE has unknown type: ${t}`,
    );
  }

  // addNode input enum.
  const addNodeEnum = schemaById("#addNodeInput").properties.type.enum;
  assert.deepEqual(
    [...addNodeEnum].sort(),
    TYPES,
    "addNodeInput type enum drifted from NODE_ID_PREFIX",
  );

  // next_ids counters — a type missing here makes the first auto-mint fail
  // post-apply doc validation (the object is additionalProperties:false).
  const nextIdsKeys = Object.keys(schemaById("#nextIds").properties);
  assert.deepEqual(
    nextIdsKeys.sort(),
    TYPES,
    "nextIds schema keys drifted from NODE_ID_PREFIX",
  );

  // canvasNode oneOf branches: each branch's type const, id pattern, and
  // data $ref must round-trip through the mutator maps.
  const oneOf = schemaById("#canvasNode").oneOf;
  const branchTypes = [];
  for (const branch of oneOf) {
    const node = schemaById(branch.$ref);
    const type = node.properties.type.const;
    branchTypes.push(type);
    assert.equal(
      node.properties.id.pattern,
      `^${NODE_ID_PREFIX[type]}[0-9]+$`,
      `id pattern for ${type} disagrees with NODE_ID_PREFIX`,
    );
    assert.equal(
      node.properties.data.$ref,
      dataValidatorIdByType[type],
      `data $ref for ${type} disagrees with dataValidatorIdByType`,
    );
  }
  assert.deepEqual(branchTypes.sort(), TYPES, "canvasNode oneOf drifted");
});

test("every local projects/*/workflow.json validates against the doc schema", async (t) => {
  let entries;
  try {
    entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    t.skip("no projects directory");
    return;
  }

  let checked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(PROJECTS_DIR, entry.name, "workflow.json");
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue; // project scaffolded without a workflow yet
    }
    const doc = JSON.parse(raw);
    // Legacy pre-group-frames files may still carry a doc-level `groups`
    // key; the mutator strips it on the next write (canvas_mutator.js),
    // so mirror that here rather than failing on dormant projects.
    delete doc.groups;
    assert.ok(
      validateWorkflow(doc),
      `${file}: ${formatErrors(validateWorkflow.errors)}`,
    );
    checked += 1;
  }
  if (checked === 0) t.skip("no workflow.json files present");
});
