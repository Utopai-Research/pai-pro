/**
 * CanvasPage — main React Flow surface. workflow.json IS the canvas;
 * we pull it via `useWorkflow(projectId)` and Socket.IO live-syncs
 * server-side mutations. All canvas-position writes go through
 * `@/lib/canvas-stub`.
 *
 * Layered features:
 *   - useCanvasPositions: subscribe + persist + drag handlers.
 *   - SaveStatusPill: 3-state UI indicator + beforeunload guard.
 *   - SelectionToolbar: floating pill with "+ Group" + "📎 Refer".
 *   - GroupCreateModal: title + hue picker.
 *   - Cmd+G keyboard shortcut.
 *   - Dev-bridge `window.__pai_pro_dev`.
 */
import '@xyflow/react/dist/style.css'
import './canvas-overlays.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Node as RFNode,
} from '@xyflow/react'
import {
  deleteCanvasGroupFrame,
  discardPendingDraft,
  firePendingDraft,
  mutateCanvas,
  patchPendingDraft,
  setCanvasGroupFrame,
  setCanvasNodePosition,
  type CanvasGroupFrame,
} from '@/lib/canvas-stub'
import { DRAG_MIME } from '@/components/AssetRail/AssetRow'
import { useCanvasFocusRegistration } from '@/contexts/CanvasFocusContext'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { useMediaExpandRegistration } from '@/contexts/MediaExpandContext'
import { ProjectProvider } from '@/contexts/ProjectContext'
import { useWorkflow } from '@/hooks/useWorkflow'
import { FireConfirmProvider } from './FireConfirmProvider'
import { GroupCreateModal } from './GroupCreateModal'
import { HighlightEdge } from './HighlightEdge'
import {
  AssetStatusProvider,
  NodeActionsProvider,
  type NodeActionsContextValue,
} from './NodeActionsContext'
import { MediaExpandOverlay, type MediaPayload } from './MediaExpandOverlay'
import { collectDerivedRefs } from './projection'
import type { CanvasNode, Workflow } from '@/types/canvas'
import { nodeTypes } from './nodes'
import type { Viewport } from './placement'
import { CanvasSaveStatusProvider } from './saveStatusContext'
import { SaveStatusPill } from './SaveStatusPill'
import { SelectionToolbar } from './SelectionToolbar'
import { UploadOverlay } from './UploadOverlay'
import { useCanvasPositions } from './useCanvasPositions'
import { ZoomBar } from './ZoomBar'

const edgeTypes = { default: HighlightEdge }

// Hoisted to module scope so the props passed to <ReactFlow> / <MiniMap>
// keep stable references across renders. RF treats fresh prop refs as
// "changed" and feeds them through its internal reconciliation; inline
// literals or arrow functions defeat that. Same spirit as A2's stable
// nodeTypes registry.
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true }

const FRAME_BBOX_PADDING = 24
const DEFAULT_NODE_WIDTH = 260
const DEFAULT_NODE_HEIGHT = 260

/**
 * Build the overlay payload from a raw workflow node. Mirrors the
 * per-node-component handlers in `./nodes/*` so dblclick-from-sidebar
 * lands the same shape as dblclick-on-canvas. Handles archived nodes
 * (which aren't in React Flow) the same way as live.
 *
 * `workflow` is needed to surface `--ref-source-id` refs — the
 * REFERENCES section is built from the incoming `derived` edges.
 */
function buildExpandPayload(node: CanvasNode, workflow: Workflow | null): MediaPayload | null {
  const archived = (node.data as { archived?: boolean }).archived === true
  if (node.type === 'image_result') {
    const d = node.data
    return {
      id: node.id,
      kind: 'image',
      url: d.image_url ?? null,
      label: d.label,
      prompt: d.prompt,
      references: collectDerivedRefs(workflow, node.id),
      nodeType: 'image_result',
      metadata: d.metadata,
      archived,
    }
  }
  if (node.type === 'video_result') {
    const d = node.data
    return {
      id: node.id,
      kind: 'video',
      url: d.video_url ?? null,
      label: d.label,
      prompt: d.prompt,
      references: collectDerivedRefs(workflow, node.id),
      nodeType: 'video_result',
      metadata: d.metadata,
      duration: d.duration,
      archived,
    }
  }
  if (node.type === 'audio_result') {
    const d = node.data
    return {
      id: node.id,
      kind: 'audio',
      url: d.audio_url ?? null,
      label: d.label,
      prompt: d.prompt,
      text: d.text,
      references: collectDerivedRefs(workflow, node.id),
      nodeType: 'audio_result',
      metadata: d.metadata,
      archived,
    }
  }
  if (node.type === 'note') {
    const d = node.data
    return {
      id: node.id,
      kind: 'note',
      label: d.label,
      body: d.body,
      subtype: d.subtype,
      nodeType: 'note',
      archived,
    }
  }
  return null
}

export default function CanvasPage(): JSX.Element | null {
  const { projectId = null } = useParams<{ projectId: string }>()
  return (
    <ProjectProvider projectId={projectId}>
      <CanvasSaveStatusProvider>
        <ReactFlowProvider>
          <CanvasPageInner />
        </ReactFlowProvider>
      </CanvasSaveStatusProvider>
    </ProjectProvider>
  )
}

function CanvasPageInner(): JSX.Element | null {
  const { projectId = null } = useParams<{ projectId: string }>()
  const {
    workflow,
    pendingGenerations,
    assetStatuses,
    loading,
    error,
  } = useWorkflow(projectId)

  // Snapshot of the RF transform + container dims, read lazily by
  // placement when a brand-new node arrives. RF instance is stable
  // across renders so the callback identity stays put.
  //
  // Container dims come from the canvas wrapper's bounding rect, not
  // window.innerWidth/Height — the canvas only occupies the left
  // Panel; the right Panel (terminal / chat history) would otherwise
  // get counted as visible canvas and new nodes would land behind it.
  // Returns null when the wrapper isn't mounted (loading / error /
  // empty branches) or has zero size (Timeline tab hides it via
  // display:none); placement.ts handles null with its anchor-only
  // fallback.
  const rf = useReactFlow()
  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  const getViewport = useCallback((): Viewport | null => {
    const host = canvasHostRef.current
    if (host === null) return null
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const vp = rf.getViewport()
    return {
      x: vp.x,
      y: vp.y,
      zoom: vp.zoom,
      width: rect.width,
      height: rect.height,
    }
  }, [rf])

  const {
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
  } = useCanvasPositions({
    projectId,
    workflow,
    pendingGenerations,
    getViewport,
  })

  const composer = useChatComposer()

  const [imageOverrides, setImageOverrides] = useState<
    ReadonlyMap<string, Record<string, unknown>>
  >(() => new Map())
  interface InjectedNode {
    id: string
    type: 'image_result' | 'video_result' | 'pending_generation'
    position: { x: number; y: number }
    data: Record<string, unknown>
  }
  const [injectedNodes, setInjectedNodes] = useState<InjectedNode[]>([])
  const [videoOverrides, setVideoOverrides] = useState<
    ReadonlyMap<string, Record<string, unknown>>
  >(() => new Map())
  const [expandedMedia, setExpandedMedia] = useState<MediaPayload | null>(null)

  const nodeActions = useMemo<NodeActionsContextValue>(
    () => ({
      onExpandMedia: (node) => {
        setExpandedMedia(node as unknown as MediaPayload)
      },
      onSaveNote: async (nodeId, patchData) => {
        await mutateCanvas(projectId, 'updateNode', { id: nodeId, patch: patchData })
      },
      onPatchDraft: async (jobId, patchData) => {
        await patchPendingDraft(projectId, jobId, patchData)
      },
      onFireDraft: async (jobId) => {
        await firePendingDraft(projectId, jobId)
      },
      onDiscardDraft: async (jobId) => {
        await discardPendingDraft(projectId, jobId)
      },
    }),
    [projectId],
  )

  const displayNodes = useMemo(() => {
    const base =
      imageOverrides.size === 0 && videoOverrides.size === 0
        ? rfNodes
        : rfNodes.map((n) => {
            if (n.type === 'image_result') {
              const patch = imageOverrides.get(n.id)
              return patch === undefined ? n : { ...n, data: { ...n.data, ...patch } }
            }
            if (n.type === 'video_result') {
              const patch = videoOverrides.get(n.id)
              return patch === undefined ? n : { ...n, data: { ...n.data, ...patch } }
            }
            return n
          })
    if (injectedNodes.length === 0) return base
    return [...base, ...(injectedNodes as unknown as RFNode[])]
  }, [rfNodes, imageOverrides, videoOverrides, injectedNodes])

  // ── GroupCreateModal state ─────────────────────────────────────────

  const [modalOpen, setModalOpen] = useState(false)
  const [pendingGroupIds, setPendingGroupIds] = useState<string[]>([])

  const openCreateModal = useCallback((selectedIds: string[]) => {
    if (selectedIds.length < 2) return
    setPendingGroupIds(selectedIds)
    setModalOpen(true)
  }, [])

  const closeModal = useCallback(() => {
    setModalOpen(false)
  }, [])

  const onConfirmGroup = useCallback(
    async (title: string, hue: number) => {
      if (projectId === null || pendingGroupIds.length < 2) {
        setModalOpen(false)
        return
      }
      const liveById = new Map(rfNodes.map((n) => [n.id, n]))
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const id of pendingGroupIds) {
        const n = liveById.get(id)
        if (n === undefined) continue
        const nodeWithDims = n as RFNode & {
          width?: number
          height?: number
          measured?: { width?: number; height?: number }
        }
        const w =
          nodeWithDims.width ??
          nodeWithDims.measured?.width ??
          DEFAULT_NODE_WIDTH
        const h =
          nodeWithDims.height ??
          nodeWithDims.measured?.height ??
          DEFAULT_NODE_HEIGHT
        minX = Math.min(minX, n.position.x)
        minY = Math.min(minY, n.position.y)
        maxX = Math.max(maxX, n.position.x + w)
        maxY = Math.max(maxY, n.position.y + h)
      }
      const frameId = `frame_${crypto.randomUUID().replace(/-/g, '')}`
      const frame: CanvasGroupFrame = {
        memberIds: [...pendingGroupIds],
        x: minX - FRAME_BBOX_PADDING,
        y: minY - FRAME_BBOX_PADDING,
        width: maxX - minX + FRAME_BBOX_PADDING * 2,
        height: maxY - minY + FRAME_BBOX_PADDING * 2,
        hue,
        title,
      }

      // Membership exclusivity: a node belongs to at most one frame.
      const newMembers = new Set(pendingGroupIds)
      const evictionWrites: Promise<void>[] = []
      for (const [oldFrameId, oldFrame] of Object.entries(groupFrames)) {
        const overlap = oldFrame.memberIds.some((id) => newMembers.has(id))
        if (!overlap) continue
        const remaining = oldFrame.memberIds.filter((id) => !newMembers.has(id))
        if (remaining.length < 2) {
          evictionWrites.push(deleteCanvasGroupFrame(projectId, oldFrameId))
        } else {
          evictionWrites.push(
            setCanvasGroupFrame(projectId, oldFrameId, {
              ...oldFrame,
              memberIds: remaining,
            }),
          )
        }
      }

      setModalOpen(false)
      try {
        if (evictionWrites.length > 0) {
          await Promise.all(evictionWrites)
        }
        await setCanvasGroupFrame(projectId, frameId, frame)
      } catch (err) {
        console.warn(
          `[canvas:${projectId}] frame create failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [projectId, pendingGroupIds, rfNodes, groupFrames],
  )

  // ── Cmd+G keyboard shortcut ────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isCmdG =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && !e.altKey
      if (!isCmdG) return
      const selected = rfNodes.filter(
        (n) => n.selected === true && n.type !== 'group_frame',
      )
      if (selected.length < 2) return
      e.preventDefault()
      openCreateModal(selected.map((n) => n.id))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rfNodes, openCreateModal])

  // ── Archive (Del) + restore (Cmd+Z) ────────────────────────────────
  //
  // Del flips `archived: true`; Cmd+Z pops the last batch and restores
  // via `archived: null` (deepMergePatch deletes the key). Silent — no
  // toast; Cmd+Z is OS-native.

  const archiveHistoryRef = useRef<string[][]>([])

  const archiveNodes = useCallback(
    (ids: string[]): void => {
      if (projectId === null || ids.length === 0) return
      archiveHistoryRef.current.push([...ids])
      const archivedAt = new Date().toISOString()
      void Promise.all(
        ids.map((id) => {
          // For video_result nodes, atomically clear shot_id alongside the
          // archive flag so the clip vanishes from BOTH timeline and reel
          // in a single mutation. Without this, archived clips can leak
          // into "Available clips" (no shot_id) or stay in "On reel" /
          // master MP4 (had shot_id). Restore brings them back off-reel;
          // user re-drags onto reel if they want a specific slot.
          const node = rfNodes.find((n) => n.id === id)
          const patch = node?.type === 'video_result'
            ? { archived: true, archived_at: archivedAt, shot_id: null }
            : { archived: true, archived_at: archivedAt }
          return mutateCanvas(projectId, 'updateNode', { id, patch }).catch((err) => {
            console.warn(
              `[canvas:${projectId}] archive ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          })
        }),
      )
    },
    [projectId, rfNodes],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const a = document.activeElement
      const tag = a?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (a as HTMLElement | null)?.isContentEditable === true
      ) {
        return
      }
      // If any group frame is selected, GroupFrameNode's own Del
      // handler runs the confirm-then-delete dialog. Don't double-fire.
      const anyFrameSelected = rfNodes.some(
        (n) => n.selected === true && n.type === 'group_frame',
      )
      if (anyFrameSelected) return
      const targets = rfNodes.filter(
        (n) =>
          n.selected === true &&
          n.type !== 'group_frame' &&
          n.type !== 'pending_generation',
      )
      if (targets.length === 0) return
      e.preventDefault()
      archiveNodes(targets.map((n) => n.id))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rfNodes, archiveNodes])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isCmdZ =
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !e.shiftKey &&
        !e.altKey
      if (!isCmdZ) return
      const a = document.activeElement
      const tag = a?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (a as HTMLElement | null)?.isContentEditable === true
      ) {
        return
      }
      const ids = archiveHistoryRef.current.pop()
      if (ids === undefined || ids.length === 0) return
      if (projectId === null) return
      e.preventDefault()
      void Promise.all(
        ids.map((id) =>
          mutateCanvas(projectId, 'updateNode', {
            id,
            patch: { archived: null, archived_at: null },
          }).catch((err) => {
            console.warn(
              `[canvas:${projectId}] restore ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }),
        ),
      )
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [projectId])

  // Archive history is scoped to the current project. Switching wipes
  // the stack so a Cmd+Z in project B can't restore a node from project A.
  useEffect(() => {
    archiveHistoryRef.current = []
  }, [projectId])

  // ── AssetRail drag-archived-to-cursor ──────────────────────────────
  //
  // Two-step restore: setCanvasNodePosition first so the sidecar is
  // updated before the un-archived canvas-state broadcast lands. By
  // the time projection re-runs, useCanvasPositions' merge reads the
  // new sidecar entry — no flicker through the original position.
  // Skipping preventDefault outside the canvas lets the OS show the
  // "not-allowed" cursor over the sidebar / chrome.

  useEffect(() => {
    const isOverCanvas = (target: EventTarget | null): boolean => {
      const host = canvasHostRef.current
      if (host === null) return false
      return host.contains(target as Node)
    }
    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer === null) return
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return
      if (!isOverCanvas(e.target)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    }
    const onDrop = (e: DragEvent): void => {
      if (e.dataTransfer === null) return
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return
      e.preventDefault()
      if (!isOverCanvas(e.target)) return
      if (projectId === null) return
      const id = e.dataTransfer.getData(DRAG_MIME)
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      void (async (): Promise<void> => {
        try {
          await setCanvasNodePosition(projectId, id, { x: pos.x, y: pos.y })
          await mutateCanvas(projectId, 'updateNode', {
            id,
            patch: { archived: null, archived_at: null },
          })
        } catch (err) {
          console.warn(
            `[canvas:${projectId}] drag-to-cursor restore ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [projectId, rf])

  // ── AssetRail scroll-to-node bridge ────────────────────────────────
  //
  // The sidebar lives outside React Flow's provider, so it can't use
  // setCenter directly. We register a focus function via context;
  // AssetRow calls it when the user clicks a live row.

  const focusNode = useCallback(
    (nodeId: string): void => {
      const node = rf.getNode(nodeId)
      if (node === undefined) return
      const w =
        (node as RFNode & { width?: number; measured?: { width?: number } }).width ??
        (node as RFNode & { width?: number; measured?: { width?: number } }).measured?.width ??
        DEFAULT_NODE_WIDTH
      const h =
        (node as RFNode & { height?: number; measured?: { height?: number } }).height ??
        (node as RFNode & { height?: number; measured?: { height?: number } }).measured?.height ??
        DEFAULT_NODE_HEIGHT
      const cx = node.position.x + w / 2
      const cy = node.position.y + h / 2
      // Preserve the user's current zoom, but clamp so a deeply-zoomed
      // canvas doesn't fly past the node. 0.5–1.2 fits a typical node.
      const currentZoom = rf.getZoom()
      const zoom = Math.max(0.5, Math.min(1.2, currentZoom))
      rf.setCenter(cx, cy, { zoom, duration: 400 })
    },
    [rf],
  )
  useCanvasFocusRegistration(focusNode)

  // ── AssetRail expand-on-dblclick bridge ────────────────────────────
  //
  // The sidebar's dblclick opens the same MediaExpandOverlay the
  // canvas uses. Archived nodes (filtered out of React Flow) are
  // still in workflow.json, so we look up by id there. The payload
  // mirrors what each node component builds in its own expand handler.

  const expandMediaById = useCallback(
    (nodeId: string): void => {
      const node = workflow?.nodes.find((n) => n.id === nodeId)
      if (node === undefined) return
      const payload = buildExpandPayload(node, workflow)
      if (payload === null) return
      setExpandedMedia(payload)
    },
    [workflow],
  )
  useMediaExpandRegistration(expandMediaById)

  // ── Dev-only programmatic canvas controller ───────────────────────

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (projectId === null) return
    interface CanvasDevApi {
      setPosition: (nodeId: string, x: number, y: number) => Promise<unknown>
      dragSelectionBy: (
        nodeIds: string[],
        dx: number,
        dy: number,
      ) => Promise<unknown>
      createGroupFrame: (frame: CanvasGroupFrame) => Promise<unknown>
      refer: (
        nodeIds: string[],
      ) => { ok: true; snippet: string } | { ok: false; error: string }
      listNodes: () => Array<{ id: string; x: number; y: number }>
      listFrames: () => Record<string, CanvasGroupFrame>
      setImageSubtype: (
        nodeId: string,
        subtype: 'image' | 'character' | 'location' | 'edit' | 'reference' | 'split',
      ) => { ok: boolean }
      setImageName: (nodeId: string, name: string) => { ok: boolean }
      injectImage: (
        id: string,
        opts: { x: number; y: number; data: Record<string, unknown> },
      ) => { ok: boolean }
      injectVideo: (
        id: string,
        opts: { x: number; y: number; data: Record<string, unknown> },
      ) => { ok: boolean }
      injectPending: (
        id: string,
        opts: { x: number; y: number; data: Record<string, unknown> },
      ) => { ok: boolean }
      clearInjectedNodes: () => { ok: boolean }
      setVideoShotId: (nodeId: string, shotId: number | null) => { ok: boolean }
      projectId: string
    }
    const win = window as Window & { __pai_pro_dev?: CanvasDevApi }
    win.__pai_pro_dev = {
      projectId,
      setPosition: async (nodeId, x, y) => {
        await setCanvasNodePosition(projectId, nodeId, { x, y })
        return { ok: true, projectId, nodeId, x, y }
      },
      dragSelectionBy: async (nodeIds, dx, dy) => {
        const byId = new Map(rfNodes.map((n) => [n.id, n]))
        const targets = nodeIds
          .map((id) => byId.get(id))
          .filter((n): n is RFNode => n !== undefined)
        if (targets.length === 0) {
          return { ok: false, error: 'no matching nodes' }
        }
        await Promise.all(
          targets.map((n) =>
            setCanvasNodePosition(projectId, n.id, {
              x: n.position.x + dx,
              y: n.position.y + dy,
            }),
          ),
        )
        return {
          ok: true,
          projectId,
          moved: targets.map((n) => n.id),
          dx,
          dy,
        }
      },
      createGroupFrame: async (frame) => {
        const frameId = `frame_${crypto.randomUUID().replace(/-/g, '')}`
        await setCanvasGroupFrame(projectId, frameId, frame)
        return { ok: true, frameId, projectId }
      },
      refer: (nodeIds) => {
        if (composer === null) {
          return { ok: false as const, error: 'composer not registered' }
        }
        if (nodeIds.length === 0) {
          return { ok: false as const, error: 'empty nodeIds' }
        }
        const snippet = nodeIds.map((id) => `@${id}`).join('  ') + ' '
        composer.insertAtCursor(snippet)
        return { ok: true as const, snippet }
      },
      listNodes: () => rfNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      listFrames: () => groupFrames,
      setImageSubtype: (nodeId, subtype) => {
        setImageOverrides((prev) => {
          const next = new Map(prev)
          next.set(nodeId, { ...(next.get(nodeId) ?? {}), subtype })
          return next
        })
        return { ok: true }
      },
      setImageName: (nodeId, name) => {
        setImageOverrides((prev) => {
          const next = new Map(prev)
          next.set(nodeId, { ...(next.get(nodeId) ?? {}), name })
          return next
        })
        return { ok: true }
      },
      injectImage: (id, opts) => {
        setInjectedNodes((prev) => [
          ...prev.filter((n) => n.id !== id),
          { id, type: 'image_result', position: { x: opts.x, y: opts.y }, data: opts.data },
        ])
        return { ok: true }
      },
      injectVideo: (id, opts) => {
        setInjectedNodes((prev) => [
          ...prev.filter((n) => n.id !== id),
          { id, type: 'video_result', position: { x: opts.x, y: opts.y }, data: opts.data },
        ])
        return { ok: true }
      },
      injectPending: (id, opts) => {
        setInjectedNodes((prev) => [
          ...prev.filter((n) => n.id !== id),
          { id, type: 'pending_generation', position: { x: opts.x, y: opts.y }, data: opts.data },
        ])
        return { ok: true }
      },
      clearInjectedNodes: () => {
        setInjectedNodes([])
        return { ok: true }
      },
      setVideoShotId: (nodeId, shotId) => {
        setVideoOverrides((prev) => {
          const next = new Map(prev)
          next.set(nodeId, { ...(next.get(nodeId) ?? {}), shot_id: shotId })
          return next
        })
        return { ok: true }
      },
    }
    return () => {
      delete win.__pai_pro_dev
    }
  }, [projectId, rfNodes, groupFrames, composer])

  // Loading / error / empty states.
  // Settled-gate: when the bundle has loaded and the positions
  // sidecar has hydrated, there's still one render frame where
  // rfNodes is empty before useCanvasPositions's effect runs — that
  // would flash "Empty canvas" before snapping to populated.
  // Detect the "expects nodes but hasn't projected yet" window via
  // the workflow source-of-truth and keep showing the loading state
  // until rfNodes catches up.
  const expectsNodes = workflow !== null && workflow.nodes.length > 0
  if (loading || !hydrated || (expectsNodes && rfNodes.length === 0)) {
    return (
      <div className="canvas-loading" style={loadingStyles}>
        Loading canvas…
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="canvas-error" style={errorStyles}>
        Failed to load project: {error}
      </div>
    )
  }

  if (rfNodes.length === 0 && Object.keys(groupFrames).length === 0) {
    // Even on an empty canvas we still want drag-and-drop / paste to
    // work, so the user can seed a new project just by dropping a file.
    // ReactFlowProvider is hoisted to CanvasPage above so UploadOverlay's
    // useReactFlow() resolves; there's no canvas to project coords onto,
    // so the overlay falls back to no-position uploads (server auto-grids).
    return (
      <div className="canvas-empty" style={emptyStyles}>
        <span style={{ pointerEvents: 'none' }}>
          Empty canvas — generate something or drop a file to seed it.
        </span>
        <UploadOverlay />
      </div>
    )
  }

  return (
    <div
      ref={canvasHostRef}
      className="canvas-host"
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0d0d12',
      }}
    >
      <AssetStatusProvider value={assetStatuses}>
        <NodeActionsProvider value={nodeActions}>
          <FireConfirmProvider>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView={rfNodes.length > 0}
            minZoom={0.2}
            maxZoom={2.5}
            // B2: skip rendering nodes whose bbox is outside the
            // viewport. RF's internal cull is O(n) on every
            // transform tick but saves work for every actual node
            // renderer beyond that. Pairs with the zoom-threshold
            // placeholder in image/video nodes (nodes.tsx).
            onlyRenderVisibleElements={true}
            proOptions={REACT_FLOW_PRO_OPTIONS}
            nodesDraggable={true}
            nodesConnectable={false}
            elementsSelectable={true}
            selectionOnDrag={true}
            selectionMode={SelectionMode.Partial}
            // RF default. Bumps the selected node's zIndex above
            // edges so the orange selection ring + glow render on
            // top of incoming/outgoing edge paths instead of
            // getting sliced by them.
            elevateNodesOnSelect={true}
            panOnDrag={[1, 2]}
            selectionKeyCode={null}
            deleteKeyCode={null}
            selectNodesOnDrag={false}
            panOnScroll={true}
            zoomOnPinch={true}
            zoomOnScroll={false}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionDragStart={onSelectionDragStart}
            onSelectionDragStop={onSelectionDragStop}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={32}
              size={1}
              color="rgba(255,255,255,0.06)"
            />
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              nodeColor="oklch(0.96 0.01 60)"
              nodeBorderRadius={2}
            />
            <ZoomBar onTidy={onTidy} />
            <SelectionToolbar onGroup={openCreateModal} onArchive={archiveNodes} />
          </ReactFlow>
          {/* Inside NodeActionsProvider so the overlay's useNodeActions() resolves.
              Inside FireConfirmProvider so the overlay's Generate button can
              raise the first-fire modal the same way the card does. */}
          <MediaExpandOverlay
            media={expandedMedia}
            onClose={() => setExpandedMedia(null)}
            projectId={projectId}
          />
          </FireConfirmProvider>
        </NodeActionsProvider>
      </AssetStatusProvider>
      <SaveStatusPill />
      <UploadOverlay />
      <GroupCreateModal
        isOpen={modalOpen}
        onConfirm={onConfirmGroup}
        onCancel={closeModal}
      />
    </div>
  )
}

const loadingStyles: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: '#0d0d12',
  color: 'rgba(255,255,255,0.6)',
  fontSize: 14,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const errorStyles: React.CSSProperties = {
  ...loadingStyles,
  color: '#f87171',
}

const emptyStyles: React.CSSProperties = {
  ...loadingStyles,
  color: 'rgba(255,255,255,0.4)',
}
