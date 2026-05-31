// Canvas mutator core.
//
// Owns every write to projects/<id>/workflow.json. The viewer wires this
// up by:
//   1. calling initProjectMutatorState(p, workflowPath, mutationLogPath)
//      once per project (in primeProjects), which attaches mutationQueue,
//      stenoWriter, idempotencyCache, and version to the project entry,
//   2. calling mutate(p, envelope, hooks) on every mutation,
//   3. forwarding hooks.onApply(p) to socket.io emit.
//
// Wire format, reducer table, and failure semantics are documented
// inline below.

import { Writer as Steno } from "steno";
import PQueue from "p-queue";
import { LRUCache } from "lru-cache";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, resolve } from "node:path";

import {
  validateEnvelope,
  validateWorkflow,
  opValidators,
  ajv,
  formatErrors,
} from "./canvas_schema.js";

class MutatorError extends Error {
  constructor(klass, message) {
    super(message);
    this.klass = klass;
  }
}

// -------------------- Per-project init ----------------------------------

export function initProjectMutatorState(p, { workflowPath, mutationLogPath }) {
  p.mutationQueue = new PQueue({ concurrency: 1 });
  p.stenoWriter = new Steno(workflowPath);
  p.idempotencyCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 });
  p.workflowPath = workflowPath;
  p.mutationLogPath = mutationLogPath;
  p.version = 0;
}

// -------------------- Reducers ------------------------------------------

const NODE_ID_PREFIX = {
  note: "note_",
  image_result: "image_",
  video_result: "video_",
  audio_result: "audio_",
};

// Notes carry no asset — applyTmpPathToNode reads the absence as
// "tmp_path not supported for this type".
const ASSET_BUCKET_BY_TYPE = {
  image_result: "images",
  video_result: "videos",
  audio_result: "audios",
};

const dataValidatorIdByType = {
  note: "#noteData",
  image_result: "#imageResultData",
  video_result: "#videoResultData",
  audio_result: "#audioResultData",
};

function validateNodeData(type, data) {
  const v = ajv.getSchema(dataValidatorIdByType[type]);
  if (!v) throw new MutatorError("validation", `unknown node type: ${type}`);
  if (!v(data)) {
    throw new MutatorError(
      "validation",
      `node.data invalid for type=${type}: ${formatErrors(v.errors)}`
    );
  }
}

// The counter is persisted in workflow.json (not derived from live nodes) so
// id reuse after deleteNode can't happen — the on-disk file kept by the
// "leave orphans" policy would otherwise collide with the next mint.
// Legacy projects without next_ids backfill from max(existing ids) on first
// use.
function nextNodeId(draft, type) {
  const prefix = NODE_ID_PREFIX[type];
  if (!prefix) throw new MutatorError("validation", `unknown node type: ${type}`);
  if (!draft.next_ids) draft.next_ids = {};
  let counter = draft.next_ids[type];
  if (typeof counter !== "number" || counter < 0) {
    counter = 0;
    for (const n of draft.nodes) {
      if (n.type !== type) continue;
      const m = /^(?:note|image|video|audio)_(\d+)$/.exec(n.id);
      if (m) counter = Math.max(counter, Number(m[1]));
    }
  }
  const next = counter + 1;
  draft.next_ids[type] = next;
  return `${prefix}${next}`;
}

function bumpNextIdsForExplicit(draft, type, id) {
  const m = /^(?:note|image|video|audio)_(\d+)$/.exec(id);
  if (!m) return;
  const n = Number(m[1]);
  if (!draft.next_ids) draft.next_ids = {};
  const current = draft.next_ids[type];
  if (typeof current !== "number" || current < n) draft.next_ids[type] = n;
}

function nextGroupId(draft) {
  let max = 0;
  for (const g of draft.groups || []) {
    const m = /^group_(\d+)$/.exec(g.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `group_${max + 1}`;
}

function findNodeIndex(draft, id) {
  return draft.nodes.findIndex((n) => n.id === id);
}

function assertNodeExists(draft, id, role) {
  if (findNodeIndex(draft, id) === -1) {
    throw new MutatorError("not_found", `edge ${role} node not found: ${id}`);
  }
}

function findGroupIndex(draft, id) {
  if (!Array.isArray(draft.groups)) return -1;
  return draft.groups.findIndex((g) => g.id === id);
}

// Deep-merge `patch` into `target`. Null values in patch DELETE the key.
// Arrays in patch REPLACE the target array wholesale. Matches the existing
// PATCH /projects/:id/nodes/:nodeId/data behavior at the data.* level.
function deepMergePatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) {
      delete target[k];
    } else if (Array.isArray(v)) {
      target[k] = v;
    } else if (typeof v === "object" && v !== null && typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k])) {
      deepMergePatch(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function enforceOneGroupPerNode(draft, groupId, nodeIds) {
  if (!Array.isArray(draft.groups)) return;
  for (const g of draft.groups) {
    if (g.id === groupId) continue;
    for (const nid of nodeIds) {
      if (g.node_ids.includes(nid)) {
        throw new MutatorError(
          "conflict",
          `node ${nid} already in group ${g.id}; cannot add to ${groupId}`
        );
      }
    }
  }
}

// Fills the node's local_path and queues an fs.rename op for the caller
// to execute under the lock. The anti-traversal guard keeps a malicious
// or buggy caller from renaming arbitrary files into the assets tree by
// passing a tmp_path outside `<projectDir>/assets/.tmp/`.
//
// The viewer URL (image_url / video_url / audio_url) is no longer
// stored on the node — clients derive it from local_path at the
// wire→state seam (synthesizeAssetUrls in web/src/lib/workflowMerge.ts).
function applyTmpPathToNode({ ctx, node, id }) {
  const tmpPath = node.tmp_path;
  if (!tmpPath) return;
  const bucket = ASSET_BUCKET_BY_TYPE[node.type];
  if (!bucket) {
    throw new MutatorError("validation", `tmp_path not supported for node type: ${node.type}`);
  }
  if (!isAbsolute(tmpPath)) {
    throw new MutatorError("bad_args", `tmp_path must be absolute: ${tmpPath}`);
  }
  const tmpRoot = resolve(ctx.projectDir, "assets", ".tmp");
  const resolvedTmp = resolve(tmpPath);
  if (resolvedTmp !== tmpRoot && !resolvedTmp.startsWith(tmpRoot + "/")) {
    throw new MutatorError("bad_args", `tmp_path must live under ${tmpRoot}: ${tmpPath}`);
  }
  const ext = (extname(tmpPath) || ".bin").toLowerCase();
  const targetRel = posix.join("assets", bucket, `${id}${ext}`);
  const targetAbs = join(ctx.projectDir, targetRel);
  node.data.local_path = targetRel;
  ctx.fsOps.push({ from: resolvedTmp, to: targetAbs });
}

function reduceAddNode(draft, payload, ctx) {
  const { node } = payload;
  let id = node.id;
  if (id) {
    if (findNodeIndex(draft, id) !== -1) {
      throw new MutatorError("conflict", `node id collision: ${id}`);
    }
    if (!new RegExp(`^${NODE_ID_PREFIX[node.type]}\\d+$`).test(id)) {
      throw new MutatorError(
        "validation",
        `node id ${id} does not match type ${node.type} pattern`
      );
    }
    bumpNextIdsForExplicit(draft, node.type, id);
  } else {
    id = nextNodeId(draft, node.type);
  }
  applyTmpPathToNode({ ctx, node, id });
  validateNodeData(node.type, node.data);
  draft.nodes.push({ id, type: node.type, data: node.data });
  return { node_id: id };
}

function reduceUpdateNode(draft, { id, patch }) {
  const idx = findNodeIndex(draft, id);
  if (idx === -1) throw new MutatorError("not_found", `node not found: ${id}`);
  const node = draft.nodes[idx];
  const nextData = structuredClone(node.data);
  deepMergePatch(nextData, patch);
  validateNodeData(node.type, nextData);
  node.data = nextData;
  return {};
}

function reduceDeleteNode(draft, { id }) {
  const idx = findNodeIndex(draft, id);
  if (idx === -1) throw new MutatorError("not_found", `node not found: ${id}`);
  draft.nodes.splice(idx, 1);
  draft.edges = draft.edges.filter((e) => e.from !== id && e.to !== id);
  if (Array.isArray(draft.groups)) {
    draft.groups = draft.groups
      .map((g) => ({ ...g, node_ids: g.node_ids.filter((nid) => nid !== id) }))
      .filter((g) => g.node_ids.length > 0);
  }
  return {};
}

function reduceAddEdge(draft, { edge }) {
  const existing = draft.edges.find(
    (e) => e.from === edge.from && e.to === edge.to && (e.kind || null) === (edge.kind || null)
  );
  if (existing) return {}; // silent dedupe
  assertNodeExists(draft, edge.from, "source");
  assertNodeExists(draft, edge.to, "target");
  const out = { from: edge.from, to: edge.to };
  if (edge.kind) out.kind = edge.kind;
  draft.edges.push(out);
  return {};
}

function reduceDeleteEdge(draft, { from, to, kind }) {
  const before = draft.edges.length;
  draft.edges = draft.edges.filter((e) => {
    if (e.from !== from || e.to !== to) return true;
    if (kind === undefined) return false; // delete any kind
    return (e.kind || null) !== kind;
  });
  if (draft.edges.length === before) {
    throw new MutatorError("not_found", `edge not found: ${from} -> ${to}${kind ? " kind=" + kind : ""}`);
  }
  return {};
}

function reduceAddGroup(draft, { group }) {
  if (!Array.isArray(draft.groups)) draft.groups = [];
  const id = group.id || nextGroupId(draft);
  if (findGroupIndex(draft, id) !== -1) {
    throw new MutatorError("conflict", `group id collision: ${id}`);
  }
  // dedupe node_ids
  const nodeIds = [...new Set(group.node_ids)];
  enforceOneGroupPerNode(draft, id, nodeIds);
  draft.groups.push({ id, title: group.title, node_ids: nodeIds, hue: group.hue });
  return { group_id: id };
}

function reduceUpdateGroup(draft, { id, patch }) {
  const idx = findGroupIndex(draft, id);
  if (idx === -1) throw new MutatorError("not_found", `group not found: ${id}`);
  const next = { ...draft.groups[idx] };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.hue !== undefined) next.hue = patch.hue;
  if (patch.node_ids !== undefined) {
    const nodeIds = [...new Set(patch.node_ids)];
    enforceOneGroupPerNode(draft, id, nodeIds);
    next.node_ids = nodeIds;
  }
  draft.groups[idx] = next;
  return {};
}

function reduceDeleteGroup(draft, { id }) {
  if (!Array.isArray(draft.groups)) throw new MutatorError("not_found", `group not found: ${id}`);
  const idx = findGroupIndex(draft, id);
  if (idx === -1) throw new MutatorError("not_found", `group not found: ${id}`);
  draft.groups.splice(idx, 1);
  return {};
}

function reduceSetTitle(draft, { title }) {
  draft.title = title;
  return {};
}

// updateBatch: atomic. Apply N updateNode patches in one mutation so the
// disk write + canvas-state emit happen once for the whole batch (Timeline
// drag-reorder needs this).
function reduceUpdateBatch(draft, { updates }) {
  for (const u of updates) {
    reduceUpdateNode(draft, u);
  }
  return {};
}

// addBatch: atomic. Apply nodes, then resolve $N placeholders in edges +
// groups, then apply edges, then groups.
function reduceAddBatch(draft, { nodes = [], edges = [], groups = [] }, ctx) {
  const assignedNodeIds = [];
  for (const node of nodes) {
    const { node_id } = reduceAddNode(draft, { node }, ctx);
    assignedNodeIds.push(node_id);
  }
  const placeholderMap = {};
  assignedNodeIds.forEach((id, i) => {
    placeholderMap[`$${i}`] = id;
  });
  function resolvePlaceholder(id) {
    return Object.prototype.hasOwnProperty.call(placeholderMap, id) ? placeholderMap[id] : id;
  }
  for (const edge of edges) {
    reduceAddEdge(draft, {
      edge: { from: resolvePlaceholder(edge.from), to: resolvePlaceholder(edge.to), ...(edge.kind ? { kind: edge.kind } : {}) },
    });
  }
  const assignedGroupIds = [];
  for (const group of groups) {
    const resolvedGroup = {
      ...group,
      node_ids: group.node_ids.map(resolvePlaceholder),
    };
    const { group_id } = reduceAddGroup(draft, { group: resolvedGroup });
    assignedGroupIds.push(group_id);
  }
  return { node_ids: assignedNodeIds, group_ids: assignedGroupIds };
}

const reducers = {
  addNode: reduceAddNode,
  updateNode: reduceUpdateNode,
  deleteNode: reduceDeleteNode,
  addEdge: reduceAddEdge,
  deleteEdge: reduceDeleteEdge,
  addGroup: reduceAddGroup,
  updateGroup: reduceUpdateGroup,
  deleteGroup: reduceDeleteGroup,
  setTitle: reduceSetTitle,
  addBatch: reduceAddBatch,
  updateBatch: reduceUpdateBatch,
};

// -------------------- Top-level mutate() --------------------------------

/**
 * Apply one mutation to a project's canvas state.
 *
 * @param p — per-project state with mutationQueue, stenoWriter, idempotencyCache, canvasState, version
 * @param envelope — { request_id, op, payload, ts?, actor? }
 * @param hooks — optional { onApply(p, envelope, reply) }: called inside the queue
 *   after a successful write+swap. Awaited so coupled side effects that must
 *   stay ordered with workflow mutations can finish before the next mutation.
 *   Use this for write-then-broadcast couplings (e.g. server-side position
 *   handoff for completed pending generations — see lib/broadcasters.js).
 * @returns reply: { ok:true, applied, assigned, version } | { ok:false, klass, message, request_id }
 */
export async function mutate(p, envelope, hooks = {}) {
  return p.mutationQueue.add(() => mutateLocked(p, envelope, hooks));
}

async function mutateLocked(p, envelope, hooks) {
  const requestId = envelope?.request_id;
  try {
    if (!validateEnvelope(envelope)) {
      throw new MutatorError("validation", `envelope: ${formatErrors(validateEnvelope.errors)}`);
    }
    if (p.idempotencyCache.has(requestId)) {
      return { ...p.idempotencyCache.get(requestId), applied: false };
    }
    const reducer = reducers[envelope.op];
    if (!reducer) throw new MutatorError("validation", `unknown op: ${envelope.op}`);
    const validator = opValidators[envelope.op];
    if (!validator(envelope.payload)) {
      throw new MutatorError(
        "validation",
        `payload for op=${envelope.op}: ${formatErrors(validator.errors)}`
      );
    }
    if (!p.canvasState) {
      throw new MutatorError("infra", "project has no canvas state to mutate");
    }
    const draft = structuredClone(p.canvasState);
    if (!Array.isArray(draft.nodes)) draft.nodes = [];
    if (!Array.isArray(draft.edges)) draft.edges = [];
    // ctx.fsOps collects rename ops queued by reducers; runFsOps drains it
    // inside the lock, just before the JSON write, with rollback if the
    // write fails so disk + workflow.json stay consistent.
    const ctx = { projectDir: dirname(p.workflowPath), fsOps: [] };
    const assigned = reducer(draft, envelope.payload, ctx);
    if (!validateWorkflow(draft)) {
      throw new MutatorError(
        "validation",
        `post-apply doc invalid: ${formatErrors(validateWorkflow.errors)}`
      );
    }
    const performed = await runFsOps(ctx.fsOps);
    const prevState = p.canvasState;
    try {
      await p.stenoWriter.write(JSON.stringify(draft, null, 2) + "\n");
    } catch (e) {
      await rollbackFsOps(performed);
      throw new MutatorError("infra", `disk write failed: ${e.message || e}`);
    }
    p.canvasState = draft;
    p.version = (p.version || 0) + 1;
    const reply = { ok: true, applied: true, assigned, version: p.version };
    p.idempotencyCache.set(requestId, reply);
    await appendMutationLog(p, envelope, reply).catch((err) =>
      console.warn(`[mutator] log append failed for ${p.id}: ${err.message}`)
    );
    // Awaited so callers can find the .md mirror on disk by the time the
    // reply lands; mirror failures are logged, never thrown.
    await mirrorNotesDiff(p, prevState, draft).catch((err) =>
      console.warn(`[mutator] notes-mirror failed for ${p.id}: ${err.message}`)
    );
    if (hooks.onApply) {
      try {
        await hooks.onApply(p, envelope, reply);
      } catch (e) {
        console.warn(`[mutator] onApply hook threw: ${e.message}`);
      }
    }
    return reply;
  } catch (e) {
    if (e instanceof MutatorError) {
      return { ok: false, klass: e.klass, message: e.message, request_id: requestId };
    }
    console.error(`[mutator] unexpected error (request_id=${requestId}):`, e);
    return {
      ok: false,
      klass: "infra",
      message: e?.message || String(e),
      request_id: requestId,
    };
  }
}

async function runFsOps(ops) {
  const performed = [];
  for (const op of ops) {
    try {
      await mkdir(dirname(op.to), { recursive: true });
      await rename(op.from, op.to);
      performed.push(op);
    } catch (e) {
      await rollbackFsOps(performed);
      throw new MutatorError("infra", `asset rename failed (${op.from} → ${op.to}): ${e.message || e}`);
    }
  }
  return performed;
}

// Best-effort: we're already on the error path, so log + swallow rather
// than leave the JSON write to retry on top of a half-rolled-back state.
async function rollbackFsOps(performed) {
  for (const op of [...performed].reverse()) {
    try {
      await rename(op.to, op.from);
    } catch (e) {
      console.warn(`[mutator] rollback rename failed (${op.to} → ${op.from}): ${e.message}`);
    }
  }
}

// Notes live canonically in workflow.json (data.body); the .md mirror at
// assets/notes/<id>.md is derived — exists so the download button can serve
// a real file and the user can grep notes from the shell. Mirror failures
// never roll back the workflow.json write; the next mutation re-syncs.
//
// Leave-orphans on delete: the .md is NOT unlinked when a note disappears
// from the workflow. Matches image / video / audio behavior (assets stay on
// disk after deleteNode) and avoids fighting soft-delete (archive flips
// visibility, not file existence).
async function mirrorNotesDiff(p, prevState, nextState) {
  if (!p.workflowPath) return;
  const notesDir = join(dirname(p.workflowPath), "assets", "notes");
  const prevNotes = collectNoteBodies(prevState);
  const nextNotes = collectNoteBodies(nextState);
  const writes = [];
  for (const [id, body] of nextNotes) {
    if (prevNotes.get(id) !== body) writes.push({ id, body });
  }
  if (writes.length === 0) return;
  try {
    await mkdir(notesDir, { recursive: true });
  } catch (e) {
    console.warn(`[mutator] notes-mirror mkdir failed for ${p.id}: ${e.message}`);
    return;
  }
  await Promise.all(
    writes.map(({ id, body }) =>
      writeFile(join(notesDir, `${id}.md`), body, "utf8").catch((e) =>
        console.warn(`[mutator] notes-mirror write ${id} failed for ${p.id}: ${e.message}`)
      ),
    ),
  );
}

function collectNoteBodies(state) {
  const out = new Map();
  if (!state || !Array.isArray(state.nodes)) return out;
  for (const n of state.nodes) {
    if (n?.type !== "note") continue;
    const body = typeof n?.data?.body === "string" ? n.data.body : "";
    out.set(n.id, body);
  }
  return out;
}

async function appendMutationLog(p, envelope, reply) {
  if (!p.mutationLogPath) return;
  const line =
    JSON.stringify({
      ts: envelope.ts || new Date().toISOString(),
      request_id: envelope.request_id,
      op: envelope.op,
      actor: envelope.actor || null,
      payload: envelope.payload,
      reply: { ok: reply.ok, assigned: reply.assigned, version: reply.version },
    }) + "\n";
  await appendFile(p.mutationLogPath, line, "utf8");
}

// -------------------- Exports for tests ---------------------------------

export { MutatorError, reducers };
