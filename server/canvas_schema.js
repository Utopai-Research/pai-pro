// AJV schemas for workflow.json + mutator op payloads.
//
// The renderer-side mirror of these shapes lives at web/src/types/canvas.ts —
// when either side changes, update both, then run the contract tests:
// server/__tests__/workflow_contract.test.js (type-map consistency + every
// local projects/*/workflow.json validates) and canvas_mutator.test.js →
// "sample workflow fixture validates against doc schema".
//
// Strict mode is OFF for `data.metadata` sub-objects — the metadata bags
// are intentionally open-shape and grow over time. Strict elsewhere.

import Ajv from "ajv";

// Open-shape metadata bag — every node's data.metadata can carry extra
// generator-specific keys. Stays open by design.
const metadataSchema = {
  $id: "#metadata",
  type: "object",
  additionalProperties: true,
  properties: {
    source: { type: "string" },
    task_type: { type: "string" },
    generated_at: { type: "string" },
    pending_job_id: { type: "string" },
    author: { type: "string" },
    timestamp: { type: "string" },
    source_filename: { type: "string" },
    source_url: { type: "string" },
    model: { type: "string" },
    aspect_ratio: { type: "string" },
    image_size: { type: "string" },
    grid: { type: "string" },
    duration: { type: "number" },
    resolution: { type: "string" },
    generate_audio: { type: "boolean" },
    duration_sec: { type: "number" },
    content_type: { type: "string" },
    size_bytes: { type: "number" },
    attachment_id: { type: "string" },
    // video-generation-assets preupload state, landed on the node by services/asset_sync
    // when paiAssetEvents fires "update". Replaces the .asset_cache.json
    // sidecar — workflow.json is now the durable cache.
    asset_id: { type: "string" },
    asset_rejected_reason: { type: "string" },
    // video_result only: PAI's upstream signed GCS URL (~24h TTL). Surfaced
    // for visibility / future re-download; never used as a canvas URL.
    provider_output_url: { type: "string" },
  },
};

const noteDataSchema = {
  $id: "#noteData",
  type: "object",
  required: ["label", "body"],
  additionalProperties: true,
  properties: {
    subtype: { type: "string", enum: ["script", "shot"] },
    label: { type: "string" },
    body: { type: "string" },
    state: { type: "string" },
    archived: { type: "boolean" },
    metadata: { $ref: "#metadata" },
  },
};

const imageResultDataSchema = {
  $id: "#imageResultData",
  type: "object",
  required: ["label", "local_path", "metadata"],
  additionalProperties: true,
  properties: {
    subtype: {
      type: "string",
      enum: ["character", "location", "edit", "reference", "split", "storyboard"],
    },
    label: { type: "string" },
    local_path: { type: "string", minLength: 1 },
    prompt: { type: "string" },
    archived: { type: "boolean" },
    metadata: { $ref: "#metadata" },
    // character / location
    name: { type: "string" },
    role: { type: "string" },
    description: { type: "string" },
    // edit / split
    source_id: { type: "string" },
    // reference
    source_filename: { type: "string" },
    attachment_id: { type: "string" },
    // split
    grid_position: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
    },
  },
};

const audioResultDataSchema = {
  $id: "#audioResultData",
  type: "object",
  required: ["label", "local_path", "subtype", "metadata"],
  additionalProperties: true,
  properties: {
    subtype: {
      type: "string",
      enum: ["voice", "upload"],
    },
    label: { type: "string" },
    local_path: { type: "string", minLength: 1 },
    text: { type: "string" },
    prompt: { type: "string" },
    // voice: optional anchor to the character this voice was generated for.
    source_id: { type: "string" },
    archived: { type: "boolean" },
    metadata: { $ref: "#metadata" },
  },
};

const videoResultDataSchema = {
  $id: "#videoResultData",
  type: "object",
  // shot_id is intentionally not required: setting it to null via PATCH
  // deletes the key entirely (CLAUDE.md: "shot_id: null means remove from
  // timeline"). The renderer treats absent and explicit-null identically.
  required: ["label", "local_path", "duration", "aspect", "metadata"],
  additionalProperties: true,
  properties: {
    label: { type: "string" },
    local_path: { type: "string", minLength: 1 },
    prompt: { type: "string" },
    duration: { type: "integer" },
    aspect: { type: "string" },
    shot_id: { type: ["integer", "null"] },
    state: { type: "string" },
    archived: { type: "boolean" },
    metadata: { $ref: "#metadata" },
  },
};

// Node schemas — id required when persisted; AddNodeInput below allows id-less.
const noteNodeSchema = {
  $id: "#noteNode",
  type: "object",
  required: ["id", "type", "data"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^note_[0-9]+$" },
    type: { const: "note" },
    data: { $ref: "#noteData" },
  },
};
const imageResultNodeSchema = {
  $id: "#imageResultNode",
  type: "object",
  required: ["id", "type", "data"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^image_[0-9]+$" },
    type: { const: "image_result" },
    data: { $ref: "#imageResultData" },
  },
};
const videoResultNodeSchema = {
  $id: "#videoResultNode",
  type: "object",
  required: ["id", "type", "data"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^video_[0-9]+$" },
    type: { const: "video_result" },
    data: { $ref: "#videoResultData" },
  },
};
const audioResultNodeSchema = {
  $id: "#audioResultNode",
  type: "object",
  required: ["id", "type", "data"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^audio_[0-9]+$" },
    type: { const: "audio_result" },
    data: { $ref: "#audioResultData" },
  },
};

const canvasNodeSchema = {
  $id: "#canvasNode",
  oneOf: [
    { $ref: "#noteNode" },
    { $ref: "#imageResultNode" },
    { $ref: "#videoResultNode" },
    { $ref: "#audioResultNode" },
  ],
};

const edgeSchema = {
  $id: "#edge",
  type: "object",
  required: ["from", "to"],
  additionalProperties: false,
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    kind: { type: "string", enum: ["derived"] },
  },
};

// Persistent monotonic id counters per node type. See canvas_mutator.js →
// nextNodeId for the read/bump/backfill semantics.
const nextIdsSchema = {
  $id: "#nextIds",
  type: "object",
  additionalProperties: false,
  properties: {
    note: { type: "integer", minimum: 0 },
    image_result: { type: "integer", minimum: 0 },
    video_result: { type: "integer", minimum: 0 },
    audio_result: { type: "integer", minimum: 0 },
  },
};

const workflowSchema = {
  $id: "#workflow",
  type: "object",
  required: ["version", "workflow_id", "title", "nodes", "edges"],
  additionalProperties: false,
  properties: {
    version: { const: 2 },
    workflow_id: { type: "string" },
    title: { type: "string" },
    nodes: { type: "array", items: { $ref: "#canvasNode" } },
    edges: { type: "array", items: { $ref: "#edge" } },
    next_ids: { $ref: "#nextIds" },
  },
};

// --- AddNodeInput: id optional (server assigns), otherwise same as node.
// `tmp_path` is consumed by canvas_mutator.js → applyTmpPathToNode.
const addNodeInputSchema = {
  $id: "#addNodeInput",
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["note", "image_result", "video_result", "audio_result"] },
    data: {
      // Validate per-type in the reducer; AJV here only checks shape exists.
      type: "object",
    },
    tmp_path: { type: "string", minLength: 1 },
  },
};

// --- Op payload schemas ---------------------------------------------------

const opSchemas = {
  addNode: {
    $id: "#op_addNode",
    type: "object",
    required: ["node"],
    additionalProperties: false,
    properties: { node: { $ref: "#addNodeInput" } },
  },
  updateNode: {
    $id: "#op_updateNode",
    type: "object",
    required: ["id", "patch"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      patch: { type: "object" },
    },
  },
  updateBatch: {
    $id: "#op_updateBatch",
    type: "object",
    required: ["updates"],
    additionalProperties: false,
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "patch"],
          additionalProperties: false,
          properties: { id: { type: "string" }, patch: { type: "object" } },
        },
      },
    },
  },
  deleteNode: {
    $id: "#op_deleteNode",
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string" } },
  },
  addEdge: {
    $id: "#op_addEdge",
    type: "object",
    required: ["edge"],
    additionalProperties: false,
    properties: { edge: { $ref: "#edge" } },
  },
  deleteEdge: {
    $id: "#op_deleteEdge",
    type: "object",
    required: ["from", "to"],
    additionalProperties: false,
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      kind: { type: "string" },
    },
  },
  setTitle: {
    $id: "#op_setTitle",
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: { title: { type: "string" } },
  },
  addBatch: {
    $id: "#op_addBatch",
    type: "object",
    additionalProperties: false,
    properties: {
      nodes: { type: "array", items: { $ref: "#addNodeInput" } },
      edges: { type: "array", items: { $ref: "#edge" } },
    },
  },
};

const envelopeSchema = {
  $id: "#envelope",
  type: "object",
  required: ["request_id", "op", "payload"],
  additionalProperties: true,
  properties: {
    request_id: { type: "string", minLength: 1 },
    op: { type: "string", enum: Object.keys(opSchemas) },
    payload: { type: "object" },
    ts: { type: "string" },
    actor: { type: "string" },
  },
};

// --- Compile -------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

for (const s of [
  metadataSchema,
  noteDataSchema,
  imageResultDataSchema,
  videoResultDataSchema,
  audioResultDataSchema,
  noteNodeSchema,
  imageResultNodeSchema,
  videoResultNodeSchema,
  audioResultNodeSchema,
  canvasNodeSchema,
  edgeSchema,
  nextIdsSchema,
  workflowSchema,
  addNodeInputSchema,
  envelopeSchema,
  ...Object.values(opSchemas),
]) {
  ajv.addSchema(s);
}

const opValidators = {};
for (const [name, schema] of Object.entries(opSchemas)) {
  opValidators[name] = ajv.getSchema(schema.$id);
}

const validateEnvelope = ajv.getSchema("#envelope");
const validateWorkflow = ajv.getSchema("#workflow");

function formatErrors(errors) {
  if (!errors) return "unknown validation error";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}`)
    .join("; ");
}

export {
  ajv,
  validateEnvelope,
  validateWorkflow,
  opValidators,
  formatErrors,
};
