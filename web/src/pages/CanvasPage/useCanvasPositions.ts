/**
 * useCanvasPositions — combined listener + persist + drag handlers for
 * canvas position memory.
 *
 * Takes a Workflow object directly (workflow.json is already
 * canvas-shaped) and runs the local projection from `./projection`.
 * Projection emits every node at (0,0); this hook owns position
 * assignment. All position writes go through `@/lib/canvas-stub`
 * (Socket.IO-backed).
 *
 * Responsibilities:
 *   1. Subscribe to the canvas_positions sidecar and merge persisted
 *      positions onto projected nodes.
 *   2. For fresh arrivals: ghost handoff (pending → real), persisted
 *      entry, batch grid-pack (≥2 new ids in one pass), or single-
 *      node spiral placement. Pending-pad placements persist to the
 *      `.pending/<jobId>.json` sidecar; final placements persist to
 *      `canvas_positions.json` — both survive refresh.
 *   3. Maintain React Flow's `nodes` state with the local-as-truth
 *      merge rule that ends the listener-vs-pointer race.
 *   4. Persist drags via `setCanvasNodePosition` (or `setPendingPosition`
 *      for pending pads) with a per-node serial queue (closes the
 *      rapid-drag stale-overwrite race) and a DRAG_EPSILON guard
 *      (skips bridge calls for pure clicks).
 *   5. Expose `onTidy` — manual "reset to clean" that re-runs Tidy
 *      over the current canvas and PATCHes every position.
 */
import {
  applyNodeChanges,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
} from '@xyflow/react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  setCanvasGroupFramePosition,
  setCanvasNodePosition,
  setCanvasNodePositions,
  setPendingPosition,
  subscribeCanvasPositions,
  type CanvasGroupFrame,
} from '@/lib/canvas-stub'
import type { CanvasNode, PendingGeneration, Workflow } from '@/types/canvas'
import { IMAGE_CARD_CHROME_PX, sizeForAspect } from './nodeData'
import { gridPackBatch } from './batchPlace'
import {
  PLACEMENT_PADDING,
  computeAABBSet,
  pickSize,
  placeNode,
  type AABB,
  type Viewport,
} from './placement'
import { ghostMatchKey, projectWorkflowToCanvas } from './projection'
import { useCanvasSaveStatus } from './saveStatusContext'
import { tidyAll } from './tidy'

const DRAG_EPSILON = 1
const EMPTY_PENDING: ReadonlyArray<PendingGeneration> = []

interface UseCanvasPositionsArgs {
  projectId: string | null
  workflow: Workflow | null
  /**
   * In-flight generate_* CLI placeholders. Emitted by the projection
   * as `pending_generation` rfNodes; the merge below spiral-places
   * them via the same path as real arrivals. Browser-only; vanishes
   * when the CLI removes its sidecar.
   */
  pendingGenerations?: ReadonlyArray<PendingGeneration>
  /**
   * Read the current RF transform + container dims on demand. Drives
   * the "anchor visible?" check inside `placeNode` / `gridPackBatch`
   * and the wrap width inside Tidy. Returns null when the canvas
   * wrapper isn't mounted or has zero size (loading / error / empty /
   * hidden-tab states); placement falls back to anchor-only, Tidy
   * falls back to its default wrap width. Container dims come from
   * the wrapper rect, not window.innerWidth/Height, so the right-side
   * Panel (terminal / chat) isn't counted as visible canvas.
   */
  getViewport?: () => Viewport | null
}

interface UseCanvasPositionsResult {
  rfNodes: RFNode[]
  edges: RFEdge[]
  hydrated: boolean
  groupFrames: Record<string, CanvasGroupFrame>
  onNodesChange: (changes: NodeChange[]) => void
  onNodeDragStart: (e: React.MouseEvent, node: RFNode) => void
  onNodeDrag: (e: React.MouseEvent, node: RFNode) => void
  onNodeDragStop: (e: React.MouseEvent, node: RFNode) => void
  onSelectionDragStart: (e: React.MouseEvent, nodes: RFNode[]) => void
  onSelectionDragStop: (e: React.MouseEvent, nodes: RFNode[]) => Promise<void>
  /**
   * Manual "Tidy" — re-runs the type-clustered grid pack over the
   * current canvas and PATCHes every position atomically. Wired to the
   * Tidy button in ZoomBar. No-op when projectId is null or there are
   * no workflow nodes.
   */
  onTidy: () => Promise<void>
}

export function useCanvasPositions({
  projectId,
  workflow,
  pendingGenerations = EMPTY_PENDING,
  getViewport,
}: UseCanvasPositionsArgs): UseCanvasPositionsResult {
  const saveStatus = useCanvasSaveStatus()
  const [rfNodes, setRfNodes] = useState<RFNode[]>([])
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [groupFrames, setGroupFrames] = useState<Record<string, CanvasGroupFrame>>({})
  // Measured rendered heights, captured from React Flow's `dimensions`
  // changes (see onNodesChange) and used by the placement primitives
  // and Tidy so note cards reserve their real on-screen footprint.
  // Short notes hug the next node; long notes (which scroll inside
  // NOTE_BODY_MAX_HEIGHT) match what the browser actually drew.
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  )

  const projection = useMemo(
    () =>
      projectWorkflowToCanvas({
        workflow,
        groupFrames,
        pendingGenerations,
      }),
    [workflow, groupFrames, pendingGenerations],
  )
  const projectedNodes = projection.nodes
  const edges = projection.edges
  // Pending sidecars carry their own dragged position (writePending
  // preserves it across stage transitions). Build a quick lookup so
  // the merge below can skip spiral placement when the sidecar
  // already has a home for this pad.
  const pendingPositionById = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const pg of pendingGenerations) {
      if (pg.position) m.set(pg.id, pg.position)
    }
    return m
  }, [pendingGenerations])
  const groupFramesRef = useRef<Record<string, CanvasGroupFrame>>({})
  useEffect(() => {
    groupFramesRef.current = groupFrames
  }, [groupFrames])
  const [hydrated, setHydrated] = useState(false)
  const draggingIdsRef = useRef<Set<string>>(new Set())
  const dragStartPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const inFlightByNodeRef = useRef<Map<string, Promise<void>>>(new Map())
  const rfNodesRef = useRef<RFNode[]>([])
  useEffect(() => {
    rfNodesRef.current = rfNodes
  }, [rfNodes])

  // Spiral-placement state. `lastPlacedRef` is the "you just touched
  // this" anchor — updated when a fresh node is placed AND on every
  // successful drag-end.
  const lastPlacedRef = useRef<string | null>(null)

  useEffect(() => {
    if (projectId === null) {
      setPositions(new Map())
      setHydrated(true)
      return
    }
    setHydrated(false)
    setPositions(new Map())
    setGroupFrames({})
    const unsub = subscribeCanvasPositions(
      projectId,
      (state) => {
        if (state === null) {
          setPositions(new Map())
          setGroupFrames({})
        } else {
          setPositions(new Map(Object.entries(state.positions)))
          setGroupFrames(state.groupFrames ?? {})
        }
        setHydrated(true)
      },
      (err) => {
        console.warn(`[canvas:${projectId}] positions parse error: ${err.message}`)
        setHydrated(true)
      },
    )
    return unsub
  }, [projectId])

  // Local-as-truth merge:
  //   - mid-drag        → keep local position
  //   - existing & idle → keep local, merge fresh data
  //   - brand-new id    → ghost handoff (if matching pending pad)
  //                     → persisted entry (if any)
  //                     → batch grid-pack (≥2 fresh nodes this pass)
  //                     → spiral placement (everything else)
  //
  // Placement computation runs SYNCHRONOUSLY here in the effect body
  // (not inside a setRfNodes functional updater). Earlier versions
  // pushed to `placements`/`handoffs` from inside the updater closure
  // and relied on the if-check after `setRfNodes` to see populated
  // arrays. React's eager-state optimization usually invokes the
  // updater synchronously, but when the fiber has pending lanes the
  // updater runs LATER during reconciliation — at which point the
  // if-check has already fired with empty arrays and the PATCH never
  // happens. That race left positions un-persisted on un-dragged
  // batch arrivals, so a refresh re-laid them out from scratch. By
  // reading `rfNodesRef.current` (the just-committed rfNodes) as
  // "prev" we get the same data without depending on updater timing.
  useEffect(() => {
    if (!hydrated) return

    const handoffs: Array<{ id: string; position: { x: number; y: number } }> = []
    const placements: Array<{ id: string; position: { x: number; y: number } }> = []
    // Pending pads can't go through `placements` — their ids are
    // ephemeral and the /positions PATCH route rejects unknown
    // workflow ids. Route them through the per-job sidecar instead so
    // the spiral-computed home survives refresh and is read by PR
    // #112's server-side handoff at addBatch.
    const pendingPlacements: Array<{ id: string; position: { x: number; y: number } }> = []
    const vp = getViewport?.() ?? null

    const prev = rfNodesRef.current
    const prevById = new Map(prev.map((n) => [n.id, n]))
    // Ghost handoff: a real image_result / video_result / audio_result
    // landing fresh inherits its matching pending pad's position. Key
    // is the deliverable (prompt for image/video, text for voice).
    const ghostsByKey = new Map<string, RFNode>()
    for (const n of prev) {
      if (n.type !== 'pending_generation') continue
      const key = ghostMatchKey('pending_generation', n.data)
      if (key !== null) ghostsByKey.set(key, n)
    }

    // Running AABB set for spiral placement. Seeded from `prev`
    // (steady state) AND from projectedNodes that already have a
    // resolved position via the persisted-positions sidecar or the
    // pending-pad sidecar (first paint after refresh, where `prev` is
    // empty). Without the second seed, fresh nodes can spiral on top
    // of persisted neighbors on the very first render. Appended-to as
    // each placement decision is made so subsequent fresh nodes in
    // this same merge pass account for earlier ones. Group frames
    // excluded — they overlap members by design.
    const sizeForRFNode = (n: RFNode): { w: number; h: number } => {
      if (n.type === 'pending_generation') {
        const ar = (n.data as { aspect_ratio?: string }).aspect_ratio
        // Match pickSize/image_result: default to 16:9 + add chrome so
        // the ghost AABB matches its rendered footprint.
        const body = sizeForAspect(ar ?? '16:9')
        return { w: body.w, h: body.h + IMAGE_CARD_CHROME_PX }
      }
      return pickSize(
        n.id,
        n.type as CanvasNode['type'],
        n.data as unknown as CanvasNode['data'],
        measuredHeights,
      )
    }
    const runningAabbs: AABB[] = computeAABBSet(
      prev.filter((n) => n.type !== 'group_frame'),
      sizeForRFNode,
    )
    const seededIds = new Set(runningAabbs.map((a) => a.id))
    for (const n of projectedNodes) {
      if (seededIds.has(n.id)) continue
      if (n.type === 'group_frame') continue
      const pos =
        positions.get(n.id) ??
        (n.type === 'pending_generation' ? pendingPositionById.get(n.id) : undefined)
      if (pos === undefined) continue
      const size = sizeForRFNode(n)
      runningAabbs.push({ id: n.id, x: pos.x, y: pos.y, w: size.w, h: size.h })
      seededIds.add(n.id)
    }
    const anchorRightOfLast = (): { x: number; y: number } | null => {
      const lastId = lastPlacedRef.current
      if (lastId === null) return null
      const last = runningAabbs.find((a) => a.id === lastId)
      if (last === undefined) return null
      return { x: last.x + last.w + PLACEMENT_PADDING, y: last.y }
    }

    // Pre-scan: collect fresh-id nodes that need placement (no
    // handoff, no persisted entry, not a frame). If ≥2 land in the
    // same merge pass, route them through gridPackBatch as a unit —
    // multi-file uploads, /script-compose breakdowns, mosaic splits,
    // and first-paint of an unpositioned project all arrive as
    // batches and should land as a grid (3×3 for 9 etc.), not as N
    // independent spirals or a row-major sweep that depends on
    // viewport width.
    const ghostMatches = (n: RFNode | (typeof projectedNodes)[number]): boolean => {
      const key = ghostMatchKey(n.type ?? '', n.data)
      return key !== null && ghostsByKey.has(key)
    }
    const freshPositions = new Map<string, { x: number; y: number }>()
    const batchCandidates: Array<{
      node: (typeof projectedNodes)[number]
      size: { w: number; h: number }
    }> = []
    for (const n of projectedNodes) {
      if (draggingIdsRef.current.has(n.id)) continue
      if (prevById.has(n.id)) continue
      if (n.type === 'group_frame') continue
      if (positions.has(n.id)) continue
      if (ghostMatches(n)) continue
      // Pending pads with a sidecar position skip spiral placement —
      // they already have a home that survives refreshes.
      if (n.type === 'pending_generation' && pendingPositionById.has(n.id)) continue
      batchCandidates.push({ node: n, size: sizeForRFNode(n) })
    }
    if (batchCandidates.length >= 2) {
      const packed = gridPackBatch({
        nodes: batchCandidates.map((c) => ({ id: c.node.id, size: c.size })),
        anchor: anchorRightOfLast(),
        viewport: vp,
        existingAabbs: runningAabbs,
      })
      for (const c of batchCandidates) {
        const pos = packed.get(c.node.id)
        if (pos === undefined) continue
        freshPositions.set(c.node.id, pos)
        runningAabbs.push({ id: c.node.id, x: pos.x, y: pos.y, w: c.size.w, h: c.size.h })
        if (c.node.type === 'pending_generation') {
          pendingPlacements.push({ id: c.node.id, position: pos })
        } else {
          placements.push({ id: c.node.id, position: pos })
        }
      }
      const lastBatch = batchCandidates[batchCandidates.length - 1]
      if (lastBatch !== undefined) lastPlacedRef.current = lastBatch.node.id
    }

    const newRfNodes = projectedNodes.map((n) => {
      if (draggingIdsRef.current.has(n.id)) {
        const old = prevById.get(n.id)
        return old !== undefined ? { ...n, position: old.position, data: old.data } : n
      }
      const old = prevById.get(n.id)
      if (old !== undefined) {
        // Existing node: keep the local position. Spread only when
        // position values disagree to preserve projection's stable
        // RF Node ref (otherwise the WeakMap cache rebuilds for no
        // reason).
        if (old.position.x === n.position.x && old.position.y === n.position.y) {
          return n
        }
        return { ...n, position: old.position }
      }

      // Handoff: a real result lands fresh and matches a prior pending
      // pad by its deliverable (prompt for image/video, text for voice).
      // Inherit the pad's last-seen position (including drag). Skipped
      // when projection already produced that exact position (within
      // DRAG_EPSILON) — saves a redundant sidecar PATCH.
      if (ghostsByKey.size > 0) {
        const key = ghostMatchKey(n.type ?? '', n.data)
        const ghost = key !== null ? ghostsByKey.get(key) : undefined
        if (ghost !== undefined) {
          const dx = Math.abs(ghost.position.x - n.position.x)
          const dy = Math.abs(ghost.position.y - n.position.y)
          if (dx >= DRAG_EPSILON || dy >= DRAG_EPSILON) {
            handoffs.push({ id: n.id, position: ghost.position })
            lastPlacedRef.current = n.id
            return { ...n, position: ghost.position }
          }
        }
      }

      const persisted = positions.get(n.id)
      if (persisted !== undefined) return { ...n, position: persisted }

      if (n.type === 'pending_generation') {
        const sidecarPos = pendingPositionById.get(n.id)
        if (sidecarPos !== undefined) return { ...n, position: sidecarPos }
      }

      // Batch grid-pack result, if the pre-scan produced one for
      // this id. Walks before the single-node spiral so addBatch
      // arrivals don't fall through to N independent placements.
      const fromFresh = freshPositions.get(n.id)
      if (fromFresh !== undefined) return { ...n, position: fromFresh }

      // Single-node spiral placement. Without this, a no-sidecar
      // node landing during page load (or arriving while the tab
      // was closed) would sit at (0,0). group_frame excluded —
      // frames carry their own x/y from the sidecar. Pending pads
      // route to `pendingPlacements` (sidecar PATCH); finals route
      // to `placements` (canvas_positions batch PATCH).
      if (n.type !== 'group_frame') {
        const size = sizeForRFNode(n)
        const placed = placeNode({
          anchor: anchorRightOfLast(),
          viewport: vp,
          size,
          aabbs: runningAabbs,
        })
        runningAabbs.push({
          id: n.id,
          x: placed.x,
          y: placed.y,
          w: size.w,
          h: size.h,
        })
        if (n.type === 'pending_generation') {
          pendingPlacements.push({ id: n.id, position: placed })
        } else {
          placements.push({ id: n.id, position: placed })
        }
        lastPlacedRef.current = n.id
        return { ...n, position: placed }
      }

      return n
    })

    setRfNodes(newRfNodes)

    if (projectId !== null && (handoffs.length > 0 || placements.length > 0)) {
      // One batched PATCH for everything new this pass — handoffs +
      // placements together. N parallel single-id PATCHes used to make
      // each persist its own CORS-preflight round-trip; with N up to
      // 27 most never got past the preflight if the user navigated
      // away. One batch = one preflight = survives unload reliably
      // with keepalive on the PATCH fetch. Server merges atomically.
      void setCanvasNodePositions(projectId, [...handoffs, ...placements]).catch(
        (err) => {
          console.warn(
            `[canvas:${projectId}] batch position persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        },
      )
    }

    if (projectId !== null && pendingPlacements.length > 0) {
      // Pending pads: per-job sidecar PATCHes. No batched endpoint
      // exists for /pending/:jobId, but `keepalive: true` on each call
      // keeps them alive across unload. Once these land, refresh sees
      // the position in the sidecar and PR #112's server handoff has
      // a position to copy onto the final node at addBatch time.
      //
      // Goes through persistPendingSerialized so a spiral PATCH that
      // arrives late (network reorder, retry) can't clobber a user
      // drag PATCH on the same pad — both share the per-id queue.
      for (const pp of pendingPlacements) {
        const p = persistPendingSerialized(pp.id, pp.position)
        inFlightByNodeRef.current.set(pp.id, p)
        void p
          .catch((err) => {
            console.warn(
              `[canvas:${projectId}] pending spiral persist failed for ${pp.id}: ${err instanceof Error ? err.message : String(err)}`,
            )
          })
          .finally(() => {
            if (inFlightByNodeRef.current.get(pp.id) === p) {
              inFlightByNodeRef.current.delete(pp.id)
            }
          })
      }
    }
  }, [
    projectedNodes,
    positions,
    hydrated,
    projectId,
    getViewport,
    measuredHeights,
  ])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Defense-in-depth: drop `remove` changes (deletes must go
    // through the persist API).
    const filtered = changes.filter((c) => c.type !== 'remove')

    // Capture RF's `dimensions` changes so the placement primitives
    // pack note cards against the real rendered height. Dirty-checked
    // so a stable measurement doesn't kick off a no-op re-projection.
    const deltas: Array<[string, number]> = []
    for (const c of changes) {
      if (c.type !== 'dimensions') continue
      const h = c.dimensions?.height
      if (typeof h === 'number' && h > 0) deltas.push([c.id, h])
    }
    if (deltas.length > 0) {
      setMeasuredHeights((prev) => {
        let dirty = false
        const merged = new Map(prev)
        for (const [id, h] of deltas) {
          if (merged.get(id) !== h) {
            merged.set(id, h)
            dirty = true
          }
        }
        return dirty ? merged : prev
      })
    }

    setRfNodes((ns) => applyNodeChanges(filtered, ns))
  }, [])

  interface FrameDragSnapshot {
    frameId: string
    offsets: Map<string, { dx: number; dy: number }>
  }
  const dragSnapshotRef = useRef<FrameDragSnapshot | null>(null)

  const onNodeDragStart = useCallback(
    (_e: React.MouseEvent, node: RFNode) => {
      draggingIdsRef.current.add(node.id)
      dragStartPositionsRef.current.set(node.id, {
        x: node.position.x,
        y: node.position.y,
      })

      if (node.type === 'group_frame') {
        const frame = groupFramesRef.current[node.id]
        if (frame !== undefined) {
          const liveById = new Map(rfNodesRef.current.map((n) => [n.id, n]))
          const offsets = new Map<string, { dx: number; dy: number }>()
          for (const memberId of frame.memberIds) {
            const member = liveById.get(memberId)
            if (member === undefined) continue
            offsets.set(memberId, {
              dx: member.position.x - node.position.x,
              dy: member.position.y - node.position.y,
            })
            draggingIdsRef.current.add(memberId)
            dragStartPositionsRef.current.set(memberId, {
              x: member.position.x,
              y: member.position.y,
            })
          }
          dragSnapshotRef.current = { frameId: node.id, offsets }
        }
      }
    },
    [],
  )

  const onNodeDrag = useCallback(
    (_e: React.MouseEvent, node: RFNode) => {
      const ctx = dragSnapshotRef.current
      if (ctx === null || ctx.frameId !== node.id) return
      setRfNodes((ns) =>
        ns.map((n) => {
          const offset = ctx.offsets.get(n.id)
          if (offset === undefined) return n
          return {
            ...n,
            position: {
              x: node.position.x + offset.dx,
              y: node.position.y + offset.dy,
            },
          }
        }),
      )
    },
    [],
  )

  const persistOne = useCallback(
    async (node: RFNode): Promise<void> => {
      if (projectId === null) {
        throw new Error('persist without projectId')
      }
      await setCanvasNodePosition(projectId, node.id, {
        x: node.position.x,
        y: node.position.y,
      })
    },
    [projectId],
  )

  const persistOneSerialized = useCallback(
    async (node: RFNode): Promise<void> => {
      const prev = inFlightByNodeRef.current.get(node.id)
      if (prev !== undefined) {
        try {
          await prev
        } catch {
          /* prior failure surfaced; proceed */
        }
      }
      return persistOne(node)
    },
    [persistOne],
  )

  const persistFramePositionSerialized = useCallback(
    async (frameId: string, x: number, y: number): Promise<void> => {
      if (projectId === null) {
        throw new Error('frame persist without projectId')
      }
      const prev = inFlightByNodeRef.current.get(frameId)
      if (prev !== undefined) {
        try {
          await prev
        } catch {
          /* prior failure surfaced */
        }
      }
      await setCanvasGroupFramePosition(projectId, frameId, { x, y })
    },
    [projectId],
  )

  // Pending-pad position persist — serialized through the same
  // inFlightByNodeRef queue as workflow nodes so a spiral-persist PATCH
  // and a user drag PATCH on the same pad id never race. One retry on
  // failure: keepalive PATCHes can be dropped silently under burst load
  // (3 parallel CLIs each fire a spiral PATCH, the user's drag joins the
  // queue right after), and the only signal today is a console.warn.
  const persistPendingSerialized = useCallback(
    async (jobId: string, pos: { x: number; y: number }): Promise<void> => {
      if (projectId === null) return
      const prev = inFlightByNodeRef.current.get(jobId)
      if (prev !== undefined) {
        try {
          await prev
        } catch {
          /* surfaced */
        }
      }
      try {
        await setPendingPosition(projectId, jobId, pos)
      } catch {
        await new Promise((r) => setTimeout(r, 200))
        await setPendingPosition(projectId, jobId, pos)
      }
    },
    [projectId],
  )

  const onNodeDragStop = useCallback(
    async (_e: React.MouseEvent, node: RFNode): Promise<void> => {
      const startPos = dragStartPositionsRef.current.get(node.id)
      dragStartPositionsRef.current.delete(node.id)

      const moved =
        startPos === undefined ||
        Math.abs(startPos.x - node.position.x) >= DRAG_EPSILON ||
        Math.abs(startPos.y - node.position.y) >= DRAG_EPSILON

      if (node.type === 'group_frame') {
        const ctx = dragSnapshotRef.current
        dragSnapshotRef.current = null

        if (!moved) {
          draggingIdsRef.current.delete(node.id)
          if (ctx !== null) {
            for (const memberId of ctx.offsets.keys()) {
              draggingIdsRef.current.delete(memberId)
              dragStartPositionsRef.current.delete(memberId)
            }
          }
          return
        }

        saveStatus?.beginPersist()
        let batchFailed = false
        let batchError: string | undefined
        try {
          const promises: Promise<void>[] = []
          const framePromise = persistFramePositionSerialized(
            node.id,
            node.position.x,
            node.position.y,
          )
          inFlightByNodeRef.current.set(node.id, framePromise)
          void framePromise.finally(() => {
            if (inFlightByNodeRef.current.get(node.id) === framePromise) {
              inFlightByNodeRef.current.delete(node.id)
            }
          })
          promises.push(framePromise)
          if (ctx !== null) {
            for (const [memberId, offset] of ctx.offsets) {
              const memberNode: RFNode = {
                id: memberId,
                position: {
                  x: node.position.x + offset.dx,
                  y: node.position.y + offset.dy,
                },
                data: {},
              }
              const p = persistOneSerialized(memberNode)
              inFlightByNodeRef.current.set(memberId, p)
              void p.finally(() => {
                if (inFlightByNodeRef.current.get(memberId) === p) {
                  inFlightByNodeRef.current.delete(memberId)
                }
              })
              promises.push(p)
            }
          }
          const results = await Promise.allSettled(promises)
          for (const r of results) {
            if (r.status === 'rejected') {
              batchFailed = true
              batchError =
                r.reason instanceof Error ? r.reason.message : String(r.reason)
            }
          }
        } catch (err) {
          batchFailed = true
          batchError = err instanceof Error ? err.message : 'frame persist failed'
        } finally {
          saveStatus?.endPersist(batchFailed, batchError)
          draggingIdsRef.current.delete(node.id)
          if (ctx !== null) {
            for (const memberId of ctx.offsets.keys()) {
              draggingIdsRef.current.delete(memberId)
              dragStartPositionsRef.current.delete(memberId)
            }
          }
        }
        return
      }

      // Non-frame single-node path
      if (!moved) {
        draggingIdsRef.current.delete(node.id)
        return
      }

      // Pending pads persist their position in the .pending/<jobId>.json
      // sidecar (NOT canvas_positions.json — those are keyed by stable
      // workflow ids; pending ids vanish when the CLI completes, and
      // the sidecar lifecycle gives us free cleanup). The PATCH route
      // accepts `position` regardless of stage. Routed through the
      // shared in-flight queue so a concurrent spiral-persist PATCH
      // can't overtake the drag — and through saveStatus so a dropped
      // keepalive PATCH (which would otherwise log a console.warn and
      // vanish) surfaces in the pill.
      if (node.type === 'pending_generation') {
        saveStatus?.beginPersist()
        let pendingFailed = false
        let pendingErr: string | undefined
        try {
          const p = persistPendingSerialized(node.id, {
            x: node.position.x,
            y: node.position.y,
          })
          inFlightByNodeRef.current.set(node.id, p)
          void p.finally(() => {
            if (inFlightByNodeRef.current.get(node.id) === p) {
              inFlightByNodeRef.current.delete(node.id)
            }
          })
          await p
        } catch (err) {
          pendingFailed = true
          pendingErr = err instanceof Error ? err.message : 'pending persist failed'
          console.warn(
            `[canvas:${projectId ?? '<null>'}] pending position persist failed for ${node.id}: ${pendingErr}`,
          )
        } finally {
          saveStatus?.endPersist(pendingFailed, pendingErr)
          lastPlacedRef.current = node.id
          draggingIdsRef.current.delete(node.id)
        }
        return
      }

      // Drag-end is intent: "you just touched this". Anchor the next
      // spiral placement here regardless of whether the persist below
      // succeeds — the anchor is session-local and the visual
      // intention stands either way.
      lastPlacedRef.current = node.id

      saveStatus?.beginPersist()
      let failed = false
      let errMsg: string | undefined
      try {
        const p = persistOneSerialized(node)
        inFlightByNodeRef.current.set(node.id, p)
        void p.finally(() => {
          if (inFlightByNodeRef.current.get(node.id) === p) {
            inFlightByNodeRef.current.delete(node.id)
          }
        })
        await p
      } catch (err) {
        failed = true
        errMsg = err instanceof Error ? err.message : 'persist failed'
        console.warn(
          `[canvas:${projectId ?? '<null>'}] drag persist failed for ${node.id}: ${errMsg}`,
        )
      } finally {
        saveStatus?.endPersist(failed, errMsg)
        draggingIdsRef.current.delete(node.id)
      }
    },
    [persistOneSerialized, persistFramePositionSerialized, persistPendingSerialized, saveStatus, projectId],
  )

  const onSelectionDragStart = useCallback(
    (_e: React.MouseEvent, nodes: RFNode[]) => {
      for (const n of nodes) {
        draggingIdsRef.current.add(n.id)
        dragStartPositionsRef.current.set(n.id, {
          x: n.position.x,
          y: n.position.y,
        })
      }
    },
    [],
  )

  const onSelectionDragStop = useCallback(
    async (_e: React.MouseEvent, nodes: RFNode[]): Promise<void> => {
      const liveById = new Map(rfNodesRef.current.map((n) => [n.id, n]))
      const targets: RFNode[] = nodes.map((n) => liveById.get(n.id) ?? n)

      let moved = false
      for (const n of targets) {
        const startPos = dragStartPositionsRef.current.get(n.id)
        if (
          startPos === undefined ||
          Math.abs(startPos.x - n.position.x) >= DRAG_EPSILON ||
          Math.abs(startPos.y - n.position.y) >= DRAG_EPSILON
        ) {
          moved = true
          break
        }
      }

      for (const n of targets) {
        dragStartPositionsRef.current.delete(n.id)
      }

      if (!moved) {
        for (const n of targets) {
          draggingIdsRef.current.delete(n.id)
        }
        return
      }

      // Pending pads persist via the .pending sidecar; workflow nodes
      // (image/video/etc) use canvas_positions.json. Split them so the
      // two paths fire in parallel and the batch-PATCH below sees only
      // workflow ids (its endpoint doesn't know about pendings).
      const pendingTargets = targets.filter((n) => n.type === 'pending_generation')
      const persistTargets = targets.filter((n) => n.type !== 'pending_generation')

      for (const n of pendingTargets) {
        setPendingPosition(projectId, n.id, { x: n.position.x, y: n.position.y }).catch((err) => {
          console.warn(
            `[canvas:${projectId ?? '<null>'}] pending position persist failed for ${n.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }

      if (persistTargets.length === 0) {
        for (const n of targets) {
          draggingIdsRef.current.delete(n.id)
        }
        return
      }

      // Anchor the next spiral placement to the last node in the
      // selection. Deterministic, matches the single-node drag-end
      // semantic ("you just touched this").
      lastPlacedRef.current = persistTargets[persistTargets.length - 1]?.id ?? null

      saveStatus?.beginPersist()

      const promises = persistTargets.map((n) => {
        const p = persistOneSerialized(n)
        inFlightByNodeRef.current.set(n.id, p)
        void p.finally(() => {
          if (inFlightByNodeRef.current.get(n.id) === p) {
            inFlightByNodeRef.current.delete(n.id)
          }
        })
        return p
      })
      const results = await Promise.allSettled(promises)

      let batchFailed = false
      let batchError: string | undefined
      for (const r of results) {
        if (r.status === 'rejected') {
          batchFailed = true
          batchError = r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      }
      saveStatus?.endPersist(batchFailed, batchError)

      for (const n of targets) {
        draggingIdsRef.current.delete(n.id)
      }
    },
    [persistOneSerialized, saveStatus],
  )

  const onTidy = useCallback(async (): Promise<void> => {
    if (projectId === null || workflow === null || workflow.nodes.length === 0) return
    const vp = getViewport?.() ?? null
    const tidied = tidyAll({
      nodes: workflow.nodes,
      edges: workflow.edges,
      sizeFor: (wn) => pickSize(wn.id, wn.type, wn.data, measuredHeights),
      wrapWidth: vp !== null ? (vp.width * 2) / vp.zoom : undefined,
    })
    saveStatus?.beginPersist()
    let failed = false
    let errMsg: string | undefined
    try {
      const updates = [...tidied.entries()].map(([id, position]) => ({ id, position }))
      await setCanvasNodePositions(projectId, updates)
    } catch (err) {
      failed = true
      errMsg = err instanceof Error ? err.message : String(err)
    }
    saveStatus?.endPersist(failed, errMsg)
    // Reset the anchor — Tidy is a "clean slate", so the next single-
    // node placement falls back to viewport center until something
    // new gets placed or dragged.
    lastPlacedRef.current = null
  }, [projectId, workflow, getViewport, measuredHeights, saveStatus])

  return useMemo(
    () => ({
      rfNodes,
      edges,
      hydrated,
      groupFrames,
      onNodesChange,
      onNodeDragStart,
      onNodeDrag,
      onNodeDragStop,
      onSelectionDragStart,
      onSelectionDragStop,
      onTidy,
    }),
    [
      rfNodes,
      edges,
      hydrated,
      groupFrames,
      onNodesChange,
      onNodeDragStart,
      onNodeDrag,
      onNodeDragStop,
      onSelectionDragStart,
      onSelectionDragStop,
      onTidy,
    ],
  )
}
