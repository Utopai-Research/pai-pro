import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import type { VideoResultData } from '@/types/canvas'
import {
  downloadHref,
  parseAspectRatio,
  sizeForAspect,
  type NodeState,
} from '../nodeData'
import { useNodeActions } from '../NodeActionsContext'
import { NodeHead, useZoomedOut, ZoomedOutPlaceholder } from './_shared'
import type { MediaRef } from '../MediaExpandOverlay'

// `derived_refs` is added by projection.ts — refs to source nodes that
// reached this one via `--ref-source-id` (canvas `derived` edges).
type VideoResultRenderData = Partial<VideoResultData> & {
  state?: NodeState
  derived_refs?: MediaRef[]
}

export function VideoResultNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as VideoResultRenderData
  const state: NodeState = d.state ?? 'complete'
  const url = d.video_url ?? null
  const label = d.label ?? 'video'
  const shotId = typeof d.shot_id === 'number' ? d.shot_id : null
  const rawAr = d.aspect ?? d.metadata?.aspect_ratio
  const parsed = parseAspectRatio(rawAr) ?? { w: 16, h: 9 }
  const bodyAspect = `${parsed.w} / ${parsed.h}`
  const size = sizeForAspect(rawAr)
  const modelChip = 'video'
  const meta = [
    modelChip,
    d.metadata?.resolution,
    typeof d.duration === 'number' ? `${d.duration}s` : null,
  ]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' · ')

  const { onExpandMedia } = useNodeActions()
  // Read-only indicator: shown only when the clip is assigned to a reel
  // slot. Assign + clear both live in the TimelinePanel (drag from
  // Available to assign, Remove button to clear) so this badge has no
  // click handler.
  const showShotBadge = url !== null && url !== '' && shotId !== null
  const canExpand = url !== null && url !== '' && onExpandMedia !== undefined
  const expandVideo = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!canExpand || url === null) return
    onExpandMedia?.({
      id,
      kind: 'video',
      url,
      label,
      meta,
      prompt: d.prompt,
      references: d.derived_refs ?? [],
      nodeType: 'video_result',
      metadata: d.metadata,
      duration: d.duration,
    })
  }

  const zoomedOut = useZoomedOut()
  const target = Position.Left, source = Position.Right

  return (
    <div
      className={`node video_result${selected ? ' selected' : ''}`}
      data-state={state}
      style={{ width: size.w }}
    >
      <Handle type="target" position={target} />
      <NodeHead label={`@${id}`} state={state} assetStatusUrl={url} />
      <div
        className="node-body"
        onDoubleClick={canExpand ? expandVideo : undefined}
        style={{
          position: 'relative',
          aspectRatio: bodyAspect,
          overflow: 'hidden',
          background: 'var(--bg-1, #1a1a1f)',
          cursor: canExpand ? 'zoom-in' : 'default',
        }}
      >
        {zoomedOut ? (
          // B2: zoomed-out — skip the <video> entirely (decode + buffer
          // both expensive). Same threshold + placeholder as image nodes.
          <ZoomedOutPlaceholder />
        ) : url !== null && url !== '' ? (
          // biome-ignore lint/a11y/useMediaCaption: provider videos lack captions.
          <video
            src={url}
            controls
            controlsList="nofullscreen"
            disablePictureInPicture
            loop
            muted
            preload="metadata"
            playsInline
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
            onDoubleClick={
              canExpand
                ? (e) => {
                    e.preventDefault()
                    expandVideo(e)
                  }
                : undefined
            }
            onError={(e) => {
              ;(e.currentTarget as HTMLVideoElement).style.display = 'none'
            }}
          />
        ) : null}
        {showShotBadge ? (
          <span
            className="shot-badge"
            title={`Shot #${shotId} — assigned to the timeline reel`}
          >
            {`#${shotId}`}
          </span>
        ) : null}
        {url !== null && url !== '' ? (
          <a
            className="media-download-btn"
            href={downloadHref(url)}
            download
            title="Download"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⬇
          </a>
        ) : null}
        {canExpand ? (
          <button
            type="button"
            className="media-expand-btn"
            title="Expand in canvas (or double-click the video)"
            onClick={expandVideo}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⤢
          </button>
        ) : null}
      </div>
      <div className="node-foot nodrag">
        <span>{label}</span>
        {meta !== '' ? <span>{meta}</span> : null}
      </div>
      <Handle type="source" position={source} />
    </div>
  )
}
