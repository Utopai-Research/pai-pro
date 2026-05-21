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
import { useEffect, useMemo, useRef, useState } from 'react'
import { VIEWER_URL } from '@/lib/socket'
import type { Workflow, VideoResultNode } from '@/types/canvas'

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

const DRAG_MIME = 'application/x-pai-pro-clip'

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
  const [dragOver, setDragOver] = useState<
    | { kind: 'slot'; index: number }
    | { kind: 'available' }
    | null
  >(null)

  const reorderTo = async (
    sourceId: string,
    destination:
      | { kind: 'slot'; index: number }
      | { kind: 'available' },
  ) => {
    if (projectId === null) return
    setDragOver(null)
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

  const onCardDragStart = (e: React.DragEvent, nodeId: string) => {
    e.dataTransfer.setData(DRAG_MIME, nodeId)
    e.dataTransfer.effectAllowed = 'move'
  }

  // Compute the insertion slot from a drag event over a reel card.
  // Left half of the card → insert before; right half → insert after.
  const slotFromCardEvent = (
    e: React.DragEvent,
    cardIndex: number,
  ): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? cardIndex : cardIndex + 1
  }

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
        <div className="border-b border-neutral-900">
          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
            On reel ({reel.length})
            <span className="ml-2 normal-case tracking-normal text-neutral-700">
              · drag to reorder · drop from Available to add
            </span>
          </div>
          <div
            className={
              'min-h-[88px] px-4 pb-3 transition-colors ' +
              (dragOver?.kind === 'slot' ? 'bg-neutral-900/30' : '')
            }
            onDragOver={(e) => {
              // Container fallback — fires when the cursor is over empty
              // grid space (between rows, past the last card). Card
              // handlers stopPropagation so this doesn't overwrite their
              // more-precise slot when the cursor is on a card.
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault()
                setDragOver({ kind: 'slot', index: reel.length })
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOver(null)
              }
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_MIME)
              if (id) {
                e.preventDefault()
                void reorderTo(id, { kind: 'slot', index: reel.length })
              }
            }}
          >
            {reel.length === 0 ? (
              <div
                className={
                  'flex h-20 items-center justify-center rounded-md border border-dashed px-4 text-center text-[11px] uppercase tracking-wide transition-colors ' +
                  (dragOver?.kind === 'slot'
                    ? 'border-neutral-300 bg-neutral-900/60 text-neutral-200'
                    : 'border-neutral-800 text-neutral-600')
                }
              >
                Drag a clip here to start the reel
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
                {reel.map((n, i) => {
                  const isActive =
                    playlistMode === 'reel' &&
                    i === activeIdx &&
                    playlist.length > 0
                  const slot = dragOver?.kind === 'slot' ? dragOver.index : -1
                  // Left bar lights for the card sitting at the
                  // insertion point. Right bar lights only on the last
                  // card when the insertion point is at reel.length
                  // (append) — every other "after card i" is the same
                  // as "before card i+1" and shown there instead, so
                  // only one bar lights for any given slot.
                  const dropEdge: 'left' | 'right' | null =
                    slot === i
                      ? 'left'
                      : slot === reel.length && i === reel.length - 1
                        ? 'right'
                        : null
                  return (
                    <ReelCard
                      key={n.id}
                      node={n}
                      active={isActive}
                      isPlaying={isActive && playing}
                      dropEdge={dropEdge}
                      onClick={() => (isActive ? togglePlay() : playReelFrom(i))}
                      onAction={() => removeFromReel(n.id)}
                      actionLabel="Remove"
                      onDragStart={(e) => onCardDragStart(e, n.id)}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes(DRAG_MIME)) {
                          e.preventDefault()
                          e.stopPropagation()
                          setDragOver({
                            kind: 'slot',
                            index: slotFromCardEvent(e, i),
                          })
                        }
                      }}
                      onDragLeave={() => {/* container handler resolves */}}
                      onDrop={(e) => {
                        const id = e.dataTransfer.getData(DRAG_MIME)
                        if (id) {
                          e.preventDefault()
                          e.stopPropagation()
                          void reorderTo(id, {
                            kind: 'slot',
                            index: slotFromCardEvent(e, i),
                          })
                        }
                      }}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Available section: compact thumbs + drop target to remove. */}
        <div
          className={
            'border-b border-neutral-900 transition-colors ' +
            (dragOver?.kind === 'available' ? 'bg-neutral-900/40' : '')
          }
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DRAG_MIME)) {
              e.preventDefault()
              setDragOver({ kind: 'available' })
            }
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(DRAG_MIME)
            if (id) {
              e.preventDefault()
              void reorderTo(id, { kind: 'available' })
            }
          }}
        >
          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
            Available clips ({available.length})
            <span className="ml-2 normal-case tracking-normal text-neutral-700">
              · click to play / pause · drag onto reel to add
            </span>
          </div>
          {available.length === 0 ? (
            <div className="px-4 pb-4 text-xs text-neutral-600">
              No off-reel video clips on this canvas.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 px-4 pb-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
              {available.map((n) => {
                const isActive =
                  singleClip !== null && singleClip.id === n.id
                return (
                  <CompactCard
                    key={n.id}
                    node={n}
                    active={isActive}
                    isPlaying={isActive && playing}
                    onClick={() => (isActive ? togglePlay() : playSingle(n))}
                    onAdd={() => addToReelTail(n.id)}
                    onDragStart={(e) => onCardDragStart(e, n.id)}
                  />
                )
              })}
            </div>
          )}
        </div>
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
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}): JSX.Element {
  const url = node.data.video_url
  const shotId = node.data.shot_id
  const label = node.data.label ?? 'untitled'
  const aspect = node.data.aspect ?? '16:9'
  const duration = node.data.duration
  return (
    <div
      draggable
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
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-neutral-200">{label}</div>
          <div className="truncate font-mono text-[10px] text-neutral-500">
            {aspect}
            {typeof duration === 'number' ? ` · ${duration}s` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onAction()
          }}
          className="rounded border border-red-900/60 bg-red-950/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-300 transition-colors hover:border-red-700"
        >
          {actionLabel}
        </button>
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
  onDragStart,
}: {
  node: VideoResultNode
  active: boolean
  isPlaying: boolean
  onClick: () => void
  onAdd: () => void
  onDragStart: (e: React.DragEvent) => void
}): JSX.Element {
  const url = node.data.video_url
  const label = node.data.label ?? 'untitled'
  const aspect = node.data.aspect ?? '16:9'
  return (
    <div
      draggable
      onDragStart={onDragStart}
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
