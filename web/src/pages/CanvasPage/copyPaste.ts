/**
 * copyPaste — ⌘C/⌘V duplicates canvas nodes.
 *
 * What a copy IS:
 *  - A media copy is a new node with the SAME `local_path` — zero bytes are
 *    copied. A note copy is a true copy (its body lives in `data`). Nothing
 *    here touches a file: an `addBatch` without `tmp_path` skips the asset
 *    move entirely (see server/canvas_mutator.js → applyTmpPathToNode).
 *  - The copy keeps the original's INCOMING edges — it was made from the same
 *    references, so recording that invents nothing. Edges between two copied
 *    nodes are remapped onto the copies via the mutator's `$i` placeholders.
 *    Outgoing edges are never copied: downstream nodes referenced the
 *    ORIGINAL, and the copy must not claim them.
 *  - The clipboard payload is JSON under a custom mime, so the file-paste path
 *    (UploadOverlay, which keys on `Files`) and this one never contend: each
 *    handler recognises only its own clipboard shape.
 *
 * Pure on purpose — no React, no `@/` imports — so the semantics are unit
 * testable without a DOM. The shapes below mirror types/canvas.ts
 * structurally rather than importing it.
 */

export const NODE_CLIP_MIME = 'application/x-pai-node-clip'

/** The four real workflow node types. Everything else on the React Flow
 *  surface (group frames, draft/failed pads) is renderer state, not a
 *  workflow node — those are additionally excluded by the join against
 *  `workflow.nodes` below, so this set is belt on top of braces. */
const COPYABLE_TYPES = new Set([
  'note',
  'image_result',
  'video_result',
  'audio_result',
])

/** Fields `synthesizeAssetUrls` (lib/workflowMerge.ts) injects at the
 *  useWorkflow boundary — one per media type. They are derived render-time
 *  state, not disk truth; writing them into workflow.json would freeze a URL
 *  that goes stale on the next machine. */
export const SYNTHESIZED_URL_FIELDS = [
  'image_url',
  'video_url',
  'audio_url',
] as const

// ── Structural shapes ────────────────────────────────────────────────────

export interface ClipPoint {
  x: number
  y: number
}

export interface ClipNodeEntry {
  type: string
  data: Record<string, unknown>
  /** Offset from the selection bounding-box top-left, so a multi-select
   *  paste preserves the copied nodes' relative layout. */
  relPos: ClipPoint
  /** Measured size at copy time (used to centre the pasted set on the
   *  pointer). Absent when React Flow had not measured the node yet. */
  size?: { w: number; h: number }
}

export interface ClipEdgeEntry {
  from: string
  to: string
  kind?: string
}

export interface ClipPayload {
  v: 1
  projectId: string
  origin: ClipPoint
  nodes: ClipNodeEntry[]
  edges: ClipEdgeEntry[]
}

export interface SelectedNodeLike {
  id: string
  position: ClipPoint
  size?: { w: number; h: number } | null
}

export interface WorkflowNodeLike {
  id: string
  type: string
  data: object
}

export interface WorkflowEdgeLike {
  from: string
  to: string
  kind?: string
}

// ── Guards ───────────────────────────────────────────────────────────────

/** True when the event target is a text field — ⌘C there must copy the text,
 *  not the canvas selection. */
export function isEditableTarget(el: unknown): boolean {
  if (el === null || typeof el !== 'object') return false
  const e = el as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof e.tagName === 'string' ? e.tagName : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return e.isContentEditable === true
}

/** True when the user has selected page text — again, ⌘C belongs to the text. */
export function hasTextSelection(
  sel: { isCollapsed?: unknown; toString?: () => string } | null,
): boolean {
  if (sel === null || sel === undefined) return false
  if (sel.isCollapsed === true) return false
  const text = typeof sel.toString === 'function' ? sel.toString() : ''
  return text.trim() !== ''
}

// ── Copy side ────────────────────────────────────────────────────────────

/** Strip everything that must not travel with a copy: archive state (a copy
 *  is never born archived), the render-time URLs, and the pending job id
 *  (which belongs to the generation that made the ORIGINAL). */
export function cleanNodeData(data: object): Record<string, unknown> {
  const out = structuredClone(data) as Record<string, unknown>
  delete out.archived
  delete out.archived_at
  for (const field of SYNTHESIZED_URL_FIELDS) delete out[field]
  const meta = out.metadata
  if (meta !== null && typeof meta === 'object') {
    delete (meta as Record<string, unknown>).pending_job_id
  }
  return out
}

export function buildClipPayload(args: {
  projectId: string
  selection: ReadonlyArray<SelectedNodeLike>
  workflowNodes: ReadonlyArray<WorkflowNodeLike>
  workflowEdges: ReadonlyArray<WorkflowEdgeLike>
}): ClipPayload | null {
  const byId = new Map(args.workflowNodes.map((n) => [n.id, n]))
  const picked: Array<{ sel: SelectedNodeLike; node: WorkflowNodeLike }> = []
  for (const sel of args.selection) {
    const node = byId.get(sel.id)
    if (node === undefined) continue // pads / frames: not workflow nodes
    if (!COPYABLE_TYPES.has(node.type)) continue
    picked.push({ sel, node })
  }
  if (picked.length === 0) return null

  const origin = {
    x: Math.min(...picked.map((p) => p.sel.position.x)),
    y: Math.min(...picked.map((p) => p.sel.position.y)),
  }
  const indexById = new Map(picked.map((p, i) => [p.node.id, i]))

  const nodes: ClipNodeEntry[] = picked.map(({ sel, node }) => ({
    type: node.type,
    data: cleanNodeData(node.data),
    relPos: { x: sel.position.x - origin.x, y: sel.position.y - origin.y },
    ...(sel.size !== null && sel.size !== undefined ? { size: sel.size } : {}),
  }))

  const edges: ClipEdgeEntry[] = []
  for (const e of args.workflowEdges) {
    const toIdx = indexById.get(e.to)
    if (toIdx === undefined) continue // outgoing-only or unrelated: never copied
    const fromIdx = indexById.get(e.from)
    edges.push({
      from: fromIdx !== undefined ? `$${fromIdx}` : e.from,
      to: `$${toIdx}`,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
    })
  }

  return { v: 1, projectId: args.projectId, origin, nodes, edges }
}

// ── Paste side ───────────────────────────────────────────────────────────

/** Parse + shape-check a clipboard string. Returns null for anything that is
 *  not a well-formed v1 payload — the caller treats that as "not ours". */
export function readClipPayload(raw: string): ClipPayload | null {
  if (raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const p = parsed as Partial<ClipPayload>
  if (p.v !== 1) return null
  if (typeof p.projectId !== 'string' || p.projectId === '') return null
  if (p.origin === null || typeof p.origin !== 'object') return null
  if (typeof p.origin.x !== 'number' || typeof p.origin.y !== 'number') return null
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) return null
  for (const n of p.nodes) {
    if (n === null || typeof n !== 'object') return null
    if (typeof n.type !== 'string') return null
    if (n.data === null || typeof n.data !== 'object') return null
    if (n.relPos === null || typeof n.relPos !== 'object') return null
    if (typeof n.relPos.x !== 'number' || typeof n.relPos.y !== 'number') return null
  }
  if (!Array.isArray(p.edges)) return null
  for (const e of p.edges) {
    if (e === null || typeof e !== 'object') return null
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return null
  }
  return p as ClipPayload
}

/** Type alias, not an interface: aliases carry the implicit index signature
 *  that lets this pass straight into `mutateCanvas`'s payload parameter. */
export type AddBatchPayload = {
  nodes: Array<{ type: string; data: Record<string, unknown> }>
  edges: ClipEdgeEntry[]
}

export type PastePlan = { kind: 'foreign' } | { kind: 'ok'; addBatch: AddBatchPayload }

/**
 * Decide what a paste of `clip` into `currentProjectId` does. A clip from
 * another project is refused: its bytes live under that project's directory,
 * so the copied `local_path` would not resolve here.
 */
export function planPaste(
  clip: ClipPayload,
  currentProjectId: string,
): PastePlan {
  if (clip.projectId !== currentProjectId) return { kind: 'foreign' }
  return {
    kind: 'ok',
    addBatch: {
      nodes: clip.nodes.map((n) => ({ type: n.type, data: n.data })),
      edges: clip.edges,
    },
  }
}

export const PASTE_STEP_PX = 40

/**
 * Where the pasted nodes land. With a pointer anchor (flow coords), the
 * selection's bounding box is centred on it; without one, the set lands at
 * its copy-time origin shifted down-right by `PASTE_STEP_PX * pasteCount`
 * (so repeated pastes stack in a stair, not on top of each other).
 * `nodeIds` are zipped with `clip.nodes` by index — `addBatch` assigns ids
 * in payload order.
 */
export function pastePositions(args: {
  nodeIds: ReadonlyArray<string>
  clip: ClipPayload
  anchor: ClipPoint | null
  pasteCount: number
}): Array<{ id: string; position: ClipPoint }> {
  const { nodeIds, clip, anchor, pasteCount } = args
  let topLeft: ClipPoint
  if (anchor !== null) {
    const w = Math.max(...clip.nodes.map((n) => n.relPos.x + (n.size?.w ?? 0)), 0)
    const h = Math.max(...clip.nodes.map((n) => n.relPos.y + (n.size?.h ?? 0)), 0)
    topLeft = { x: anchor.x - w / 2, y: anchor.y - h / 2 }
  } else {
    const step = PASTE_STEP_PX * Math.max(1, pasteCount)
    topLeft = { x: clip.origin.x + step, y: clip.origin.y + step }
  }
  const out: Array<{ id: string; position: ClipPoint }> = []
  const n = Math.min(nodeIds.length, clip.nodes.length)
  for (let i = 0; i < n; i++) {
    out.push({
      id: nodeIds[i],
      position: {
        x: topLeft.x + clip.nodes[i].relPos.x,
        y: topLeft.y + clip.nodes[i].relPos.y,
      },
    })
  }
  return out
}
