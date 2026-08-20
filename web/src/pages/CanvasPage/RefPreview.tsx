/**
 * The enlarged reference preview: hover a reference thumbnail, get a bigger
 * look at it; click that look, land on the card it came from.
 *
 * One implementation on purpose. The overlay paints reference thumbnails in
 * more than one place (the collapsed strip's tiles, the expanded panel's
 * grid, the `@Image1` chips inside the prompt), and each of those rows wants
 * its own markup — they are 28px, 96px and inline-with-text respectively. What
 * they must NOT each own is the enlarged view and its behaviour: the rule that
 * the preview has to close before the canvas moves lives here, once, so no row
 * can be fixed while another keeps the bug.
 *
 * MUST be rendered inside `<ReactFlowProvider>` — the audio body reads the
 * source node off the canvas store. MediaExpandOverlay mounts inside it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow } from '@xyflow/react'

import { formatAudioTime, notifyPaused, notifyPlaying } from './audioPlayback'
import {
  AUDIO_AUTOPLAY_DELAY_MS,
  audioDurationOf,
  audioTextOf,
  canPreviewRef,
  type AudioNodeDataLike,
} from './refPreviewRules'
import type { RefHoverPreview } from './useRefHoverPreview'

// Re-exported so a row imports the gate from the component it already imports.
// It LIVES in refPreviewRules.ts because vitest here cannot reach a `.tsx`.
export { canPreviewRef }

/**
 * Tallest a preview can be — the `max-height` on its image/video in
 * expand-overlay.css, plus the gap and the frame's own border. Used to decide
 * which side of the thumb it fits on.
 */
const PREVIEW_CLEARANCE_PX = 258

export interface RefPreviewAnchor {
  left: number
  top: number
  /** Which side of the thumb the preview hangs off. The overlay's reference
   *  tiles sit in the top strip, a hundred-odd pixels from the top of the
   *  window — hanging upwards from there puts the whole preview above the
   *  viewport, where it is not just unreachable but invisible, so the feature
   *  looks broken rather than mispositioned. */
  side: 'above' | 'below'
}

/**
 * Where to pin the preview, measured off the thumb's own viewport rect.
 *
 * Measured when the preview OPENS, not on every render: the overlay re-renders
 * on every canvas change, and a rect read per render is layout thrash for a
 * value nobody is looking at while it is closed.
 */
export function useRefPreviewAnchor(
  isHover: boolean,
  canPreview: boolean,
): {
  wrapRef: React.MutableRefObject<HTMLSpanElement | null>
  anchor: RefPreviewAnchor | null
} {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const [anchor, setAnchor] = useState<RefPreviewAnchor | null>(null)

  useLayoutEffect(() => {
    if (!isHover || !canPreview) {
      setAnchor(null)
      return
    }
    const el = wrapRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const above = r.top >= PREVIEW_CLEARANCE_PX
    setAnchor({
      left: Math.round(r.left + r.width / 2),
      top: Math.round(above ? r.top : r.bottom),
      side: above ? 'above' : 'below',
    })
  }, [isHover, canPreview])

  return { wrapRef, anchor }
}

interface AudioDetail {
  text: string | null
  durationSec: number | null
}

/**
 * The spoken line and duration behind an audio reference.
 *
 * The lookup runs on OPEN, never on render. A reference carries `{ kind, url,
 * sourceId }` — the line and the duration live on the source NODE, so getting
 * them means reading the canvas. Doing that during render would re-run on
 * every canvas change for a panel that is closed most of the time. `getNodes`
 * is a function off the store, so reading it inside an effect subscribes to
 * nothing.
 */
function useAudioRefDetail(enabled: boolean, sourceId: string | undefined): AudioDetail {
  const { getNodes } = useReactFlow()
  const [detail, setDetail] = useState<AudioDetail>({ text: null, durationSec: null })

  useEffect(() => {
    if (!enabled || sourceId === undefined || sourceId === '') {
      setDetail({ text: null, durationSec: null })
      return
    }
    const hit = getNodes().find((n) => n.id === sourceId)
    const data = (hit?.data ?? {}) as AudioNodeDataLike
    setDetail({ text: audioTextOf(data), durationSec: audioDurationOf(data) })
  }, [enabled, sourceId, getNodes])

  return detail
}

/**
 * The audio preview's body: the line, a progress rail, the clock, the source.
 *
 * No transport controls, and that is a decision rather than an omission.
 * Hovering starts it after `AUDIO_AUTOPLAY_DELAY_MS` and leaving stops it by
 * unmounting this component, so "play" and "stop" are both already spoken for
 * by the gesture that opened the panel. A play button here would also take
 * back half of the click, which belongs to the jump.
 *
 * The rail is a rail rather than a waveform because decoding the envelope
 * needs a WebAudio pass this repo doesn't have yet. It still answers "how far
 * in am I", and never pretends to be a shape it hasn't measured.
 */
function AudioPreviewBody({
  url,
  detail,
  sourceId,
}: {
  url: string
  detail: AudioDetail
  sourceId: string | undefined
}): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Falls back to what the element reports once it has loaded metadata — a
  // measurement, and better than nothing for nodes minted before
  // `metadata.duration_sec` existed.
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null)
  const duration = detail.durationSec ?? loadedDuration

  // This component only exists while the preview is open, so "mounted for
  // AUDIO_AUTOPLAY_DELAY_MS" IS "hovered for AUDIO_AUTOPLAY_DELAY_MS". Keeping
  // the timer here rather than in useRefHoverPreview is what keeps the enter
  // delay and the leave grace from sharing state.
  useEffect(() => {
    const timer = setTimeout(() => {
      void audioRef.current?.play().catch(() => {
        /* autoplay policy, a codec the browser dislikes, a 404: stay silent */
      })
    }, AUDIO_AUTOPLAY_DELAY_MS)
    return () => {
      clearTimeout(timer)
      const el = audioRef.current
      if (el !== null) {
        el.pause()
        notifyPaused(el)
      }
    }
  }, [])

  const progress = duration !== null && duration > 0 ? Math.min(1, elapsed / duration) : 0

  return (
    <span className="me-ref-audio">
      {detail.text !== null ? <span className="me-ref-audio-line">{detail.text}</span> : null}
      <span className="me-ref-audio-row">
        <span className="me-ref-audio-rail">
          <span className="me-ref-audio-rail-fill" style={{ width: `${progress * 100}%` }} />
        </span>
        {duration !== null ? (
          <span className="me-ref-audio-clock">
            {formatAudioTime(elapsed > 0 ? elapsed : duration)}
          </span>
        ) : null}
      </span>
      <span className="me-ref-audio-meta">
        {sourceId !== undefined && sourceId !== '' ? `voice · from ${sourceId}` : 'voice'}
      </span>
      {/* biome-ignore lint/a11y/useMediaCaption: reference preview */}
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={(e) => notifyPlaying(e.currentTarget)}
        onPause={(e) => notifyPaused(e.currentTarget)}
        onEnded={(e) => notifyPaused(e.currentTarget)}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setLoadedDuration(d)
        }}
      />
    </span>
  )
}

/**
 * A body portal, not a child. The rows that host this sit inside the top
 * strip, which clips its own overflow so the collapsed bar stays one line —
 * an absolutely positioned preview inside it would be cut to a sliver.
 */
export function RefPreviewPortal({
  kind,
  url,
  sourceId,
  anchor,
  hover,
  onJump,
}: {
  kind: string
  url: string
  /** The node this reference's bytes came from, carried on the ref itself
   *  (see projection.ts). Absent for a source that is no longer on the
   *  canvas — the preview still opens, it just has nowhere to jump. */
  sourceId?: string
  anchor: RefPreviewAnchor | null
  hover: RefHoverPreview
  onJump: () => void
}): JSX.Element | null {
  const open = hover.isHover && anchor !== null && canPreviewRef(kind, url)
  // Hooks cannot sit behind the early return, and this one must not run while
  // closed anyway — `enabled` is what keeps the canvas read on the open edge.
  const detail = useAudioRefDetail(open && kind === 'audio', sourceId)

  if (!open || anchor === null) return null
  return createPortal(
    <button
      type="button"
      // `canvas-host` is load-bearing, and leaving it off fails silently for
      // images. The oklch tokens are declared on `.canvas-host`, NOT on
      // `:root`, and this button is portalled to <body> — outside it. Without
      // the class every `var(--…)` here resolves to empty, so the frame
      // renders transparent and borderless. An image fills the box edge to
      // edge so nobody would notice; the audio body is text on a panel, so
      // the same bug reads as "the preview did not render".
      className={
        'canvas-host me-ref-preview me-ref-preview-' +
        anchor.side +
        (kind === 'audio' ? ' me-ref-preview-audio' : '')
      }
      title="Go to the card this came from"
      style={{ left: anchor.left, top: anchor.top }}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      onClick={(e) => {
        // A portal's events still bubble through the REACT tree, so without
        // this the click also lands on the top strip's collapse button.
        e.stopPropagation()
        // Close before jumping, and from here rather than from each caller —
        // this portal is the single place every row's preview is rendered, so
        // it is the only place the rule cannot be forgotten. See
        // `RefHoverPreview.dismiss`.
        hover.dismiss()
        onJump()
      }}
    >
      {kind === 'image' ? (
        <img src={url} alt="reference preview" decoding="async" />
      ) : kind === 'audio' ? (
        <AudioPreviewBody url={url} detail={detail} sourceId={sourceId} />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: reference preview
        <video src={url} muted playsInline preload="metadata" />
      )}
    </button>,
    document.body,
  )
}
