/**
 * Structural-sharing merge for Workflow snapshots.
 *
 * The viewer broadcasts the full workflow on every chokidar fire. Most
 * of those broadcasts either:
 *   - contain identical content (the agent read+rewrote the file with
 *     no real change), or
 *   - change one or two nodes out of N.
 *
 * Replacing the React state on every push would re-run downstream
 * `useMemo(projection, [workflow])` and force React Flow to re-diff
 * the whole graph. `mergeWorkflow` returns the previous reference when
 * nothing changed, and preserves identity per node/edge/group when an
 * individual element didn't change — so the parent useMemo can
 * short-circuit and per-node memos can recognise unchanged elements
 * by reference.
 */
import type { CanvasNode, Edge, Group, Workflow } from '@/types/canvas'

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

function nodeEqual(a: CanvasNode, b: CanvasNode): boolean {
  return a.id === b.id && a.type === b.type && deepEqual(a.data, b.data)
}

function edgeEqual(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.to === b.to && a.kind === b.kind
}

function groupEqual(a: Group, b: Group): boolean {
  if (a.id !== b.id) return false
  if (a.title !== b.title) return false
  if (a.hue !== b.hue) return false
  if (a.node_ids.length !== b.node_ids.length) return false
  for (let i = 0; i < a.node_ids.length; i++) {
    if (a.node_ids[i] !== b.node_ids[i]) return false
  }
  return true
}

function mergeNodes(prev: CanvasNode[], next: CanvasNode[]): CanvasNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n] as const))
  const result = next.map((n) => {
    const existing = prevById.get(n.id)
    return existing && nodeEqual(existing, n) ? existing : n
  })
  if (
    result.length === prev.length &&
    result.every((n, i) => n === prev[i])
  ) {
    return prev
  }
  return result
}

function edgeKey(e: Edge): string {
  return `${e.from}${e.to}${e.kind ?? ''}`
}

function mergeEdges(prev: Edge[], next: Edge[]): Edge[] {
  const prevByKey = new Map(prev.map((e) => [edgeKey(e), e] as const))
  const result = next.map((e) => {
    const existing = prevByKey.get(edgeKey(e))
    return existing && edgeEqual(existing, e) ? existing : e
  })
  if (
    result.length === prev.length &&
    result.every((e, i) => e === prev[i])
  ) {
    return prev
  }
  return result
}

function mergeGroups(
  prev: Group[] | undefined,
  next: Group[] | undefined,
): Group[] | undefined {
  if (prev === undefined && next === undefined) return undefined
  if (prev === undefined) return next
  if (next === undefined) return undefined
  const prevById = new Map(prev.map((g) => [g.id, g] as const))
  const result = next.map((g) => {
    const existing = prevById.get(g.id)
    return existing && groupEqual(existing, g) ? existing : g
  })
  if (
    result.length === prev.length &&
    result.every((g, i) => g === prev[i])
  ) {
    return prev
  }
  return result
}

/**
 * Decorate every asset node's data with the relative viewer URL synthesized
 * from local_path. The wire shape carries only local_path (canvas_schema.js's
 * source of truth); image_url / video_url / audio_url are derived in the
 * client at this single seam so every downstream consumer (projection,
 * useAssets, TimelinePanel, MediaExpandOverlay) reads a populated URL field
 * without needing to know about projectId.
 *
 * Returns a new Workflow when at least one asset node was decorated;
 * otherwise returns the input by reference so structural-sharing in
 * mergeWorkflow can short-circuit.
 */
export function synthesizeAssetUrls(
  workflow: Workflow | null,
  projectId: string | null,
): Workflow | null {
  if (workflow === null || projectId === null) return workflow
  let mutated = false
  const nextNodes = workflow.nodes.map((n) => {
    if (
      n.type !== 'image_result' &&
      n.type !== 'video_result' &&
      n.type !== 'audio_result'
    ) {
      return n
    }
    const d = n.data as { local_path?: string; image_url?: string; video_url?: string; audio_url?: string }
    const lp = typeof d.local_path === 'string' ? d.local_path : null
    if (lp === null || lp === '') return n
    const url = `/projects/${encodeURIComponent(projectId)}/${lp.replace(/^\/+/, '')}`
    const field = n.type === 'image_result' ? 'image_url' : n.type === 'video_result' ? 'video_url' : 'audio_url'
    if (d[field as keyof typeof d] === url) return n
    mutated = true
    return { ...n, data: { ...n.data, [field]: url } } as CanvasNode
  })
  if (!mutated) return workflow
  return { ...workflow, nodes: nextNodes }
}

export function mergeWorkflow(
  prev: Workflow | null,
  next: Workflow | null,
): Workflow | null {
  if (Object.is(prev, next)) return prev
  if (prev === null) return next
  if (next === null) return null

  const mergedNodes = mergeNodes(prev.nodes, next.nodes)
  const mergedEdges = mergeEdges(prev.edges, next.edges)
  const mergedGroups = mergeGroups(prev.groups, next.groups)
  const mergedNextIds = deepEqual(prev.next_ids, next.next_ids) ? prev.next_ids : next.next_ids

  const scalarsEqual =
    prev.version === next.version &&
    prev.workflow_id === next.workflow_id &&
    prev.title === next.title

  const mergedReferencesIdentical =
    mergedNodes === prev.nodes &&
    mergedEdges === prev.edges &&
    mergedGroups === prev.groups &&
    mergedNextIds === prev.next_ids

  if (scalarsEqual && mergedReferencesIdentical) return prev

  return {
    version: next.version,
    workflow_id: next.workflow_id,
    title: next.title,
    nodes: mergedNodes,
    edges: mergedEdges,
    groups: mergedGroups,
    next_ids: mergedNextIds,
  }
}
