/**
 * TimelinePanel — minimal reel view + player.
 *
 * Two sections:
 *   - On reel:   videos with a numeric shot_id, sorted ascending. The
 *                player at the top steps through these in order. The
 *                reel renders as one duration-scaled horizontal track;
 *                click a card to jump, drag a card to reorder, or drop
 *                from Available directly onto the reel to add it.
 *   - Available: videos with no shot_id, rendered as compact thumbs.
 *                Click to play once (no auto-advance). Drag to add to
 *                the reel at a position. Drag a reel clip back to this
 *                section to remove it from the reel.
 *
 * Player: a single <video> element keeps mounted and swaps `src` on
 * shot boundaries. Sequence time is "duration up to active shot +
 * currentTime within shot", so the transport time and reel playhead
 * track the whole reel.
 *
 * Download: the toolbar's right side hits GET /projects/:id/reel.mp4,
 * which runs server-side ffmpeg concat over every shot-id'd clip and
 * streams the MP4 back as a download.
 *
 * Drag-reorder uses dnd-kit. Reorder math runs client-side, then we
 * PATCH all affected nodes in one batch via /projects/:id/nodes/batch-data
 * so the server emits a single canvas-state update.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
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
import { useChatComposer } from '@/contexts/ChatComposerContext'
import {
  discardPendingDraft,
  firePendingDraft,
  patchCanvasNodeDataBatch,
  stageReelUpscaleDraft,
  type CanvasNodeDataUpdate,
  type ReelUpscaleDraft,
} from '@/lib/canvas-stub'
import { VIEWER_URL } from '@/lib/socket'
import type { PendingGeneration, Workflow, VideoResultNode } from '@/types/canvas'
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
  pendingGenerations: PendingGeneration[]
  onArchiveNodes: (ids: string[]) => void
  isVisible: boolean
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

function isKeyboardShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const TIMELINE_DEFAULT_PX_PER_SECOND = 20
const TIMELINE_MIN_PX_PER_SECOND = 8
const TIMELINE_MAX_PX_PER_SECOND = 80
const TIMELINE_MIN_CLIP_SECONDS = 1
const TIMELINE_ZOOM_SENSITIVITY = 0.01

function timelineDurationSeconds(node: VideoResultNode): number {
  const duration = node.data.duration
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : TIMELINE_MIN_CLIP_SECONDS
}

function clampTimelinePxPerSecond(pxPerSecond: number): number {
  return Math.min(
    TIMELINE_MAX_PX_PER_SECOND,
    Math.max(TIMELINE_MIN_PX_PER_SECOND, pxPerSecond),
  )
}

function safeDownloadName(label: string | undefined, fallback: string): string {
  const base = String(label || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback
  return base.toLowerCase().endsWith('.mp4') ? base : `${base}.mp4`
}

type ReelUpscaleStatus =
  | 'idle'
  | 'quoting'
  | 'confirm'
  | 'running'
  | 'downloading'
  | 'ready'
  | 'error'

function timelineClipWidth(node: VideoResultNode, pxPerSecond: number): number {
  return timelineDurationSeconds(node) * pxPerSecond
}

function TimelineRuler({
  totalSeconds,
  widthPx,
  pxPerSecond,
  onPointerDown,
}: {
  totalSeconds: number
  widthPx: number
  pxPerSecond: number
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
}): JSX.Element {
  if (totalSeconds <= 0) {
    return (
      <div
        className="relative h-7 border-t border-neutral-900 bg-neutral-950/80"
        style={{ width: widthPx }}
      />
    )
  }

  const niceIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const majorInterval =
    niceIntervals.find((seconds) => seconds * pxPerSecond >= 72) ?? 300
  const minorInterval = majorInterval / 5
  const marks: { time: number; major: boolean }[] = []

  for (let t = 0; t <= totalSeconds + 0.001; t += minorInterval) {
    const snapped = Math.round(t / minorInterval) * minorInterval
    if (snapped > totalSeconds + 0.001) break
    const major =
      Math.abs(snapped / majorInterval - Math.round(snapped / majorInterval)) < 0.001
    marks.push({ time: snapped, major })
  }

  return (
    <div
      className="relative h-7 touch-none cursor-ew-resize border-t border-neutral-900 bg-neutral-950/80"
      onPointerDown={onPointerDown}
      style={{ width: widthPx }}
      title="Click or drag to seek"
    >
      {marks.map(({ time: markTime, major }) => {
        const left = markTime * pxPerSecond
        return (
          <div
            key={`${markTime}-${major ? 'major' : 'minor'}`}
            className="absolute top-0"
            style={{ left }}
          >
            <div
              className={
                'absolute left-0 top-0 w-px ' +
                (major ? 'h-3 bg-neutral-500' : 'h-1.5 bg-neutral-700')
              }
            />
            {major ? (
              <span className="absolute left-1.5 top-2.5 whitespace-nowrap font-mono text-[9px] text-neutral-500 tabular-nums">
                {formatTime(markTime)}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function TimelineZoomControl({
  value,
  onChange,
}: {
  value: number
  onChange: (pxPerSecond: number) => void
}): JSX.Element {
  const min = TIMELINE_MIN_PX_PER_SECOND
  const max = TIMELINE_MAX_PX_PER_SECOND
  const logSpan = Math.log(max / min)
  const toT = (px: number): number => Math.log(px / min) / logSpan
  const toPx = (t: number): number => min * (max / min) ** Math.min(1, Math.max(0, t))
  const t = Math.min(1, Math.max(0, toT(value)))
  const step = (dir: 1 | -1): void => {
    onChange(clampTimelinePxPerSecond(toPx(t + dir * 0.1)))
  }

  return (
    <div className="flex items-center gap-1.5 text-neutral-500">
      <button
        type="button"
        aria-label="Zoom timeline out"
        title="Zoom timeline out"
        disabled={value <= min}
        onClick={() => step(-1)}
        className="grid h-5 w-5 place-items-center rounded border border-neutral-800 bg-neutral-950 text-[11px] leading-none transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-35"
      >
        -
      </button>
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(t * 1000)}
        aria-label="Zoom timeline"
        title="Zoom timeline"
        onChange={(e) => onChange(clampTimelinePxPerSecond(toPx(Number(e.target.value) / 1000)))}
        onDoubleClick={() => onChange(TIMELINE_DEFAULT_PX_PER_SECOND)}
        className="h-1 w-24 cursor-pointer accent-neutral-300"
      />
      <button
        type="button"
        aria-label="Zoom timeline in"
        title="Zoom timeline in"
        disabled={value >= max}
        onClick={() => step(1)}
        className="grid h-5 w-5 place-items-center rounded border border-neutral-800 bg-neutral-950 text-[11px] leading-none transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-35"
      >
        +
      </button>
    </div>
  )
}

export function TimelinePanel({
  projectId,
  workflow,
  pendingGenerations,
  onArchiveNodes,
  isVisible,
}: TimelinePanelProps): JSX.Element {
  const composer = useChatComposer()
  const { reel, available } = useMemo(() => {
    // Defense-in-depth: exclude archived video nodes. The canonical archive
    // path also clears `shot_id` in the same mutation (see CanvasView's
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
  // the time / cumul / activeIdx math stay identical.
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

  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const [timelinePxPerSecond, setTimelinePxPerSecond] = useState(TIMELINE_DEFAULT_PX_PER_SECOND)
  const timelinePxPerSecondRef = useRef(timelinePxPerSecond)
  const timelineZoomAnchorRef = useRef<{ anchorTime: number; cursorClientX: number } | null>(null)
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0)
  const [timelineMaxScroll, setTimelineMaxScroll] = useState(0)

  useEffect(() => {
    timelinePxPerSecondRef.current = timelinePxPerSecond
  }, [timelinePxPerSecond])

  const updateTimelineScrollState = useCallback(() => {
    const el = timelineScrollRef.current
    if (!el) {
      setTimelineScrollLeft(0)
      setTimelineMaxScroll(0)
      return
    }
    setTimelineScrollLeft(el.scrollLeft)
    setTimelineMaxScroll(Math.max(0, el.scrollWidth - el.clientWidth))
  }, [])

  const applyTimelineZoom = useCallback((nextPxPerSecond: number, anchorClientX?: number) => {
    const current = timelinePxPerSecondRef.current
    const next = clampTimelinePxPerSecond(nextPxPerSecond)
    if (Math.abs(next - current) < 0.001) return

    const el = timelineScrollRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const clientX = anchorClientX ?? rect.left + el.clientWidth / 2
      const contentX = el.scrollLeft + clientX - rect.left
      timelineZoomAnchorRef.current = {
        anchorTime: contentX / current,
        cursorClientX: clientX,
      }
    }
    setTimelinePxPerSecond(next)
  }, [])

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
      // v.currentTime IS the sequence time. Update the transport time, then
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
      // Master ends naturally at total — stop and pin the transport time.
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
  useEffect(() => {
    if (!isVisible) return undefined

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return
      if (event.code !== 'Space' && event.key !== ' ') return
      if (isKeyboardShortcutTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      togglePlay()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return (): void => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [isVisible, togglePlay])

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

  const seekReelTo = (nextTime: number): void => {
    if (playlistMode !== 'reel' || total <= 0) return
    const t = Math.max(0, Math.min(total, nextTime))
    if (masterMode) {
      const v = videoRef.current
      if (v) { try { v.currentTime = t } catch { /* noop */ } }
      setTime(t)
      const i = clipAtMasterTime(t)
      if (i !== activeIdx) setActiveIdx(i)
      return
    }

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

  const seekPreviewTo = (nextTime: number): void => {
    if (total <= 0) return
    const t = Math.max(0, Math.min(total, nextTime))
    if (playlistMode === 'reel') {
      seekReelTo(t)
      return
    }
    const v = videoRef.current
    if (v) { try { v.currentTime = t } catch { /* noop */ } }
    setTime(t)
  }

  const seekReelFromClientX = (clientX: number): void => {
    const el = timelineScrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const contentX = el.scrollLeft + clientX - rect.left
    seekReelTo(contentX / timelinePxPerSecond)
  }

  const beginTimelineSeek = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    seekReelFromClientX(event.clientX)

    const onMove = (moveEvent: PointerEvent): void => {
      seekReelFromClientX(moveEvent.clientX)
    }
    const stopSeeking = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stopSeeking)
      window.removeEventListener('pointercancel', stopSeeking)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stopSeeking, { once: true })
    window.addEventListener('pointercancel', stopSeeking, { once: true })
  }

  // ---- Timeline reorder / move between sections ----
  //
  // Drop targets:
  //   - reel item     → insert/reorder at the item dnd-kit resolves.
  //   - reel-area     → append to the end of the row.
  //   - available     → set source.shot_id = null (remove from reel).
  //
  // After computing the new reel ordering, send one batch PATCH that
  // assigns shot_id = i+1 to each reel node (skip if already correct)
  // and shot_id = null to anything that left the reel.
  //
  // Explicit add/remove buttons use this path. Cross-region drag goes
  // through applyOptimisticOrder instead.
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

    const updates: CanvasNodeDataUpdate[] = []
    newReel.forEach((n, i) => {
      const want = i + 1
      if (n.data.shot_id !== want) updates.push({ nodeId: n.id, data: { shot_id: want } })
    })
    if (removed) updates.push({ nodeId: sourceId, data: { shot_id: null } })
    await patchCanvasNodeDataBatch(projectId, updates)
  }

  const removeFromReel = async (nodeId: string) => {
    await reorderTo(nodeId, { kind: 'available' })
  }
  const addToReelTail = async (nodeId: string) => {
    await reorderTo(nodeId, { kind: 'slot', index: reel.length })
  }
  const referClip = (nodeId: string): void => {
    composer?.insertAtCursor(`@${nodeId} `)
  }
  const archiveClip = (nodeId: string): void => {
    if (playlistMode === 'reel' && reel[activeIdx]?.id === nodeId) {
      setPlaying(false)
    }
    if (singleClip?.id === nodeId) {
      setSingleClip(null)
      setActiveIdx(0)
      setTime(0)
      setPlaying(false)
    }
    onArchiveNodes([nodeId])
  }

  // ---- dnd-kit reorder + cross-region drag -------------------------
  //
  // Dnd-kit owns every drag surface. Action buttons remain as explicit
  // alternatives to dragging.
  //
  // The user sees the new order instantly via `optimisticOrder`
  // overriding the truth-derived order; PATCH fires in the background;
  // `useEffect` clears optimistic when the canvas-state catch-up matches.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const dragBaselineRef = useRef<string[] | null>(null)
  // Sticky-over collision target. Persists the last valid over.id so
  // cursor wobble in dead-zone padding does not oscillate between two
  // closest droppables and strobe the preview.
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
  // byId pulls from both reel and available because cross-region drag
  // splices an Available source into optimisticOrder mid-drag.
  const effectiveReel = useMemo<VideoResultNode[]>(() => {
    if (optimisticOrder == null) return reel
    const byId = new Map<string, VideoResultNode>()
    for (const n of reel) byId.set(n.id, n)
    for (const n of available) byId.set(n.id, n)
    return optimisticOrder
      .map((id) => byId.get(id))
      .filter((n): n is VideoResultNode => Boolean(n))
  }, [reel, available, optimisticOrder])

  // When the cross-region preview engages, optimisticOrder includes
  // the source id and the source is rendered inside the reel row. Keep
  // it out of Available so it is not visible in both sections.
  const effectiveAvailable = useMemo<VideoResultNode[]>(() => {
    if (optimisticOrder == null) return available
    const optSet = new Set(optimisticOrder)
    return available.filter((n) => !optSet.has(n.id))
  }, [available, optimisticOrder])

  const reelTrack = useMemo(() => {
    let totalSeconds = 0

    for (const node of effectiveReel) {
      totalSeconds += timelineDurationSeconds(node)
    }

    return {
      totalSeconds,
      widthPx: Math.max(totalSeconds * timelinePxPerSecond, 1),
    }
  }, [effectiveReel, timelinePxPerSecond])

  useLayoutEffect(() => {
    const anchor = timelineZoomAnchorRef.current
    if (anchor === null) return
    timelineZoomAnchorRef.current = null

    const el = timelineScrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const targetScreenX = anchor.cursorClientX - rect.left
    el.scrollLeft = Math.max(0, anchor.anchorTime * timelinePxPerSecond - targetScreenX)
    updateTimelineScrollState()
  }, [timelinePxPerSecond, reelTrack.widthPx, updateTimelineScrollState])

  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) {
      updateTimelineScrollState()
      return undefined
    }

    const measure = () => updateTimelineScrollState()
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [reelTrack.widthPx, effectiveOrder.length, updateTimelineScrollState])

  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) return undefined

    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) {
        event.preventDefault()
        const current = timelinePxPerSecondRef.current
        applyTimelineZoom(
          current * Math.exp(-event.deltaY * TIMELINE_ZOOM_SENSITIVITY),
          event.clientX,
        )
        return
      }

      if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault()
        el.scrollLeft += event.deltaY
        updateTimelineScrollState()
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyTimelineZoom, effectiveOrder.length, updateTimelineScrollState])

  // Sparse renumber: only PATCH the cards whose shot_id actually changes.
  const applyOptimisticOrder = useCallback(
    (nextIds: string[]) => {
      if (projectId === null) return
      if (arraysEqual(nextIds, truthOrder)) {
        setOptimisticOrder(null)
        return
      }
      setOptimisticOrder(nextIds)
      const updates: CanvasNodeDataUpdate[] = []
      // Cross-region drag inserts an Available source id into nextIds,
      // so look up candidates in both sections before assigning shot_id.
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
      void patchCanvasNodeDataBatch(projectId, updates).catch(() => {
        // Rollback on failure; truth-derived order resumes next render.
        setOptimisticOrder(null)
      })
    },
    [projectId, reel, available, truthOrder],
  )

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Enter],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Enter, KeyboardCode.Tab],
      },
    }),
  )

  // Once the cursor commits to a droppable, stay committed until it
  // explicitly enters a different droppable's rect. Without this,
  // sub-pixel cursor wobble in dead-zone padding flips `closestCenter`
  // frame-to-frame and the preview strobes.
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

  // Cross-region drag from Available splices the source into the reel
  // at the over index mid-drag so neighbors reflow before release.
  // Intra-reel drag is skipped because dnd-kit's sortable transform
  // handles it.
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
        // Once preview engages, the source's <SortableClip> registers
        // as a droppable. pointerWithin can pick it as `over`. Without
        // this guard, the splice loops:
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
        } else if (overId !== 'available-drop') {
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
      // Dropping on itself is only a no-op for pre-existing reel clips.
      // A cross-region source can be over its optimistic preview slot;
      // commit that preview instead of treating it as unchanged.
      if (sourceId === overId) {
        if (baseline.includes(sourceId)) return
        if (optimisticOrder) applyOptimisticOrder(optimisticOrder)
        return
      }

      const oldIndex = baseline.indexOf(sourceId)
      const newIndex = baseline.indexOf(overId)
      const sourceInReel = oldIndex >= 0
      const overInReel = newIndex >= 0

      // Four drag classes, using the pre-drag truth as the baseline:
      //   1. Reel → Available (overId === 'available-drop'): clear shot_id via
      //      applyOptimisticOrder with the source filtered out. The
      //      null-clear branch of applyOptimisticOrder emits
      //      { shot_id: null } for the removed id.
      //   2. Intra-reel reorder (both in reel): arrayMove + apply.
      //   3. Available → reel slot (source not in reel, over IS in
      //      reel): splice the source into baseline at the over index.
      //   4. Available → reel-area: append. For an empty reel this
      //      becomes reel #1.
      // Anything else (no over, source/over in unknown regions): restore
      // baseline (preview was non-committal).
      if (sourceInReel && overId === 'available-drop') {
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

  // Cross-region drag introduces sources that are not in `reel` yet.
  // Fall back to `available` so the cursor ghost renders for Available
  // -> reel drags as well as intra-reel.
  const activeDragNode = useMemo(() => {
    if (activeDragId === null) return null
    return (
      reel.find((n) => n.id === activeDragId) ??
      available.find((n) => n.id === activeDragId) ??
      null
    )
  }, [activeDragId, reel, available])

  // When a cross-region drag previews an Available clip in the reel, the
  // source card unmounts from Available. Keep a placeholder in its slot
  // so Available does not reflow under the pointer.
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
  const [upscaleStatus, setUpscaleStatus] = useState<ReelUpscaleStatus>('idle')
  const [upscaleDraft, setUpscaleDraft] = useState<ReelUpscaleDraft | null>(null)
  const [upscaleError, setUpscaleError] = useState<string | null>(null)
  const autoDownloadedUpscaleJobRef = useRef<string | null>(null)

  const upscaleResultNode = useMemo<VideoResultNode | null>(() => {
    if (upscaleDraft === null || workflow === null) return null
    return workflow.nodes.find(
      (n): n is VideoResultNode =>
        isVideoNode(n) && n.data.metadata?.pending_job_id === upscaleDraft.job_id,
    ) ?? null
  }, [upscaleDraft, workflow])

  const downloadVideoNode = useCallback(async (
    node: VideoResultNode,
    fallbackName: string,
  ): Promise<void> => {
    const src = node.data.video_url
    if (typeof src !== 'string' || src === '') {
      throw new Error('video URL is not ready yet')
    }
    const res = await fetch(src)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = safeDownloadName(node.data.label, fallbackName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  }, [])

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

  useEffect(() => {
    setUpscaleStatus('idle')
    setUpscaleDraft(null)
    setUpscaleError(null)
    autoDownloadedUpscaleJobRef.current = null
  }, [projectId])

  const beginReelUpscale = async (): Promise<void> => {
    if (projectId === null || reel.length === 0) return
    if (upscaleStatus === 'ready' && upscaleResultNode !== null) {
      try {
        setUpscaleStatus('downloading')
        await downloadVideoNode(upscaleResultNode, 'upscaled-reel-4k.mp4')
        setUpscaleStatus('ready')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setUpscaleError(`4K result is ready, but download failed: ${msg}`)
        setUpscaleStatus('ready')
      }
      return
    }
    if (
      upscaleStatus === 'quoting' ||
      upscaleStatus === 'running' ||
      upscaleStatus === 'downloading'
    ) return
    setUpscaleStatus('quoting')
    setUpscaleError(null)
    setUpscaleDraft(null)
    autoDownloadedUpscaleJobRef.current = null
    try {
      const draft = await stageReelUpscaleDraft(projectId)
      setUpscaleDraft(draft)
      setUpscaleStatus('confirm')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setUpscaleError(msg)
      setUpscaleStatus('error')
    }
  }

  const confirmReelUpscale = async (): Promise<void> => {
    if (projectId === null || upscaleDraft === null) return
    setUpscaleStatus('running')
    setUpscaleError(null)
    try {
      await firePendingDraft(projectId, upscaleDraft.job_id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setUpscaleError(msg)
      setUpscaleStatus('error')
    }
  }

  const cancelReelUpscale = async (): Promise<void> => {
    const jobId = upscaleDraft?.job_id ?? null
    setUpscaleDraft(null)
    setUpscaleError(null)
    setUpscaleStatus('idle')
    if (projectId !== null && jobId !== null) {
      await discardPendingDraft(projectId, jobId).catch((err) => {
        console.warn(
          `[timeline:${projectId}] discard upscale draft failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
    }
  }

  useEffect(() => {
    if (upscaleDraft === null) return
    if (upscaleStatus !== 'running') return
    const failed = pendingGenerations.find(
      (entry) => entry.id === upscaleDraft.job_id && entry.stage === 'failed',
    )
    if (!failed) return
    setUpscaleError(failed.message || '4K upscale failed')
    setUpscaleStatus('error')
  }, [pendingGenerations, upscaleDraft, upscaleStatus])

  useEffect(() => {
    if (upscaleDraft === null || upscaleResultNode === null) return
    if (
      upscaleStatus !== 'running' &&
      upscaleStatus !== 'downloading'
    ) return
    if (autoDownloadedUpscaleJobRef.current === upscaleDraft.job_id) {
      setUpscaleStatus('ready')
      return
    }
    autoDownloadedUpscaleJobRef.current = upscaleDraft.job_id
    setUpscaleStatus('downloading')
    downloadVideoNode(upscaleResultNode, 'upscaled-reel-4k.mp4')
      .then(() => {
        setUpscaleStatus('ready')
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setUpscaleError(`4K result is ready, but download failed: ${msg}`)
        setUpscaleStatus('ready')
      })
  }, [downloadVideoNode, upscaleDraft, upscaleResultNode, upscaleStatus])

  const reelPlayheadPx =
    playlistMode === 'reel' && total > 0
      ? Math.max(0, Math.min(reelTrack.widthPx, time * timelinePxPerSecond))
      : null
  const aspect = playlist[activeIdx]?.data.aspect ?? '16:9'
  const aspectStyle = aspect.replace(':', ' / ')

  // The preview chrome (video + overlays + control row) renders in
  // ONE of two mount points at a time — inline at the top of the
  // panel, or inside the fullscreen modal. Keeping a single render
  // path avoids the JSX duplication that drifts under maintenance.
  const renderPreviewChrome = (variant: 'inline' | 'modal'): JSX.Element => {
    const expandTooltip = variant === 'modal' ? 'Close' : 'Expand'
    const expandIcon = variant === 'modal' ? '✕' : '⛶'
    const playTooltip =
      playing ? 'Pause' : time >= total && total > 0 ? 'Replay' : 'Play'
    const playIcon =
      playing ? '⏸' : time >= total && total > 0 ? '↻' : '▶'
    const toolbarIconClass =
      'grid h-8 w-10 shrink-0 place-items-center rounded-md border border-neutral-700 bg-neutral-900 text-[13px] leading-none text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white'
    const upscaleBusy =
      upscaleStatus === 'quoting' ||
      upscaleStatus === 'running' ||
      upscaleStatus === 'downloading'
    const upscaleButtonLabel =
      upscaleStatus === 'ready'
        ? 'Download 4K'
        : upscaleStatus === 'quoting'
          ? 'Preparing quote...'
          : upscaleStatus === 'running'
            ? 'Upscaling...'
            : upscaleStatus === 'downloading'
              ? 'Fetching...'
              : upscaleStatus === 'error'
                ? 'Retry 4K'
                : 'Upscale to 4K'
    const upscaleTitle =
      reel.length === 0
        ? 'Add at least one shot to the reel first'
        : upscaleStatus === 'ready'
          ? 'Download the latest 4K upscale'
          : upscaleBusy
            ? '4K upscale is in progress'
            : 'Upscale the entire reel to 4K'
    const upscaleCost =
      typeof upscaleDraft?.cost_usd === 'number' && Number.isFinite(upscaleDraft.cost_usd)
        ? `$${upscaleDraft.cost_usd.toFixed(2)}`
        : null
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
        {variant === 'modal' ? (
          <div className="px-5 pb-1 pt-3">
            <input
              type="range"
              min={0}
              max={Math.max(total, 0.01)}
              step={0.01}
              value={Math.max(0, Math.min(total, time))}
              disabled={total <= 0}
              aria-label="Seek preview"
              title="Seek preview"
              onChange={(e) => seekPreviewTo(Number(e.target.value))}
              className="h-1 w-full cursor-pointer accent-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
        ) : null}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2 text-neutral-300">
          <div className="flex min-w-0 items-center gap-3">
            <TimelineIconButton
              label={playTooltip}
              ariaLabel={playTooltip}
              onClick={togglePlay}
              className={toolbarIconClass}
            >
              <span aria-hidden>{playIcon}</span>
            </TimelineIconButton>
            <TimelineIconButton
              label="Restart"
              ariaLabel="Restart"
              onClick={restart}
              className={toolbarIconClass}
            >
              <span aria-hidden>↺</span>
            </TimelineIconButton>
          </div>
          <div className="font-mono text-[11px] text-neutral-400 tabular-nums">
            {formatTime(time)}
            <span className="px-1.5 text-neutral-700">/</span>
            {formatTime(total)}
          </div>
          <div className="flex min-w-0 items-center justify-end gap-3">
            {variant === 'inline' && reel.length > 0 ? (
              <TimelineZoomControl
                value={timelinePxPerSecond}
                onChange={applyTimelineZoom}
              />
            ) : null}
            <div className="relative">
              {upscaleError !== null && upscaleStatus !== 'confirm' ? (
                <div
                  className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-72 rounded-md border border-red-400/60 bg-[#130404] px-3 py-2 text-[11px] leading-snug text-red-100 shadow-[0_18px_60px_rgba(0,0,0,0.9)]"
                  title={upscaleError}
                >
                  {upscaleError}
                </div>
              ) : null}
              {upscaleStatus === 'confirm' && upscaleDraft !== null ? (
                <div className="absolute bottom-[calc(100%+10px)] right-0 z-50 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-neutral-500 bg-[#050505] text-left shadow-[0_24px_90px_rgba(0,0,0,0.95)] ring-1 ring-white/10">
                  <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-50">
                      Upscale current reel
                    </div>
                    <div className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-200">
                      4K
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <div className="space-y-1.5 text-[11px] leading-snug text-neutral-300">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-neutral-500">Source</span>
                        <span className="text-right text-neutral-200">
                          {upscaleDraft.shot_count ?? reel.length} clip{(upscaleDraft.shot_count ?? reel.length) === 1 ? '' : 's'}
                          {typeof upscaleDraft.duration === 'number' ? ` · ${formatTime(upscaleDraft.duration)}` : ''}
                        </span>
                      </div>
                      {upscaleDraft.source_resolution || upscaleDraft.target_resolution ? (
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-neutral-500">Resolution</span>
                          <span className="font-mono text-[11px] text-neutral-200">
                            {[upscaleDraft.source_resolution, upscaleDraft.target_resolution]
                              .filter((v): v is string => typeof v === 'string' && v !== '')
                              .join(' -> ')}
                          </span>
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="text-[11px] uppercase tracking-wide text-neutral-500">
                          Estimated cost
                        </span>
                        <span className="font-mono text-lg text-neutral-50">
                          {upscaleCost ?? 'Unknown'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void cancelReelUpscale()}
                        className="rounded-md border border-neutral-800 bg-[#080808] px-3 py-1.5 text-[11px] uppercase tracking-wide text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void confirmReelUpscale()}
                        className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-[11px] uppercase tracking-wide text-neutral-950 shadow-[0_0_0_1px_rgba(255,255,255,0.25)] transition-colors hover:bg-white"
                      >
                        {`Upscale${upscaleCost !== null ? ` · ${upscaleCost}` : ''}`}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              <TimelineIconButton
                label={upscaleTitle}
                ariaLabel={upscaleButtonLabel}
                onClick={() => void beginReelUpscale()}
                disabled={reel.length === 0 || upscaleBusy}
                className={
                  'flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-3 text-[11px] font-semibold leading-none transition-colors ' +
                  (upscaleBusy
                    ? 'cursor-wait border-neutral-700 bg-neutral-900 text-neutral-400'
                    : reel.length === 0
                      ? 'cursor-not-allowed border-neutral-800 bg-neutral-950 text-neutral-600'
                      : upscaleStatus === 'ready'
                        ? 'border-neutral-500 bg-neutral-100 text-neutral-950 hover:bg-white'
                        : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500 hover:text-white')
                }
              >
                <span aria-hidden className={upscaleBusy ? 'animate-pulse' : ''}>
                  {upscaleButtonLabel}
                </span>
              </TimelineIconButton>
            </div>
            <TimelineIconButton
              label="Download"
              ariaLabel="Download"
              disabled={downloading || reel.length === 0}
              onClick={() => void downloadReel()}
              className={
                'grid h-8 w-10 shrink-0 place-items-center rounded-md border text-[13px] leading-none transition-colors ' +
                (downloading
                  ? 'cursor-wait border-neutral-700 bg-neutral-900 text-neutral-400'
                  : reel.length === 0
                    ? 'cursor-not-allowed border-neutral-800 bg-neutral-950 text-neutral-600'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500 hover:text-white')
              }
            >
              <span aria-hidden className={downloading ? 'animate-pulse' : ''}>↓</span>
            </TimelineIconButton>
            <TimelineIconButton
              label={expandTooltip}
              ariaLabel={variant === 'modal' ? 'Close fullscreen preview' : 'Expand'}
              onClick={() => setFullscreenOpen((o) => !o)}
              className={toolbarIconClass}
            >
              <span aria-hidden>{expandIcon}</span>
            </TimelineIconButton>
          </div>
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
        {/* One DndContext wraps both reel and Available so cross-region drag
            can transition the same id between useDraggable and useSortable. */}
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
            <div className="min-h-[88px] px-4 py-3">
              {/* ReelAreaDroppable handles empty-reel drops and appends
                  past the last card; card drops still take precedence. */}
              <ReelAreaDroppable showEmptyHint={effectiveOrder.length === 0}>
                <div className="relative rounded-md border border-neutral-900 bg-neutral-950/40">
                  <div
                    ref={timelineScrollRef}
                    className="scrollbar-subtle overflow-x-auto"
                    onScroll={updateTimelineScrollState}
                  >
                    <div
                      className="relative min-w-full"
                      style={{ width: reelTrack.widthPx }}
                    >
                      <TimelineRuler
                        totalSeconds={reelTrack.totalSeconds}
                        widthPx={reelTrack.widthPx}
                        pxPerSecond={timelinePxPerSecond}
                        onPointerDown={beginTimelineSeek}
                      />
                      {reelPlayheadPx !== null ? (
                        <div
                          className="pointer-events-none absolute bottom-0 top-0 z-20"
                          style={{ left: reelPlayheadPx }}
                        >
                          <div
                            aria-hidden
                            title="Drag playhead"
                            onPointerDown={beginTimelineSeek}
                            className="pointer-events-auto absolute -top-px left-1/2 h-3 w-3 -translate-x-1/2 touch-none cursor-ew-resize rounded-b-sm bg-neutral-100 shadow-[0_0_12px_rgba(255,255,255,0.45)]"
                          />
                          <div className="h-full w-px bg-neutral-100 shadow-[0_0_10px_rgba(255,255,255,0.55)]" />
                        </div>
                      ) : null}
                      <SortableContext items={effectiveOrder} strategy={horizontalListSortingStrategy}>
                        <div className="flex h-[118px] min-w-full items-stretch overflow-visible bg-neutral-950">
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
                              <SortableClip
                                key={n.id}
                                id={n.id}
                                widthPx={timelineClipWidth(n, timelinePxPerSecond)}
                              >
                                <ReelCard
                                  node={n}
                                  active={isActive}
                                  isPlaying={isActive && playing}
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
                                  onRefer={() => referClip(n.id)}
                                  onArchive={() => archiveClip(n.id)}
                                  referDisabled={composer === null}
                                />
                              </SortableClip>
                            )
                          })}
                        </div>
                      </SortableContext>
                    </div>
                  </div>
                  {timelineScrollLeft > 1 ? (
                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 z-30 w-10 rounded-l-md"
                      style={{ background: 'linear-gradient(90deg, #0a0a0a 0%, rgba(10,10,10,0) 100%)' }}
                    />
                  ) : null}
                  {timelineScrollLeft < timelineMaxScroll - 1 ? (
                    <div
                      className="pointer-events-none absolute inset-y-0 right-0 z-30 w-10 rounded-r-md"
                      style={{ background: 'linear-gradient(270deg, #0a0a0a 0%, rgba(10,10,10,0) 100%)' }}
                    />
                  ) : null}
                </div>
              </ReelAreaDroppable>
            </div>
          </div>

          {/* AvailableDroppable handles reel-card drops that remove a
              clip from the reel; hover actions cover explicit commands. */}
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
                        onRefer={() => referClip(n.id)}
                        onArchive={() => archiveClip(n.id)}
                        referDisabled={composer === null}
                      />
                    </DraggableCompactCard>
                  )
                })}
                {/* Rect-stable placeholder for the in-flight cross-region source. */}
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
  onClick,
  onAction,
  onRefer,
  onArchive,
  referDisabled,
}: {
  node: VideoResultNode
  active: boolean
  isPlaying: boolean
  onClick: () => void
  onAction: () => void
  onRefer: () => void
  onArchive: () => void
  referDisabled: boolean
}): JSX.Element {
  const url = node.data.video_url
  const shotId = node.data.shot_id
  const label = node.data.label ?? 'untitled'
  return (
    <div
      className={
        'group relative h-full overflow-hidden rounded-md border bg-neutral-950 transition-colors ' +
        (active
          ? 'border-neutral-300'
          : 'border-neutral-800 hover:border-neutral-700')
      }
    >
      <button type="button" onClick={onClick} className="absolute inset-0 block w-full text-left">
        {url !== '' ? (
          <video
            src={url}
            preload="metadata"
            muted
            playsInline
            draggable={false}
            className="block h-full w-full object-cover"
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
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2 pb-2 pt-8">
          <div className="truncate text-xs text-neutral-100 drop-shadow">{label}</div>
        </div>
        {active ? (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-neutral-300" />
        ) : null}
      </button>
      <TimelineActionCluster
        referDisabled={referDisabled}
        onRefer={onRefer}
        onArchive={onArchive}
      >
        <TimelineIconButton
          label="Remove from reel"
          ariaLabel="Remove from reel"
          onClick={onAction}
          className="grid h-5 w-5 shrink-0 place-items-center rounded border border-neutral-600/80 bg-neutral-950/90 text-[14px] leading-none text-neutral-200 shadow-sm shadow-black/30 backdrop-blur transition-colors hover:border-neutral-400 hover:bg-neutral-900 hover:text-white"
        >
          ×
        </TimelineIconButton>
      </TimelineActionCluster>
    </div>
  )
}

function TimelineActionCluster({
  referDisabled,
  onRefer,
  onArchive,
  children,
}: {
  referDisabled: boolean
  onRefer: () => void
  onArchive: () => void
  children: JSX.Element
}): JSX.Element {
  const buttonBase =
    'grid h-5 w-5 shrink-0 place-items-center rounded border border-neutral-600/80 bg-neutral-950/90 text-neutral-200 shadow-sm shadow-black/30 backdrop-blur transition-colors hover:border-neutral-400 hover:bg-neutral-900 hover:text-white'
  return (
    <div className="absolute right-0.5 top-1 z-20 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <TimelineIconButton
        label="Refer"
        ariaLabel="Refer clip"
        disabled={referDisabled}
        onClick={onRefer}
        className={`${buttonBase} font-mono text-[11px] font-semibold ${
          referDisabled
            ? 'cursor-not-allowed border-neutral-800 text-neutral-600'
            : ''
        }`}
      >
        @
      </TimelineIconButton>
      <TimelineIconButton
        label="Archive"
        ariaLabel="Archive clip"
        onClick={onArchive}
        className={`${buttonBase} hover:border-red-400/70 hover:bg-red-500/15 hover:text-red-200`}
      >
        <ArchiveIcon />
      </TimelineIconButton>
      {children}
    </div>
  )
}

function TimelineIconButton({
  label,
  ariaLabel,
  disabled = false,
  onClick,
  className,
  children,
}: {
  label: string
  ariaLabel: string
  disabled?: boolean
  onClick: () => void
  className: string
  children: JSX.Element | string
}): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null)
  const showTooltip = (): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ x: rect.left + rect.width / 2, y: rect.top - 6 })
  }
  const hideTooltip = (): void => setTooltip(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        aria-disabled={disabled}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (!disabled) onClick()
        }}
        className={className}
      >
        {children}
      </button>
      {tooltip !== null
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[80] rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-100 shadow-lg shadow-black/40"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                transform: 'translate(-50%, -100%)',
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function CompactCard({
  node,
  active,
  isPlaying,
  onClick,
  onAdd,
  onRefer,
  onArchive,
  referDisabled,
}: {
  node: VideoResultNode
  active: boolean
  isPlaying: boolean
  onClick: () => void
  onAdd: () => void
  onRefer: () => void
  onArchive: () => void
  referDisabled: boolean
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
      <TimelineActionCluster
        referDisabled={referDisabled}
        onRefer={onRefer}
        onArchive={onArchive}
      >
        <TimelineIconButton
          label="Put on reel"
          ariaLabel="Put on reel"
          onClick={onAdd}
          className="grid h-5 w-5 shrink-0 place-items-center rounded border border-neutral-600/80 bg-neutral-950/90 text-[13px] font-semibold leading-none text-neutral-100 shadow-sm shadow-black/30 backdrop-blur transition-colors hover:border-neutral-400 hover:bg-neutral-900 hover:text-white"
        >
          +
        </TimelineIconButton>
      </TimelineActionCluster>
      <div className="truncate px-1.5 py-1 text-[10px] text-neutral-400">
        {label}
      </div>
    </div>
  )
}

function ArchiveIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 5.5h10" />
      <path d="M4 5.5v8h8v-8" />
      <path d="M2.75 2.5h10.5v3H2.75z" />
      <path d="M6.5 8h3" />
    </svg>
  )
}
