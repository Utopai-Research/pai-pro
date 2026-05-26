/**
 * Projection: workflow.json → React Flow nodes/edges.
 *
 * workflow.json already carries the exact node shapes the renderer
 * needs (`note`, `image_result`, `video_result`, `audio_result`), so
 * projection is pure pass-through. Every node is emitted at (0,0);
 * useCanvasPositions' merge layer assigns real positions from either
 * the sidecar, the spiral placement primitive, the batch grid-pack,
 * or the one-time Tidy on first load.
 *
 * Mostly pure: a module-level WeakMap caches the last RF Node built
 * for each workflow-node reference (see `rfNodeCache` / `rfEdgeCache`
 * below). When the upstream merge keeps a workflow node's reference
 * stable, the projection returns the *same* RF Node reference, which
 * lets React Flow's reconciler skip the diff and lets `memo()`-
 * wrapped node components bail out of re-rendering.
 *
 * Input: parsed `workflow.json` plus optional groupFrames sidecar.
 * Output: `{ nodes, edges }` ready to pass to <ReactFlow>.
 */
import type { Edge, Node } from '@xyflow/react'
import type { CanvasGroupFrame } from '@/lib/canvas-stub'
import type {
  AudioResultNode,
  CanvasNode,
  Edge as WfEdge,
  ImageResultNode,
  NoteNode,
  PendingGeneration,
  VideoResultNode,
  Workflow,
} from '@/types/canvas'
import type { MediaRef } from './MediaExpandOverlay'
import { IMAGE_CARD_CHROME_PX, NODE_SIZES, sizeForAspect } from './nodeData'
import { pickSize } from './placement'

/**
 * Index every asset node's renderable ref (kind + URL) by node id.
 * The URL field is populated on every asset node by `synthesizeAssetUrls`
 * at the useWorkflow seam, so we just read it here.
 */
function buildAssetRefIndex(wfNodes: CanvasNode[]): Map<string, MediaRef> {
  const out = new Map<string, MediaRef>()
  for (const n of wfNodes) {
    const d = n.data as {
      image_url?: unknown
      video_url?: unknown
      audio_url?: unknown
    }
    if (n.type === 'image_result' && typeof d.image_url === 'string' && d.image_url !== '') {
      out.set(n.id, { kind: 'image', url: d.image_url })
    } else if (n.type === 'video_result' && typeof d.video_url === 'string' && d.video_url !== '') {
      out.set(n.id, { kind: 'video', url: d.video_url })
    } else if (n.type === 'audio_result' && typeof d.audio_url === 'string' && d.audio_url !== '') {
      out.set(n.id, { kind: 'audio', url: d.audio_url })
    }
  }
  return out
}

/**
 * For each asset node, gather the inbound canvas refs (sources that
 * connected to it via a `derived` edge from --ref-source-id /
 * --source-node-id). MediaExpandOverlay reads `references` to paint the
 * REFERENCES section; we synthesize the list from those edges.
 *
 * Caller-friendly: also exported as `collectDerivedRefs` for code paths
 * that don't go through the renderer (e.g. CanvasPage's
 * `buildExpandPayload`, which builds payloads for sidebar dblclicks).
 */
function buildDerivedRefsByTarget(
  wfNodes: CanvasNode[],
  wfEdges: WfEdge[],
): Map<string, MediaRef[]> {
  const refByNodeId = buildAssetRefIndex(wfNodes)
  const out = new Map<string, MediaRef[]>()
  for (const e of wfEdges) {
    if (e.kind !== 'derived') continue
    const src = refByNodeId.get(e.from)
    if (src === undefined) continue
    const list = out.get(e.to)
    if (list === undefined) {
      out.set(e.to, [src])
    } else {
      list.push(src)
    }
  }
  return out
}

/**
 * Public helper for code paths that build a MediaPayload outside the
 * projection pass (e.g. CanvasPage.buildExpandPayload for sidebar dblclick
 * on a workflow node). Returns the same derived-ref list the projection
 * would produce for `nodeId`.
 */
export function collectDerivedRefs(
  workflow: Workflow | null,
  nodeId: string,
): MediaRef[] {
  if (workflow === null) return []
  const map = buildDerivedRefsByTarget(workflow.nodes, workflow.edges)
  return map.get(nodeId) ?? []
}

// Stable signature used as part of the rfNodeCache key — incoming-edge
// changes don't always replace a node's data reference (mergeWorkflow
// preserves it), so we need to detect derived_refs changes independently
// to avoid serving stale projected data.
function derivedRefsKey(refs: MediaRef[]): string {
  if (refs.length === 0) return ''
  return refs.map((r) => `${r.kind}:${r.url}`).join('|')
}

// Per-node cache: keyed by workflow-node reference. Holds the last
// RF Node we built for it plus the loop-derived index / shortId.
// WeakMap so removed workflow nodes auto-GC. The merge layer in
// useCanvasPositions is responsible for assigning positions, so the
// cached RF Node's `position` stays at (0,0) — the merge spreads a
// new object with the real position when it needs one.
type CachedRfNode = {
  rfNode: Node
  index: number
  shortId: string
  // Set of incoming-edge ref URLs, joined. Cache hits require this to
  // match the current pass — otherwise edge changes that don't touch the
  // node's own data reference (mergeWorkflow preserves it) would serve
  // stale projected data with empty `derived_refs`.
  derivedRefsKey: string
}
const rfNodeCache = new WeakMap<CanvasNode, CachedRfNode>()
const rfEdgeCache = new WeakMap<WfEdge, Edge>()

/**
 * Match key for ghost-handoff + pending suppression. Image/video match
 * on prompt (the deliverable); voice matches on text (the spoken line —
 * voice design prompt isn't unique). Prefix keeps cross-kind collisions
 * impossible. Returns null when the relevant field is empty.
 *
 * Accepts either a workflow result node (`image_result` / `video_result`
 * / `audio_result`) or a pending pad (`pending_generation` whose data
 * carries `kind`). Both shapes share `prompt` + `text` field names.
 */
export function ghostMatchKey(type: string, data: unknown): string | null {
  const d = data as { kind?: string; prompt?: string; text?: string }
  let kind: 'image' | 'video' | 'audio' | null = null
  if (type === 'pending_generation') {
    kind = d.kind === 'image' || d.kind === 'video' || d.kind === 'audio' ? d.kind : null
  } else if (type === 'image_result') kind = 'image'
  else if (type === 'video_result') kind = 'video'
  else if (type === 'audio_result') kind = 'audio'
  if (kind === null) return null
  if (kind === 'audio') {
    const t = String(d.text ?? '').trim()
    return t !== '' ? `audio:${t}` : null
  }
  const p = String(d.prompt ?? '').trim()
  return p !== '' ? `media:${p}` : null
}

export interface ProjectionInput {
  workflow: Workflow | null
  /**
   * Group frames from a (future) canvas_state sidecar. Optional —
   * empty record when no groups are persisted as frames. The
   * workflow's own `groups` array is still rendered as semantic
   * groups in the listing UI; this is the spatial frame variant.
   */
  groupFrames?: Record<string, CanvasGroupFrame>
  /**
   * Pending-generation placeholders sourced from .pending/<jobId>.json
   * sidecars on disk. Emitted as `pending_generation` rfNodes at (0,0);
   * useCanvasPositions's spiral placement assigns the real position on
   * arrival. Visual dashed edges from each ref's source node are
   * rendered so the user sees the wiring; those edges never flow into
   * the layout. Browser-only — never persisted into workflow.json.
   * Vanishes when the CLI's `finally` removes its sidecar.
   */
  pendingGenerations?: ReadonlyArray<PendingGeneration>
}

export interface ProjectionOutput {
  nodes: Node[]
  edges: Edge[]
}

function noteData(n: NoteNode, shortId: string) {
  return {
    label: n.data.label,
    body: n.data.body,
    subtype: n.data.subtype,
    shortId,
    state: 'complete' as const,
  }
}

function imageNodeData(n: ImageResultNode, shortId: string, derivedRefs: MediaRef[]) {
  const d = n.data
  return {
    image_url: d.image_url,
    label: d.label,
    subtype: d.subtype ?? 'image',
    name: d.name,
    role: d.role,
    description: d.description,
    source_id: d.source_id,
    source_filename: d.source_filename,
    prompt: d.prompt,
    state: 'complete' as const,
    shortId,
    derived_refs: derivedRefs,
    metadata: {
      aspect_ratio: d.metadata?.aspect_ratio,
      image_size: d.metadata?.image_size,
      model: d.metadata?.model,
      source: d.metadata?.source,
      generated_at: d.metadata?.generated_at,
    },
  }
}

function audioNodeData(n: AudioResultNode, shortId: string, derivedRefs: MediaRef[]) {
  const d = n.data
  return {
    audio_url: d.audio_url,
    label: d.label,
    subtype: d.subtype,
    // `text` is the deliverable key ghostMatchKey reads for audio —
    // without it, undragged pending voice pads can't be handed off to
    // their real audio_result and snap to a fresh spiral position.
    text: d.text,
    state: 'complete' as const,
    shortId,
    derived_refs: derivedRefs,
    metadata: { duration_sec: d.metadata?.duration_sec },
  }
}

function videoNodeData(n: VideoResultNode, shortId: string, derivedRefs: MediaRef[]) {
  const d = n.data
  return {
    video_url: d.video_url,
    label: d.label,
    shot_id: d.shot_id,
    aspect: d.aspect,
    duration: d.duration,
    prompt: d.prompt,
    shortId,
    state: 'complete' as const,
    derived_refs: derivedRefs,
    metadata: {
      aspect_ratio: d.metadata?.aspect_ratio,
      resolution: d.metadata?.resolution,
      model: d.metadata?.model,
      source: d.metadata?.source,
      generated_at: d.metadata?.generated_at,
    },
  }
}

export function projectWorkflowToCanvas(
  input: ProjectionInput,
): ProjectionOutput {
  const nodes: Node[] = []
  const edges: Edge[] = []

  // Treat null-workflow as an empty workflow so pending placeholders still
  // render (the project may have a generation kicked off before workflow.json
  // is first written).
  const wfNodes = input.workflow?.nodes ?? []
  const wfEdges = input.workflow?.edges ?? []

  // Synthesize the REFERENCES list for each asset node from incoming
  // `derived` edges so the overlay's REFERENCES section shows the
  // source canvas nodes that fed this one. See `buildDerivedRefsByTarget`.
  const derivedRefsByTarget = buildDerivedRefsByTarget(wfNodes, wfEdges)

  // Soft-delete: archived nodes (and their edges + all-archived frames)
  // drop from the projection. The workflow.json entry survives.
  const archivedIds = new Set<string>()
  for (const n of wfNodes) {
    if ((n.data as { archived?: boolean })?.archived === true) {
      archivedIds.add(n.id)
    }
  }

  // ── Pending-generation placeholders ──────────────────────────────
  //
  // Pending pads are emitted as `pending_generation` RFNodes at (0,0);
  // useCanvasPositions's spiral placement assigns them a visible spot.
  //
  // Suppression matches on the deliverable key (prompt for image/video,
  // text for voice). When the real result lands, the placeholder can
  // vanish even if the watcher's unlink event is still in flight.
  const liveKeys = new Set<string>()
  for (const wfNode of wfNodes) {
    const key = ghostMatchKey(wfNode.type, wfNode.data)
    if (key !== null) liveKeys.add(key)
  }
  const visiblePending: PendingGeneration[] = []
  for (const pg of input.pendingGenerations ?? []) {
    // Drafts and failed pads are explicit user-visible states — never
    // auto-suppress them just because another node shares the prompt.
    if (pg.stage === 'draft' || pg.stage === 'failed') {
      visiblePending.push(pg)
      continue
    }
    const key = ghostMatchKey('pending_generation', {
      kind: pg.kind, prompt: pg.prompt, text: pg.text,
    })
    if (key !== null && liveKeys.has(key)) continue
    visiblePending.push(pg)
  }

  // Visual-only dashed edges from each ref-source workflow node into
  // the pending pad so the user sees the wiring while the CLI is in
  // flight. Pure visual — never fed into layout.
  //
  // The same id→MediaRef index resolves source-id refs into the
  // overlay's REFERENCES list (@Audio1 / @Image1 chip thumbnails).
  const idToMediaRef = buildAssetRefIndex(wfNodes)
  const pendingVisualEdges: Array<{ from: string; to: string }> = []
  const wfNodeIds = new Set(wfNodes.map((n) => n.id))
  for (const pg of visiblePending) {
    const seen = new Set<string>()
    // Authorship parent — dashed edge from --source-node-id into pad.
    if (typeof pg.source_node_id === 'string' && pg.source_node_id !== ''
        && wfNodeIds.has(pg.source_node_id)) {
      pendingVisualEdges.push({ from: pg.source_node_id, to: pg.id })
      seen.add(pg.source_node_id)
    }
    // Byte refs — dashed edge per --ref-source-id (image, video, audio
    // sources merged in the CLI's lineage derivation).
    for (const srcId of pg.reference_source_ids ?? []) {
      if (!wfNodeIds.has(srcId) || seen.has(srcId)) continue
      pendingVisualEdges.push({ from: srcId, to: pg.id })
      seen.add(srcId)
    }
  }

  const pendingSize = (pg: PendingGeneration): { w: number; h: number } => {
    const s = sizeForAspect(pg.aspect_ratio)
    // Ghost renders as an image card; add chrome so its AABB matches
    // what's painted (consistent with pickSize for image_result).
    if (s.w > 0 && s.h > 0) return { w: s.w, h: s.h + IMAGE_CARD_CHROME_PX }
    return NODE_SIZES.pending_generation
  }

  // shortId == node.id. The canonical id form is already
  // `image_N` / `note_N` / `video_N` (CLAUDE.md), so the canvas's
  // @-mention pills resolve to literal node ids the agent reads
  // straight out of workflow.json.
  for (let i = 0; i < wfNodes.length; i += 1) {
    const wfNode = wfNodes[i]
    // Skip inside the loop so `i` stays stable for the rfNodeCache
    // index check below — non-archived nodes keep their cache hits.
    if (archivedIds.has(wfNode.id)) continue
    if (
      wfNode.type !== 'note' &&
      wfNode.type !== 'image_result' &&
      wfNode.type !== 'video_result' &&
      wfNode.type !== 'audio_result'
    ) {
      continue
    }
    const shortId: string = wfNode.id
    const nodeDerivedRefs = derivedRefsByTarget.get(wfNode.id) ?? []
    const drKey = derivedRefsKey(nodeDerivedRefs)

    // Cache hit when the workflow-node ref is preserved upstream AND
    // its index / shortId / derived-refs signature are unchanged.
    // Position is owned by the merge layer (useCanvasPositions) which
    // spreads in its own {x,y} when needed — so we don't include it in
    // the cache key.
    const cached = rfNodeCache.get(wfNode)
    if (
      cached !== undefined &&
      cached.index === i &&
      cached.shortId === shortId &&
      cached.derivedRefsKey === drKey
    ) {
      nodes.push(cached.rfNode)
      continue
    }

    // Width-only: measured note heights live in useCanvasPositions
    // and feed into placement / Tidy; projection only sets the card
    // width, so passing `undefined` for measuredHeights is safe (note
    // width is constant 280 regardless).
    const w = pickSize(wfNode.id, wfNode.type, wfNode.data, undefined).w
    let rfNode: Node
    if (wfNode.type === 'note') {
      rfNode = {
        id: wfNode.id,
        type: 'note',
        position: { x: 0, y: 0 },
        data: noteData(wfNode, shortId),
        style: { width: w },
        zIndex: 1,
      }
    } else if (wfNode.type === 'image_result') {
      rfNode = {
        id: wfNode.id,
        type: 'image_result',
        position: { x: 0, y: 0 },
        data: imageNodeData(wfNode, shortId, nodeDerivedRefs),
        style: { width: w },
        zIndex: 1,
      }
    } else if (wfNode.type === 'audio_result') {
      rfNode = {
        id: wfNode.id,
        type: 'audio_result',
        position: { x: 0, y: 0 },
        data: audioNodeData(wfNode, shortId, nodeDerivedRefs),
        style: { width: w },
        zIndex: 1,
      }
    } else {
      rfNode = {
        id: wfNode.id,
        type: 'video_result',
        position: { x: 0, y: 0 },
        data: videoNodeData(wfNode, shortId, nodeDerivedRefs),
        style: { width: w },
        zIndex: 1,
      }
    }
    rfNodeCache.set(wfNode, { rfNode, index: i, shortId, derivedRefsKey: drKey })
    nodes.push(rfNode)
  }

  // Emit pending placeholder RFNodes at (0,0) — useCanvasPositions's
  // spiral placement assigns the real position on the next merge.
  //
  // Both selectable + draggable are left at React Flow defaults (true)
  // so the user can click the expand button and reposition the pad
  // while the CLI is in flight. `useCanvasPositions` routes pending-
  // pad drags to the `.pending/<jobId>.json` sidecar via
  // `setPendingPosition`, keeping the ephemeral pending id out of
  // `canvas_positions.json` — see onNodeDragStop.
  for (const pg of visiblePending) {
    const size = pendingSize(pg)
    // Sidecar-persisted position survives refresh; useCanvasPositions
    // sees this non-(0,0) anchor and skips the spiral placement for
    // pendings that already have a home.
    const position = pg.position ?? { x: 0, y: 0 }
    // Resolve source-id refs into the chip-preview list the
    // pending-pad component consumes. MediaExpandOverlay's REFERENCES
    // section + @Image1 / @Audio1 chip resolution read this list.
    // Authorship parent goes first so its slot is stable.
    const refs: Array<{ kind: 'image' | 'video' | 'audio'; url: string }> = []
    const seenIds = new Set<string>()
    if (typeof pg.source_node_id === 'string' && pg.source_node_id !== '') {
      const r = idToMediaRef.get(pg.source_node_id)
      if (r !== undefined) {
        refs.push(r)
        seenIds.add(pg.source_node_id)
      }
    }
    for (const srcId of pg.reference_source_ids ?? []) {
      if (seenIds.has(srcId)) continue
      const r = idToMediaRef.get(srcId)
      if (r === undefined) continue
      refs.push(r)
      seenIds.add(srcId)
    }
    nodes.push({
      id: pg.id,
      type: 'pending_generation',
      position,
      data: {
        kind: pg.kind,
        stage: pg.stage,
        prompt: pg.prompt,
        aspect_ratio: pg.aspect_ratio,
        references: refs,
        model: pg.model,
        image_size: pg.image_size,
        resolution: pg.resolution,
        duration: pg.duration,
        cost_usd: pg.cost_usd,
        text: pg.text,
        klass: pg.klass,
        message: pg.message,
        sent: pg.sent,
        shortId: pg.id,
      },
      style: { width: size.w },
      zIndex: 1,
    })
  }

  for (const e of wfEdges as WfEdge[]) {
    if (archivedIds.has(e.from) || archivedIds.has(e.to)) continue
    // Edge cache: A1's mergeEdges keeps edge object refs stable when
    // their (from, to, kind) tuple is unchanged. Same WeakMap trick.
    const cachedEdge = rfEdgeCache.get(e)
    if (cachedEdge !== undefined) {
      edges.push(cachedEdge)
      continue
    }
    const rfEdge: Edge = {
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      type: 'default',
      data: { kind: e.kind ?? 'derived' },
    }
    rfEdgeCache.set(e, rfEdge)
    edges.push(rfEdge)
  }

  // Transient dashed edges from ref source nodes into pending pads so
  // the user sees the wiring while the CLI is in flight. Visual only;
  // never fed into layout and never persisted.
  for (const e of pendingVisualEdges) {
    edges.push({
      id: `pending:${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      data: { kind: 'derived' },
      style: { strokeDasharray: '4 4' },
    })
  }

  // Synthetic group_frame nodes from the optional sidecar. The
  // workflow's own `groups` array is metadata-only (no spatial
  // frame); spatial frames need x/y/width/height which we'd persist
  // in canvas_state separately.
  if (input.groupFrames !== undefined) {
    for (const [frameId, frame] of Object.entries(input.groupFrames)) {
      // Hide frame when every member is archived; reappears on restore.
      const visibleCount = frame.memberIds.filter(
        (id) => !archivedIds.has(id),
      ).length
      if (visibleCount === 0) continue
      nodes.push({
        id: frameId,
        type: 'group_frame',
        position: { x: frame.x, y: frame.y },
        style: { width: frame.width, height: frame.height },
        data: {
          title: frame.title,
          hue: frame.hue,
          memberIds: frame.memberIds,
          width: frame.width,
          height: frame.height,
          shortId: frameId,
        },
        zIndex: 0,
        draggable: true,
        selectable: true,
      })
    }
  }

  return { nodes, edges }
}
