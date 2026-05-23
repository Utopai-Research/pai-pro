/**
 * TimelinePanel — minimal reel view + player.
 *
 * Two sections:
 *   - On reel:   videos with a numeric shot_id, sorted ascending. The
 *                player at the top steps through these in order; click
 *                a card to jump. Drag a card to reorder; drop from
 *                Available directly onto the reel — position is taken
 *                from the cursor's slot (left/right half of each card),
 *                or the trailing empty space to append.
 *   - Available: videos with no shot_id, rendered as compact thumbs.
 *                Click to play once (no auto-advance). Drag to add to
 *                the reel at a position. Drag a reel clip back to this
 *                section to remove it from the reel.
 *
 * Player: a single <video> element keeps mounted and swaps `src` on
 * shot boundaries. Sequence time is "duration up to active shot +
 * currentTime within shot", so the scrubber tracks the whole reel.
 * Tick marks at shot boundaries; click to seek anywhere.
 *
 * Download: the toolbar's right side hits GET /projects/:id/reel.mp4,
 * which runs server-side ffmpeg concat over every shot-id'd clip and
 * streams the MP4 back as a download.
 *
 * Drag-reorder uses native HTML5 DnD with the dragged node's id in
 * dataTransfer. Reorder math runs client-side, then we PATCH all
 * affected nodes in one batch via /projects/:id/nodes/batch-data so
 * the server emits a single canvas-state update.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { VIEWER_URL } from '@/lib/socket'
import type { Workflow, VideoResultNode } from '@/types/canvas'
import SortableClip from './timeline/SortableClip'
import ClipGhostBody from './timeline/ClipGhostBody'
import DraggableCompactCard from './timeline/DraggableCompactCard'
import AvailableDroppable from './timeline/AvailableDroppable'
import ReelAreaDroppable from './timeline/ReelAreaDroppable'
import GhostPlaceholder from './timeline/GhostPlaceholder'

// Stable shallow-array equality for optimistic-order catch-up checks.
function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface TimelinePanelProps {
  projectId: string | null
  workflow: Workflow | null
}

interface BatchUpdate {
  nodeId: string
  data: Record<string, unknown>
}

function isVideoNode(n: { type: string }): n is VideoResultNode {
  return n.type === 'video_result'
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function patchBatch(projectId: string, updates: BatchUpdate[]) {
  if (updates.length === 0) return
  await fetch(
    `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/nodes/batch-data`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    },
  )
}

export function TimelinePanel({
  projectId,
  workflow,
}: TimelinePanelProps): JSX.Element {
  const { reel, available } = useMemo(() => {
    // Defense-in-depth: exclude archived video nodes. The canonical archive
    // path also clears `shot_id` in the same mutation (see CanvasPage's
    // archiveNodes), so this filter is belt-and-suspenders against any
    // future archive code path that forgets to clear shot_id atomically.
    const all = (workflow?.nodes ?? [])
      .filter(isVideoNode)
      .filter((n) => n.data.archived !== true)
    const onReel = all
      .filter(
        (n) =>
          typeof n.data.shot_id === 'number' &&
          n.data.video_url !== undefined &&
          n.data.video_url !== '',
      )
      .sort(
        (a, b) =>
          (a.data.shot_id as number) - (b.data.shot_id as number),
      )
    const off = all.filter(
      (n) => n.data.shot_id === null || n.data.shot_id === undefined,
    )
    return { reel: onReel, available: off }
  }, [workflow])

  // Player runs against a "playlist" — either the full reel
  // (auto-advance through every shot) or a single off-reel clip the
  // user clicked to preview. Wrapping both modes behind one list lets
  // the scrubber / cumul / activeIdx math stay identical.
  //
  // Reel-mode playback uses a SERVER-CONCATENATED master MP4 so clip
  // boundaries are `currentTime` jumps inside one continuous stream
  // instead of `<video>.src` swaps — the latter tear the decoder down
  // and flash black for ~100-200ms. Single-clip preview keeps the
  // straight per-clip URL since there's only one clip and no boundary
  // to smooth. See server/reel_stitch.js + the /reel/manifest +
  // /reel/preview.mp4 endpoints in server/local_viewer.js.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  // Mirror of `playing` for use inside late-arriving event handlers
  // (loadedmetadata) whose closure was captured before the user paused.
  const playingRef = useRef(playing)
  useEffect(() => { playingRef.current = playing }, [playing])
  const [activeIdx, setActiveIdx] = useState(0)
  const [time, setTime] = useState(0)
  const [singleClip, setSingleClip] = useState<VideoResultNode | null>(null)
  // When true, the preview block renders inside a 90vw × 90vh modal
  // instead of inline. The same chrome is used in both — only the
  // mount point differs. videoRef rebinds to whichever `<video>` is
  // currently mounted; the src-swap effect re-fires on the toggle so
  // the new element gets its src + currentTime set correctly.
  const [fullscreenOpen, setFullscreenOpen] = useState(false)

  // ---- Reel master manifest -----------------------------------------
  //
  // GET /projects/:id/reel/manifest tells us:
  //   - which build_id matches the current reel composition
  //   - whether the cached master MP4 is ready (or the server is still
  //     stitching). When !ready, the manifest endpoint side-effects
  //     into kicking off a build, so we just poll on a slow timer
  //     until it lands.
  // A 503 ffmpeg_missing means the host doesn't have ffmpeg — we
  // surface a one-line hint and fall back to per-clip src-swap mode.
  type ManifestClip = { node_id: string; start: number; end: number; duration: number }
  type Manifest = {
    build_id: string | null
    total_duration: number
    clips: ManifestClip[]
    ready: boolean
  }
  type ManifestStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'ffmpeg-missing' | 'error'
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('idle')

  // A "signature" for the current reel composition. When this changes
  // we refetch the manifest. URL + duration captures both reorder and
  // regenerate-in-place; node id catches add/remove.
  const reelSignature = useMemo(
    () =>
      reel.map((n) => `${n.id}|${n.data.video_url}|${n.data.duration ?? 0}`).join(','),
    [reel],
  )

  useEffect(() => {
    if (projectId === null) return
    if (reel.length === 0) {
      setManifest({ build_id: null, total_duration: 0, clips: [], ready: false })
      setManifestStatus('empty')
      return
    }
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const pull = async (): Promise<void> => {
      try {
        const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/reel/manifest`
        const res = await fetch(url)
        if (cancelled) return
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}))
          if (body?.klass === 'ffmpeg_missing') {
            setManifestStatus('ffmpeg-missing')
            return
          }
          setManifestStatus('error')
          pollTimer = setTimeout(pull, 2000)
          return
        }
        if (!res.ok) {
          setManifestStatus('error')
          pollTimer = setTimeout(pull, 2000)
          return
        }
        const data = (await res.json()) as Manifest
        if (cancelled) return
        setManifest(data)
        if (data.ready) {
          setManifestStatus('ready')
        } else {
          setManifestStatus('loading')
          pollTimer = setTimeout(pull, 1000)
        }
      } catch {
        if (cancelled) return
        setManifestStatus('error')
        pollTimer = setTimeout(pull, 2000)
      }
    }
    setManifestStatus((s) => (s === 'ready' || s === 'loading' ? s : 'loading'))
    pull()
    return (): void => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [projectId, reelSignature])

  // Memoized so its reference only changes when reel content or the
  // single-preview target changes. Without this, every render created
  // a new `[singleClip]` array, the swap-source effect fired every
  // re-render, and v.load() restarted the video repeatedly — visible
  // as the clip looping its first ~half-second.
  const playlist = useMemo<VideoResultNode[]>(
    () => (singleClip !== null ? [singleClip] : reel),
    [singleClip, reel],
  )
  const playlistMode: 'reel' | 'single' =
    singleClip !== null ? 'single' : 'reel'

  const { cumul, total } = useMemo(() => {
    let acc = 0
    const c: number[] = []
    for (const n of playlist) {
      acc += n.data.duration || 0
      c.push(acc)
    }
    return { cumul: c, total: acc }
  }, [playlist])

  // If the active playlist shrinks underneath us (clip removed mid-play
  // or singleClip yanked), reset to the start.
  useEffect(() => {
    if (activeIdx >= playlist.length) {
      setActiveIdx(0)
      setTime(0)
      setPlaying(false)
    }
  }, [playlist.length, activeIdx])

  // Drop the singleClip if it's been moved onto the reel underneath us.
  useEffect(() => {
    if (singleClip === null) return
    if (typeof singleClip.data.shot_id === 'number') setSingleClip(null)
  }, [singleClip, workflow])

  // Master-mode preconditions: we're in reel mode, the manifest is
  // ready, and its build_id matches the reel composition the player
  // last saw. When false we fall back to per-clip src-swap.
  const masterMode =
    playlistMode === 'reel' &&
    manifestStatus === 'ready' &&
    manifest !== null &&
    manifest.ready &&
    manifest.build_id !== null

  // The URL the <video> element should be pointing at. In reel/master
  // mode this is the concatenated MP4; in single-clip preview or
  // when the master isn't ready, it's the per-clip URL (with its
  // boundary flash — graceful degradation).
  const currentSrc: string =
    masterMode && projectId !== null && manifest?.build_id
      ? `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/reel/preview.mp4?build=${manifest.build_id}`
      : playlist[activeIdx]?.data.video_url ?? ''

  // Helpers for master-mode boundary math. `start` is the sequence
  // time at which clip `i` begins, identical to v.currentTime when
  // playing the master.
  const sliceStart = (i: number): number => (i === 0 ? 0 : cumul[i - 1] ?? 0)
  const clipAtMasterTime = (t: number): number => {
    for (let i = 0; i < cumul.length; i++) if (t < cumul[i]) return i
    return Math.max(0, playlist.length - 1)
  }

  // Swap source on shot change OR on master URL change. Wait for
  // `loadedmetadata` before issuing currentTime + play() so we don't
  // queue against a HAVE_NOTHING readyState (which lands as a frozen
  // last-frame at the swap moment). In master mode the swap is rare
  // (only when build_id changes, i.e. after a reel composition edit);
  // in per-clip mode it's once per clip boundary.
  useEffect(() => {
    const v = videoRef.current
    if (!v || currentSrc === '') return
    if (v.src === currentSrc) return
    v.src = currentSrc
    const onMeta = (): void => {
      // Master mode resumes at the current sequence time so a build_id
      // swap mid-play lands the user back where they were. Per-clip
      // mode starts at 0 (natural per-clip advance / explicit seek).
      try {
        v.currentTime = masterMode ? time : 0
      } catch { /* noop */ }
      if (playingRef.current) v.play().catch(() => {})
    }
    v.addEventListener('loadedmetadata', onMeta, { once: true })
    v.load()
    return (): void => v.removeEventListener('loadedmetadata', onMeta)
    // Re-fires on `fullscreenOpen` because the videoRef rebinds to a
    // freshly-mounted <video> element each time the modal toggles —
    // the new element has no src and needs the same load+seek pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSrc, fullscreenOpen])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (playing) v.play().catch(() => {})
    else v.pause()
  }, [playing])

  // Fullscreen modal lifecycle: Esc closes (unless an input/textarea
  // has focus, so future inline-edits don't lose their own Esc
  // handler), body scroll locks while open so Page-Down keystrokes
  // don't scroll the timeline list beneath the dim backdrop.
  useEffect(() => {
    if (!fullscreenOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const target = document.activeElement
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      setFullscreenOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return (): void => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [fullscreenOpen])

  const onTimeUpdate = (): void => {
    const v = videoRef.current
    if (!v) return
    if (masterMode) {
      // v.currentTime IS the sequence time. Update the scrubber, then
      // resolve which clip the cursor is in. activeIdx only changes at
      // boundaries — no src swap, no decoder teardown.
      const t = v.currentTime
      setTime(t)
      const i = clipAtMasterTime(t)
      if (i !== activeIdx) setActiveIdx(i)
      return
    }
    if (!playlist[activeIdx]) return
    const start = sliceStart(activeIdx)
    setTime(start + v.currentTime)
  }
  const onEnded = (): void => {
    if (masterMode) {
      // Master ends naturally at total — stop and pin the scrubber.
      setPlaying(false)
      setTime(total)
      return
    }
    if (playlistMode === 'single') {
      setPlaying(false)
      setTime(total)
      return
    }
    if (activeIdx < playlist.length - 1) {
      setActiveIdx((i) => i + 1)
    } else {
      setPlaying(false)
      setTime(total)
    }
  }

  const togglePlay = (): void => {
    if (!playlist.length) return
    // Block Play while we're still building the master in reel mode —
    // the user would otherwise see the spinner and per-clip flashing
    // simultaneously. Single-clip preview ignores the gate (no master
    // involved).
    if (
      playlistMode === 'reel' &&
      manifestStatus !== 'ready' &&
      manifestStatus !== 'ffmpeg-missing'
    ) return
    if (time >= total) {
      setActiveIdx(0)
      setTime(0)
      const v = videoRef.current
      if (v) { try { v.currentTime = 0 } catch { /* noop */ } }
    }
    setPlaying((p) => !p)
  }
  const restart = (): void => {
    setActiveIdx(0)
    setTime(0)
    const v = videoRef.current
    if (v) { try { v.currentTime = 0 } catch { /* noop */ } }
  }
  const playReelFrom = (i: number): void => {
    setSingleClip(null)
    setActiveIdx(i)
    const startSec = sliceStart(i)
    setTime(startSec)
    if (masterMode) {
      const v = videoRef.current
      if (v) { try { v.currentTime = startSec } catch { /* noop */ } }
    }
  }
  const playSingle = (n: VideoResultNode): void => {
    setSingleClip(n)
    setActiveIdx(0)
    setTime(0)
    setPlaying(true)
  }
  const scrub = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!total) return
    const r = e.currentTarget.getBoundingClientRect()
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const t = p * total
    if (masterMode) {
      // One continuous stream → just set currentTime; activeIdx is
      // derived from t. No requestAnimationFrame dance.
      const v = videoRef.current
      if (v) { try { v.currentTime = t } catch { /* noop */ } }
      setTime(t)
      const i = clipAtMasterTime(t)
      if (i !== activeIdx) setActiveIdx(i)
      return
    }
    // Per-clip fallback path (single-clip preview, or reel-mode while
    // the master is still building): seek within the active clip; if
    // the scrub target is in a different clip, swap activeIdx and
    // seek after the rAF tick so the new src has mounted.
    let i = 0
    for (; i < cumul.length; i++) if (t < cumul[i]) break
    i = Math.min(i, playlist.length - 1)
    const start = sliceStart(i)
    if (i !== activeIdx) {
      setActiveIdx(i)
      requestAnimationFrame(() => {
        const v = videoRef.current
        if (v) { try { v.currentTime = t - start } catch { /* noop */ } }
      })
    } else if (videoRef.current) {
      try { videoRef.current.currentTime = t - start } catch { /* noop */ }
    }
    setTime(t)
  }

  // ---- Drag-and-drop reorder / move between sections ----
  //
  // Source contract: the dragged element's onDragStart calls
  // dataTransfer.setData(DRAG_MIME, nodeId).
  //
  // Drop targets:
  //   - slot N        → insert source at position N (0..reel.length).
  //                     N is derived from the cursor's X within the
  //                     reel-card it's over: left half = before this
  //                     card, right half = after it. Drops on empty
  //                     grid space past the last card resolve to
  //                     N = reel.length (append).
  //   - available     → set source.shot_id = null (remove from reel).
  //
  // After computing the new reel ordering, send one batch PATCH that
  // assigns shot_id = i+1 to each reel node (skip if already correct)
  // and shot_id = null to anything that left the reel.
  //
  // Still used by the Remove and +Reel buttons (additive paths the
  // dnd-kit migration kept). Cross-region drag goes through
  // applyOptimisticOrder instead and bypasses this function.
  const reorderTo = async (
    sourceId: string,
    destination:
      | { kind: 'slot'; index: number }
      | { kind: 'available' },
  ) => {
    if (projectId === null) return
    const sourceFromReel = reel.findIndex((n) => n.id === sourceId)
    const sourceNode =
      sourceFromReel >= 0
        ? reel[sourceFromReel]
        : available.find((n) => n.id === sourceId)
    if (!sourceNode) return

    let newReel: VideoResultNode[] = reel.filter((n) => n.id !== sourceId)
    let removed = false

    if (destination.kind === 'available') {
      removed = sourceFromReel >= 0
      // newReel already has source removed; nothing else to do
    } else {
      // slot: insert at destination.index, but adjust if we pulled the
      // source out of an earlier position in the same reel.
      let dest = destination.index
      if (sourceFromReel >= 0 && sourceFromReel < dest) dest -= 1
      dest = Math.max(0, Math.min(newReel.length, dest))
      if (sourceFromReel === dest) {
        // No-op drop (dropped onto the source's own slot).
        return
      }
      newReel = [...newReel.slice(0, dest), sourceNode, ...newReel.slice(dest)]
    }

    const updates: BatchUpdate[] = []
    newReel.forEach((n, i) => {
      const want = i + 1
      if (n.data.shot_id !== want) updates.push({ nodeId: n.id, data: { shot_id: want } })
    })
    if (removed) updates.push({ nodeId: sourceId, data: { shot_id: null } })
    await patchBatch(projectId, updates)
  }

  const removeFromReel = async (nodeId: string) => {
    if (projectId === null) return
    await reorderTo(nodeId, { kind: 'available' })
  }
  const addToReelTail = async (nodeId: string) => {
    if (projectId === null) return
    await reorderTo(nodeId, { kind: 'slot', index: reel.length })
  }

  // ---- dnd-kit reorder + cross-region drag (Stage 1 + 2) ------------
  //
  // Stage 1 wired intra-reel reorder. Stage 2 (in-progress) wires
  // cross-region drag (Available card ↔ reel) via the same DndContext.
  // The legacy HTML5 paths (DRAG_MIME, onCardDragStart, container-level
  // onDragOver/onDrop) are gone — dnd-kit owns every drag surface.
  // Remove (✕ on each reel card) and +Reel (on each Available card) stay
  // as explicit button-driven alternatives to the drag paths.
  //
  // Optimistic-order pattern (handover §5.3): the user sees the new
  // order instantly via `optimisticOrder` overriding the truth-derived
  // order; PATCH fires in the background; `useEffect` clears optimistic
  // when the canvas-state catch-up makes truth match.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const dragBaselineRef = useRef<string[] | null>(null)
  // Sticky-over collision target (handover §5.7-C). Persists the last
  // valid over.id so cursor wobble in dead-zone padding (between reel
  // grid rows, between sections) doesn't oscillate between two closest
  // droppables and strobe the preview.
  const lastOverIdRef = useRef<string | null>(null)

  // Truth, derived from the live shot_id sort.
  const truthOrder = useMemo(() => reel.map((n) => n.id), [reel])
  const effectiveOrder = optimisticOrder ?? truthOrder

  // Clear optimistic when the server-pushed canvas state catches up.
  useEffect(() => {
    if (optimisticOrder == null) return
    if (arraysEqual(optimisticOrder, truthOrder)) setOptimisticOrder(null)
  }, [truthOrder, optimisticOrder])

  // Reel rendered in `effectiveOrder` instead of raw `reel` so the
  // user sees the new order the instant they drop, before the round-
  // trip lands.
  //
  // byId pulls from BOTH reel and available — cross-region drag
  // (Stage 2) splices an Available source's id into optimisticOrder
  // mid-drag, and the preview needs to render that source as a member
  // of the reel grid. Without Available in the lookup, the splice
  // would show in effectiveOrder but the .map would filter out the
  // source's node data and the visual preview would silently break.
  const effectiveReel = useMemo<VideoResultNode[]>(() => {
    if (optimisticOrder == null) return reel
    const byId = new Map<string, VideoResultNode>()
    for (const n of reel) byId.set(n.id, n)
    for (const n of available) byId.set(n.id, n)
    return optimisticOrder
      .map((id) => byId.get(id))
      .filter((n): n is VideoResultNode => Boolean(n))
  }, [reel, available, optimisticOrder])

  // Available rendered as `effectiveAvailable` (Stage 2 fix): when the
  // cross-region preview engages, optimisticOrder includes the source
  // id and the source is rendered inside the reel grid. Without
  // excluding it from Available, the source would visually appear in
  // both places (and dnd-kit registers double droppables for it). The
  // pai-next "partition from effective order, not truth" pattern
  // (handover §3 data-model contract).
  const effectiveAvailable = useMemo<VideoResultNode[]>(() => {
    if (optimisticOrder == null) return available
    const optSet = new Set(optimisticOrder)
    return available.filter((n) => !optSet.has(n.id))
  }, [available, optimisticOrder])

  // Sparse renumber: only PATCH the cards whose shot_id actually
  // changes. 1-based, matching the existing reorderTo at line ~504.
  const applyOptimisticOrder = useCallback(
    (nextIds: string[]) => {
      if (projectId === null) return
      if (arraysEqual(nextIds, truthOrder)) {
        setOptimisticOrder(null)
        return
      }
      setOptimisticOrder(nextIds)
      const updates: BatchUpdate[] = []
      // Sparse renumber: emit shot_id = i+1 for any id whose current
      // value differs. Look up in BOTH reel and available — a cross-
      // region drag inserts an Available source id into nextIds; the
      // source is in `available`, not `reel`. Without checking
      // available, the source is silently skipped from the PATCH,
      // never gets a shot_id, never joins the reel — and the
      // optimistic preview gets stuck forever (truth never matches).
      // Downstream symptoms: × Remove and playback both no-op on the
      // ghost card because reel.findIndex returns -1.
      nextIds.forEach((id, i) => {
        const node =
          reel.find((n) => n.id === id) ??
          available.find((n) => n.id === id)
        if (!node) return
        const want = i + 1
        if (node.data.shot_id !== want) {
          updates.push({ nodeId: id, data: { shot_id: want } })
        }
      })
      // Null-clear: any id that WAS on the reel pre-drag and is NOT in
      // the new order has been dragged into Available. Clear its shot_id
      // atomically so the canvas state is consistent (matches the
      // existing reorderTo path's "remove from reel" branch).
      truthOrder.forEach((id) => {
        if (nextIds.includes(id)) return
        updates.push({ nodeId: id, data: { shot_id: null } })
      })
      void patchBatch(projectId, updates).catch(() => {
        // Rollback on failure; truth-derived order resumes next render.
        setOptimisticOrder(null)
      })
    },
    [projectId, reel, available, truthOrder],
  )

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Strobe killer C (handover §5.7-C): once the cursor commits to a
  // droppable, stay committed until it explicitly enters a different
  // droppable's rect. Without this, sub-pixel cursor wobble in dead-
  // zone padding (between reel grid rows, between the reel and
  // Available sections) flips `closestCenter`'s result frame-to-frame
  // and the preview strobes.
  //
  // Reset lastOverIdRef in handleDragStart / handleDragEnd /
  // handleDragCancel so a leftover from the previous drag can't bias
  // the start of the next one.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const inside = pointerWithin(args)
    if (inside.length > 0) {
      lastOverIdRef.current = String(inside[0].id)
      return inside
    }
    if (lastOverIdRef.current !== null) {
      return [{ id: lastOverIdRef.current, data: { current: {} } }]
    }
    const closest = closestCenter(args)
    if (closest.length > 0) lastOverIdRef.current = String(closest[0].id)
    return closest
  }, [])

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveDragId(String(event.active.id))
      dragBaselineRef.current = optimisticOrder ?? truthOrder
      lastOverIdRef.current = null
    },
    [optimisticOrder, truthOrder],
  )

  // Cross-region preview (handover §5.6). Cross-region drag from
  // Available splices the source into the reel at the over index
  // mid-drag so neighbors reflow before release. Intra-reel drag is
  // skipped — dnd-kit's natural transform-based reorder handles it.
  //
  // Critical: splice against `baseline` (pre-drag snapshot), NOT
  // against the current optimistic state. Otherwise each pointer move
  // accumulates another copy of the source in the preview.
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const baseline = dragBaselineRef.current
      if (!baseline) return
      const sourceId = String(event.active.id)
      if (baseline.includes(sourceId)) return // intra-reel: dnd-kit handles natively

      let desired: string[] = baseline
      const over = event.over
      if (over) {
        const overId = String(over.id)
        // Strobe killer A (handover §5.7-A): once preview engages, the
        // source's <SortableClip> registers as a droppable. pointerWithin
        // can pick it as `over`. Without this guard, the splice loops:
        // "source not in baseline → clear preview → cursor on real clip
        // → re-engage → strobe."
        if (overId === sourceId) return
        if (overId === 'reel-area') {
          // Append-at-end preview: source goes after every existing
          // reel id. Empty reel → [sourceId] (degenerate). Non-empty →
          // [...baseline, sourceId]. The single 'reel-area' droppable
          // wraps both empty-state and SortableContext — drop outside
          // a specific card = "append," consistent across both cases.
          desired = [...baseline, sourceId]
        } else if (overId !== 'archive') {
          const overIndex = baseline.indexOf(overId)
          if (overIndex >= 0) {
            desired = [
              ...baseline.slice(0, overIndex),
              sourceId,
              ...baseline.slice(overIndex),
            ]
          }
        }
      }
      const target = arraysEqual(desired, truthOrder) ? null : desired
      setOptimisticOrder((prev) => (arraysEqual(prev, target) ? prev : target))
    },
    [truthOrder],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null)
      const baseline = dragBaselineRef.current
      dragBaselineRef.current = null
      lastOverIdRef.current = null
      const { active, over } = event
      if (!over || !baseline) {
        if (baseline) {
          setOptimisticOrder(arraysEqual(baseline, truthOrder) ? null : baseline)
        }
        return
      }
      const sourceId = String(active.id)
      const overId = String(over.id)
      // `sourceId === overId` has TWO meanings depending on whether
      // source was in the pre-drag reel:
      //   - Intra-reel (source IN baseline): dropped on own original
      //     slot — true no-op.
      //   - Cross-region (source NOT in baseline): handleDragOver has
      //     spliced source into the reel's optimistic preview at the
      //     cursor position. dnd-kit's collision then picks the source's
      //     own preview-position <SortableClip> as the over target on
      //     release. THIS IS A COMMIT, not a no-op. Returning here was
      //     the root cause of the "drag-up doesn't assign shot_id" bug
      //     — handleDragOver's preview was stuck and never persisted.
      if (sourceId === overId) {
        if (baseline.includes(sourceId)) return
        if (optimisticOrder) applyOptimisticOrder(optimisticOrder)
        return
      }

      const oldIndex = baseline.indexOf(sourceId)
      const newIndex = baseline.indexOf(overId)
      const sourceInReel = oldIndex >= 0
      const overInReel = newIndex >= 0

      // Four drag classes (handover §5.6 + the empty-reel polish from
      // handover §9.2 / Proposal 04 §5.4 — baseline is pre-drag truth):
      //   1. Reel → Available (overId === 'archive'): clear shot_id via
      //      applyOptimisticOrder with the source filtered out. The
      //      null-clear branch of applyOptimisticOrder emits
      //      { shot_id: null } for the removed id.
      //   2. Intra-reel reorder (both in reel): arrayMove + apply.
      //   3. Available → reel slot (source not in reel, over IS in
      //      reel): splice the source into baseline at the over index.
      //   4. Available → empty reel (overId === 'reel-empty'): source
      //      becomes reel #1. Without this branch, an empty-reel target
      //      would no-op because baseline = [] and overInReel = false.
      // Anything else (no over, source/over in unknown regions): restore
      // baseline (preview was non-committal).
      if (sourceInReel && overId === 'archive') {
        applyOptimisticOrder(baseline.filter((id) => id !== sourceId))
      } else if (!sourceInReel && overId === 'reel-area') {
        // Append at end. Empty reel → [sourceId]; non-empty → [...baseline, sourceId].
        applyOptimisticOrder([...baseline, sourceId])
      } else if (sourceInReel && overInReel) {
        if (oldIndex !== newIndex) {
          applyOptimisticOrder(arrayMove(baseline, oldIndex, newIndex))
        }
      } else if (!sourceInReel && overInReel) {
        applyOptimisticOrder([
          ...baseline.slice(0, newIndex),
          sourceId,
          ...baseline.slice(newIndex),
        ])
      } else {
        setOptimisticOrder(arraysEqual(baseline, truthOrder) ? null : baseline)
      }
    },
    [truthOrder, optimisticOrder, applyOptimisticOrder],
  )

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null)
    const baseline = dragBaselineRef.current
    dragBaselineRef.current = null
    lastOverIdRef.current = null
    // handleDragOver may have mutated optimisticOrder mid-drag for
    // cross-region preview — restore the pre-drag display state on
    // cancel (or null if it equals truth, the catch-up effect's signal
    // to release optimistic).
    if (baseline) {
      setOptimisticOrder(arraysEqual(baseline, truthOrder) ? null : baseline)
    }
  }, [truthOrder])

  // Cross-region drag (Stage 2) introduces sources that aren't in `reel`
  // yet — fall back to `available` so the cursor ghost (ClipGhostBody)
  // renders for Available → reel drags as well as intra-reel.
  const activeDragNode = useMemo(() => {
    if (activeDragId === null) return null
    return (
      reel.find((n) => n.id === activeDragId) ??
      available.find((n) => n.id === activeDragId) ??
      null
    )
  }, [activeDragId, reel, available])

  // Strobe killer B (handover §5.7-B): when a cross-region drag engages
  // (Available source mounting in the reel via preview), the source's
  // <DraggableCompactCard> unmounts from Available. Without a ghost
  // placeholder, Available's grid reflows from N tiles to N-1, changing
  // its bounding rect and feeding `closestCenter` an oscillating
  // boundary near the divider. Rendering a transparent dashed-border
  // tile in Available at the source's slot keeps the rect stable.
  //
  // ghostClipId === null when no cross-region preview is in flight.
  const ghostClipId =
    activeDragId !== null &&
    dragBaselineRef.current !== null &&
    !dragBaselineRef.current.includes(activeDragId)
      ? activeDragId
      : null

  // ---- Stitch + download the reel via the viewer's ffmpeg endpoint ----
  const [downloading, setDownloading] = useState(false)
  const downloadReel = async () => {
    if (projectId === null || downloading || reel.length === 0) return
    setDownloading(true)
    try {
      const url = `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/reel.mp4`
      const res = await fetch(url)
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json())?.error ?? msg } catch { /* not JSON */ }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const cd = res.headers.get('Content-Disposition') ?? ''
      const m = cd.match(/filename="([^"]+)"/)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = m ? m[1] : 'reel.mp4'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Lightweight feedback — alert is fine here; failures are rare and
      // the toolbar has no toast layer.
      window.alert(`Could not stitch reel: ${msg}`)
    } finally {
      setDownloading(false)
    }
  }

  const sequenceProgress = total > 0 ? time / total : 0
  const aspect = playlist[activeIdx]?.data.aspect ?? '16:9'
  const aspectStyle = aspect.replace(':', ' / ')

  // The preview chrome (video + overlays + control row) renders in
  // ONE of two mount points at a time — inline at the top of the
  // panel, or inside the fullscreen modal. Keeping a single render
  // path avoids the JSX duplication that drifts under maintenance.
  const renderPreviewChrome = (variant: 'inline' | 'modal'): JSX.Element => {
    const expandTitle =
      variant === 'modal' ? 'Close (Esc)' : 'Expand to fullscreen modal'
    const expandLabel = variant === 'modal' ? '✕ Close' : '⛶ Expand'
    // Master-build status overlay. Only meaningful in reel
    // mode — single-clip preview never waits on a master.
    const overlays = (
      <>
        {playlistMode === 'reel' &&
        (manifestStatus === 'loading' || manifestStatus === 'error') ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-300" />
              Preparing reel…
            </div>
          </div>
        ) : null}
        {playlistMode === 'reel' && manifestStatus === 'ffmpeg-missing' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/65">
            <div className="max-w-sm px-6 py-4 text-center text-[11px] leading-relaxed text-neutral-300">
              Smooth playback needs <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-100">ffmpeg</code> on the host.
              Install it with <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-100">brew install ffmpeg</code> and restart the viewer.
              Falling back to per-clip playback (you may see a brief flash at clip boundaries).
            </div>
          </div>
        ) : null}
      </>
    )
    return (
      <>
        {variant === 'modal' ? (
          <div className="relative w-full flex-1 min-h-0">
            <video
              ref={videoRef}
              onTimeUpdate={onTimeUpdate}
              onEnded={onEnded}
              preload="auto"
              playsInline
              className="absolute inset-0 h-full w-full bg-black object-contain"
            />
            {overlays}
          </div>
        ) : (
          // Height-driven aspect-ratio box: width:100% + aspect-ratio +
          // max-h:100% lets the browser pick the largest rectangle with
          // the clip's ratio that fits inside the stage. 9:16 stays
          // tall-and-narrow, 16:9 fills the stage height width-derived.
          <div className="flex flex-1 min-h-0 px-4 pt-3 pb-2">
            <div
              className="relative mx-auto bg-black"
              style={{
                width: '100%',
                aspectRatio: aspectStyle,
                maxHeight: '100%',
              }}
            >
              <video
                ref={videoRef}
                onClick={togglePlay}
                onTimeUpdate={onTimeUpdate}
                onEnded={onEnded}
                preload="auto"
                playsInline
                className="block h-full w-full cursor-pointer bg-black object-contain"
              />
              {overlays}
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 px-4 py-2 text-neutral-300">
          <button
            type="button"
            onClick={togglePlay}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs hover:border-neutral-500"
          >
            {playing
              ? '⏸ Pause'
              : time >= total && total > 0
                ? '↻ Replay'
                : '▶ Play'}
          </button>
          <button
            type="button"
            onClick={restart}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs hover:border-neutral-500"
            title="Restart"
          >
            ↺
          </button>
          <div className="font-mono text-[11px] text-neutral-500 tabular-nums">
            {formatTime(time)}
            <span className="px-1 text-neutral-700">/</span>
            {formatTime(total)}
          </div>
          <div
            className="relative h-1.5 flex-1 cursor-pointer rounded bg-neutral-800"
            onClick={scrub}
          >
            {cumul.slice(0, -1).map((c, i) => (
              <div
                key={i}
                className="absolute top-0 h-full w-px bg-neutral-600"
                style={{ left: `${(c / total) * 100}%` }}
              />
            ))}
            <div
              className="absolute left-0 top-0 h-full rounded bg-neutral-300"
              style={{ width: `${sequenceProgress * 100}%` }}
            />
          </div>
          <div className="font-mono text-[11px] text-neutral-500 tabular-nums">
            {playlistMode === 'reel'
              ? `shot ${activeIdx + 1}/${playlist.length}`
              : 'single'}
          </div>
          <button
            type="button"
            onClick={() => void downloadReel()}
            disabled={downloading || reel.length === 0}
            className={
              'ml-1 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] uppercase tracking-wide transition-colors ' +
              (downloading
                ? 'cursor-wait border-neutral-700 bg-neutral-900 text-neutral-400'
                : reel.length === 0
                  ? 'cursor-not-allowed border-neutral-800 bg-neutral-950 text-neutral-600'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500 hover:text-white')
            }
            title={
              reel.length === 0
                ? 'Add at least one shot to the reel first'
                : downloading
                  ? 'Stitching reel via ffmpeg…'
                  : `Stitch ${reel.length} shot${reel.length === 1 ? '' : 's'} and download`
            }
          >
            {downloading ? (
              <>
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-400" />
                Stitching…
              </>
            ) : (
              <>↓ Download</>
            )}
          </button>
          <button
            type="button"
            onClick={() => setFullscreenOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-[11px] uppercase tracking-wide text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
            title={expandTitle}
          >
            {expandLabel}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0a0a0a] text-neutral-200">
      {!fullscreenOpen ? (
        // Fixed-height preview stage — always reserved so the reel section
        // doesn't jump shape when the first clip lands. Empty state shows
        // a hint; loaded state defers to renderPreviewChrome.
        <div
          className="flex flex-col border-b border-neutral-800 bg-black"
          style={{ height: '60vh', minHeight: '320px' }}
        >
          {playlist.length > 0 ? (
            renderPreviewChrome('inline')
          ) : (
            <div className="flex flex-1 items-center justify-center text-[11px] uppercase tracking-wide text-neutral-500">
              Drag a clip onto the reel to preview
            </div>
          )}
        </div>
      ) : null}

      <div className="scrollbar-subtle flex-1 overflow-y-auto">
        {/* Reel section: the whole grid is one drop target. Position is
            taken from the cursor's left/right half of whichever card
            it's over; empty trailing space falls through to "append". */}
        {/* Lifted DndContext — wraps both reel and Available sections so
            cross-region drag (Available → reel slot, reel → Available)
            can transition the same id between useDraggable and
            useSortable within one drag (handover §8.7). Sensors,
            collision detection, and handlers are shared across the
            whole timeline DnD surface. */}
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {/* Reel section */}
          <div className="border-b border-neutral-900">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
              On reel ({reel.length})
              <span className="ml-2 normal-case tracking-normal text-neutral-700">
                · drag to reorder · drop from Available to add
              </span>
            </div>
            <div className="min-h-[88px] px-4 pb-3">
              {/* ReelAreaDroppable is always mounted (id 'reel-area').
                  Drop on it = "append at end of current reel" — handles
                  both the empty-reel case (drag a clip onto the
                  placeholder, becomes reel #1) and the non-empty append
                  case (drop past the last card, becomes reel #N+1).
                  Specific-card drops still take precedence via
                  pointerWithin against each SortableClip's own
                  droppable. */}
              <ReelAreaDroppable showEmptyHint={effectiveOrder.length === 0}>
                <SortableContext items={effectiveOrder} strategy={horizontalListSortingStrategy}>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
                    {effectiveReel.map((n) => {
                      // Active-card tracking follows the playing node's
                      // id (truth-state), NOT this map's index — during
                      // an optimistic reorder, the displayed position
                      // shifts while playback continues on the original
                      // clip. Without this, the play overlay would
                      // briefly jump to a different card.
                      const isActive =
                        playlistMode === 'reel' &&
                        reel[activeIdx]?.id === n.id &&
                        playlist.length > 0
                      return (
                        <SortableClip key={n.id} id={n.id} aspect={n.data.aspect ?? '16:9'}>
                          <ReelCard
                            node={n}
                            active={isActive}
                            isPlaying={isActive && playing}
                            dropEdge={null}
                            onClick={() => {
                              if (isActive) {
                                togglePlay()
                                return
                              }
                              // Look up the truth-state index so a click
                              // during the brief optimistic window still
                              // seeks to the clicked node, not whichever
                              // node happens to share its display slot.
                              const truthIdx = reel.findIndex((r) => r.id === n.id)
                              if (truthIdx >= 0) playReelFrom(truthIdx)
                            }}
                            onAction={() => removeFromReel(n.id)}
                            actionLabel="Remove"
                            // No HTML5 drag handlers — dnd-kit owns this card.
                          />
                        </SortableClip>
                      )
                    })}
                  </div>
                </SortableContext>
              </ReelAreaDroppable>
            </div>
          </div>

          {/* Available section, wrapped in AvailableDroppable: a reel
              card dragged here commits a "remove from reel" via the
              handleDragEnd `sourceInReel && overId === 'archive'`
              branch. The Remove ✕ on each reel card is still the
              explicit alternative. */}
          <AvailableDroppable>
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
              Available clips ({effectiveAvailable.length})
              <span className="ml-2 normal-case tracking-normal text-neutral-700">
                · click to play / pause · drag onto reel to add
              </span>
            </div>
            {effectiveAvailable.length === 0 && ghostClipId === null ? (
              <div className="px-4 pb-4 text-xs text-neutral-600">
                No off-reel video clips on this canvas.
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5 px-4 pb-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                {effectiveAvailable.map((n) => {
                  const isActive =
                    singleClip !== null && singleClip.id === n.id
                  return (
                    <DraggableCompactCard key={n.id} id={n.id}>
                      <CompactCard
                        node={n}
                        active={isActive}
                        isPlaying={isActive && playing}
                        onClick={() => (isActive ? togglePlay() : playSingle(n))}
                        onAdd={() => addToReelTail(n.id)}
                      />
                    </DraggableCompactCard>
                  )
                })}
                {/* Strobe killer B (handover §5.7-B): rect-stable placeholder
                    for the in-flight cross-region source. Same grid cell
                    footprint as a real Available card, keeping the grid's
                    child count constant during the drag. */}
                {ghostClipId !== null && (
                  <GhostPlaceholder key={`ghost-${ghostClipId}`} />
                )}
              </div>
            )}
          </AvailableDroppable>

          {createPortal(
            <DragOverlay dropAnimation={null}>
              {activeDragNode ? <ClipGhostBody node={activeDragNode} /> : null}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
      </div>
    </div>
    {fullscreenOpen ? (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Timeline preview — fullscreen"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
        onClick={() => setFullscreenOpen(false)}
      >
        <div
          className="relative flex h-[90vh] w-[90vw] max-w-[1600px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-black"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setFullscreenOpen(false)}
            title="Close (Esc)"
            className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-neutral-200 transition-colors hover:bg-black/80 hover:text-white"
          >
            ✕
          </button>
          {renderPreviewChrome('modal')}
        </div>
      </div>
    ) : null}
    </>
  )
}

function ReelCard({
  node,
  active,
  isPlaying,
  dropEdge,
  onClick,
  onAction,
  actionLabel,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  node: VideoResultNode
  active: boolean
  isPlaying: boolean
  dropEdge: 'left' | 'right' | null
  onClick: () => void
  onAction: () => void
  actionLabel: 'Remove'
  // HTML5 drag handlers are optional — when this card is rendered inside
  // a SortableClip wrapper (dnd-kit), the wrapper owns drag and these
  // are undefined; the card then renders as draggable={false}.
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: React.DragEvent) => void
}): JSX.Element {
  const url = node.data.video_url
  const shotId = node.data.shot_id
  const label = node.data.label ?? 'untitled'
  const aspect = node.data.aspect ?? '16:9'
  const duration = node.data.duration
  // dnd-kit-wrapped cards (intra-reel reorder) have no HTML5 handlers and
  // must NOT be `draggable` or the browser-level drag steals pointer
  // events from dnd-kit's MouseSensor. HTML5-only callers (legacy
  // Available section fallback during Stage 1) pass the handlers and get
  // `draggable=true`.
  const html5Drag = typeof onDragStart === 'function'
  return (
    <div
      draggable={html5Drag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={
        'group relative overflow-hidden rounded-md border bg-neutral-950 transition-colors ' +
        (active
          ? 'border-neutral-300'
          : 'border-neutral-800 hover:border-neutral-700')
      }
    >
      {/* Insertion-slot indicator: a thin vertical bar at the edge of the
          card where the dragged clip will land. */}
      {dropEdge !== null ? (
        <div
          className={
            'pointer-events-none absolute inset-y-0 z-10 w-[3px] rounded-full bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.7)] ' +
            (dropEdge === 'left' ? '-left-[5px]' : '-right-[5px]')
          }
        />
      ) : null}
      <button type="button" onClick={onClick} className="block w-full text-left">
        <div
          className="relative mx-auto bg-black"
          style={{
            width: '100%',
            aspectRatio: aspect.replace(':', ' / '),
            maxHeight: '80px',
          }}
        >
          {url !== '' ? (
            <video
              src={url}
              preload="metadata"
              muted
              playsInline
              draggable={false}
              className="h-full w-full object-cover"
              onError={(e) => {
                ;(e.currentTarget as HTMLVideoElement).style.display = 'none'
              }}
            />
          ) : null}
          {typeof shotId === 'number' ? (
            <div className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-100">
              #{String(shotId).padStart(2, '0')}
            </div>
          ) : null}
          {/* Active card always shows its play state; idle cards show
              ▶ on hover so the click affordance is obvious. */}
          <div
            className={
              'pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ' +
              (active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
            }
          >
            <span className="text-2xl text-neutral-100">
              {isPlaying ? '⏸' : '▶'}
            </span>
          </div>
          {active ? (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-neutral-300" />
          ) : null}
        </div>
      </button>
      {/* Stacked density (picked from pick-variation V5 / reel-card-density):
          label on its own row above a metadata + ✕-icon row. Fits the full
          "aspect · Ns" without truncation on narrow cards, since the ✕
          button is ~40px slimmer than the prior text "REMOVE" pill. */}
      <div className="px-2 py-1.5">
        <div className="truncate text-xs text-neutral-200">{label}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <div className="truncate font-mono text-[10px] text-neutral-500">
            {aspect}
            {typeof duration === 'number' ? ` · ${duration}s` : ''}
          </div>
          <button
            type="button"
            title={actionLabel}
            onClick={(e) => {
              e.stopPropagation()
              onAction()
            }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-[12px] leading-none text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}

function CompactCard({
  node,
  active,
  isPlaying,
  onClick,
  onAdd,
}: {
  node: VideoResultNode
  active: boolean
  isPlaying: boolean
  onClick: () => void
  onAdd: () => void
}): JSX.Element {
  const url = node.data.video_url
  const label = node.data.label ?? 'untitled'
  const aspect = node.data.aspect ?? '16:9'
  // HTML5 `draggable` removed — DraggableCompactCard wraps this card with
  // dnd-kit's useDraggable, and HTML5 drag would steal pointer events
  // from dnd-kit's MouseSensor. Same pattern as SortableClip+ReelCard.
  return (
    <div
      className={
        'group relative overflow-hidden rounded border bg-neutral-950 transition-colors ' +
        (active
          ? 'border-neutral-300'
          : 'border-neutral-800 hover:border-neutral-600')
      }
      title={label}
    >
      <button type="button" onClick={onClick} className="block w-full">
        <div
          className="relative mx-auto bg-black"
          style={{
            width: '100%',
            aspectRatio: aspect.replace(':', ' / '),
            maxHeight: '80px',
          }}
        >
          {url !== '' ? (
            <video
              src={url}
              preload="metadata"
              muted
              playsInline
              draggable={false}
              className="h-full w-full object-cover"
              onError={(e) => {
                ;(e.currentTarget as HTMLVideoElement).style.display = 'none'
              }}
            />
          ) : null}
          {/* When this clip is the active single preview, the overlay is
              persistent and shows the live play state — clicking it
              toggles play/pause without scrolling up. */}
          <div
            className={
              'pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ' +
              (active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
            }
          >
            <span className="text-xl text-neutral-100">
              {isPlaying ? '⏸' : '▶'}
            </span>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onAdd()
        }}
        className="absolute right-1 top-1 rounded border border-neutral-700 bg-neutral-900/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-300 opacity-0 transition-opacity hover:border-neutral-500 group-hover:opacity-100"
        title="Add to reel"
      >
        + reel
      </button>
      <div className="truncate px-1.5 py-1 text-[10px] text-neutral-400">
        {label}
      </div>
    </div>
  )
}
