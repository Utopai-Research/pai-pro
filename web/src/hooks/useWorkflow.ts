/**
 * useWorkflow — Socket.IO-subscribed bundle for the active project.
 *
 * On mount we GET /projects/:id once for the initial state, then
 * subscribe to the project's Socket.IO room. Server pushes
 * `canvas-state`, `canvas-positions`, `pending-generations`, and
 * `generation-results` on
 * every disk change (chokidar watcher + our HTTP write endpoints both
 * cause these to fire). Failed generation results are folded into the
 * pending-generation list so the canvas has one placeholder surface.
 */
import { useEffect, useMemo, useState } from 'react'
import { getSocket, subscribeProject, VIEWER_URL } from '@/lib/socket'
import { mergeWorkflow, synthesizeAssetUrls } from '@/lib/workflowMerge'
import type {
  GenerationResult,
  PendingGeneration,
  ProjectBundle,
  Workflow,
} from '@/types/canvas'
import type { CanvasPositionsState } from '@/lib/canvas-stub'
import type { AssetStatusEntry } from '@/pages/CanvasPage/NodeActionsContext'

interface UseWorkflowResult {
  workflow: Workflow | null
  canvasPositions: CanvasPositionsState
  pendingGenerations: PendingGeneration[]
  assetStatuses: ReadonlyMap<string, AssetStatusEntry>
  bundle: ProjectBundle | null
  loading: boolean
  error: string | null
}

const EMPTY_POSITIONS: CanvasPositionsState = { positions: {}, groupFrames: {} }
const EMPTY_PENDING: PendingGeneration[] = []
const EMPTY_RESULTS: GenerationResult[] = []
const EMPTY_ASSET_STATUSES: ReadonlyMap<string, AssetStatusEntry> = new Map()

function failedResultToPending(result: GenerationResult): PendingGeneration | null {
  if (result.status === 'succeeded') return null
  if (result.status === 'cancelled' || result.klass === 'cancelled') return null
  return {
    id: result.job_id,
    kind: result.kind,
    stage: 'failed',
    prompt: result.prompt ?? '',
    aspect_ratio: result.aspect_ratio ?? '16:9',
    created_at: result.completed_at ?? null,
    model: result.model,
    size: result.size,
    image_size: result.image_size,
    resolution: result.resolution,
    duration: result.duration,
    cost_usd: result.cost_usd,
    mode: result.mode,
    source_resolution: result.source_resolution,
    target_resolution: result.target_resolution,
    text: result.text,
    position: result.position,
    reference_source_ids: result.reference_source_ids,
    source_node_id: result.source_node_id,
    klass: result.klass,
    message: result.message,
    completed_at: result.completed_at,
    sent: result.sent,
  }
}

function mergeFailedResultsIntoPending(
  pending: PendingGeneration[],
  results: GenerationResult[],
): PendingGeneration[] {
  const pendingIds = new Set(pending.map((p) => p.id))
  const failed = results
    .map(failedResultToPending)
    .filter((p): p is PendingGeneration => p !== null && !pendingIds.has(p.id))
  return failed.length === 0 ? pending : [...pending, ...failed]
}

export function useWorkflow(projectId: string | null): UseWorkflowResult {
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [canvasPositions, setCanvasPositions] =
    useState<CanvasPositionsState>(EMPTY_POSITIONS)
  const [pendingGenerations, setPendingGenerations] =
    useState<PendingGeneration[]>(EMPTY_PENDING)
  const [generationResults, setGenerationResults] =
    useState<GenerationResult[]>(EMPTY_RESULTS)
  const [assetStatuses, setAssetStatuses] =
    useState<ReadonlyMap<string, AssetStatusEntry>>(EMPTY_ASSET_STATUSES)
  const [bundle, setBundle] = useState<ProjectBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projectId === null) {
      setWorkflow(null)
      setCanvasPositions(EMPTY_POSITIONS)
      setPendingGenerations(EMPTY_PENDING)
      setGenerationResults(EMPTY_RESULTS)
      setAssetStatuses(EMPTY_ASSET_STATUSES)
      setBundle(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`${VIEWER_URL}/projects/${encodeURIComponent(projectId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`viewer ${res.status}: ${res.statusText}`)
        return res.json() as Promise<ProjectBundle>
      })
      .then((b) => {
        if (cancelled) return
        setBundle(b)
        setWorkflow((prev) =>
          mergeWorkflow(prev, synthesizeAssetUrls(b.canvas_state, projectId)),
        )
        setCanvasPositions(b.canvas_positions ?? EMPTY_POSITIONS)
        setPendingGenerations(b.pending_generations ?? EMPTY_PENDING)
        setGenerationResults(b.generation_results ?? EMPTY_RESULTS)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    const socket = getSocket()
    const onCanvasState = (msg: { projectId: string; state: Workflow | null }) => {
      if (msg.projectId === projectId) {
        // Structural-sharing merge: keep workflow identity stable when the
        // broadcast carries no real change (common — the agent reads then
        // rewrites workflow.json with identical content), and preserve
        // per-node identity for unchanged nodes so downstream useMemo /
        // React Flow reconciliation can short-circuit.
        setWorkflow((prev) =>
          mergeWorkflow(prev, synthesizeAssetUrls(msg.state, projectId)),
        )
      }
    }
    const onCanvasPositions = (msg: {
      projectId: string
      state: CanvasPositionsState
    }) => {
      if (msg.projectId === projectId) setCanvasPositions(msg.state)
    }
    const onPendingGenerations = (msg: {
      projectId: string
      state: PendingGeneration[]
    }) => {
      if (msg.projectId !== projectId) return
      const incoming = Array.isArray(msg.state) ? msg.state : []
      setPendingGenerations(incoming.length > 0 ? incoming : EMPTY_PENDING)
    }
    const onGenerationResults = (msg: {
      projectId: string
      state: GenerationResult[]
    }) => {
      if (msg.projectId !== projectId) return
      const incoming = Array.isArray(msg.state) ? msg.state : []
      setGenerationResults(incoming.length > 0 ? incoming : EMPTY_RESULTS)
    }
    const onAssetStatusSnapshot = (msg: {
      projectId: string
      state: Record<string, AssetStatusEntry>
    }) => {
      if (msg.projectId !== projectId) return
      const entries = Object.entries(msg.state ?? {})
      setAssetStatuses(entries.length > 0 ? new Map(entries) : EMPTY_ASSET_STATUSES)
    }
    const onAssetStatusUpdate = (msg: {
      url: string
      status: AssetStatusEntry['status']
      reason?: string
    }) => {
      if (!msg?.url) return
      setAssetStatuses((prev) => {
        const next = new Map(prev)
        const entry: AssetStatusEntry = { status: msg.status }
        if (msg.reason !== undefined) entry.reason = msg.reason
        next.set(msg.url, entry)
        return next
      })
    }
    socket.on('canvas-state', onCanvasState)
    socket.on('canvas-positions', onCanvasPositions)
    socket.on('pending-generations', onPendingGenerations)
    socket.on('generation-results', onGenerationResults)
    socket.on('pai-assets-snapshot', onAssetStatusSnapshot)
    socket.on('pai-assets', onAssetStatusUpdate)
    const releaseSubscription = subscribeProject(projectId)

    return () => {
      cancelled = true
      releaseSubscription()
      socket.off('canvas-state', onCanvasState)
      socket.off('canvas-positions', onCanvasPositions)
      socket.off('pending-generations', onPendingGenerations)
      socket.off('generation-results', onGenerationResults)
      socket.off('pai-assets-snapshot', onAssetStatusSnapshot)
      socket.off('pai-assets', onAssetStatusUpdate)
    }
  }, [projectId])

  const visiblePendingGenerations = useMemo(
    () => mergeFailedResultsIntoPending(pendingGenerations, generationResults),
    [pendingGenerations, generationResults],
  )

  return {
    workflow,
    canvasPositions,
    pendingGenerations: visiblePendingGenerations,
    assetStatuses,
    bundle,
    loading,
    error,
  }
}
