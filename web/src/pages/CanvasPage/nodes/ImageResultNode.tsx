/**
 * ImageResultNode. Reads canonical-shape data fields populated by
 * projection.ts.
 *
 * Subtypes from `@/types/canvas` (`character | location | edit |
 * reference | split`); the renderer also handles undefined subtype
 * (plain image) by emitting `data-subtype="image"` for the CSS rule
 * set. Only `edit` and `reference` change rendering today: `edit`
 * surfaces `source_id` in the footer; `reference` swaps the footer
 * to `source_filename` and forces `object-fit: contain` so pasted-in
 * shapes don't crop. Character voice playback lives on the linked
 * audio_result node, not here — the character card stays a pure image.
 */
import type { CSSProperties } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import type { ImageResultData } from '@/types/canvas'
import {
  downloadHref,
  parseAspectRatio,
  sizeForAspect,
  type NodeState,
} from '../nodeData'
import { useNodeActions } from '../NodeActionsContext'
import { ImageWithFade, NodeHead, useZoomedOut, ZoomedOutPlaceholder } from './_shared'
import type { MediaRef } from '../MediaExpandOverlay'

// `derived_refs` is added by projection.ts — refs to source nodes that
// reached this one via `--ref-source-id` (canvas `derived` edges).
type ImageResultRenderData = Partial<ImageResultData> & {
  state?: NodeState
  derived_refs?: MediaRef[]
}

const SHARED_PLACEHOLDER_STYLES: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  background:
    'repeating-linear-gradient(45deg, #2a2a32, #2a2a32 8px, #25252c 8px, #25252c 16px)',
  borderRadius: 6,
}

export function ImageResultNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as ImageResultRenderData
  const state: NodeState = d.state ?? 'pending'
  const url = d.image_url ?? null
  const label = d.label ?? 'image'
  const subtype = d.subtype
  const rawAr = d.metadata?.aspect_ratio
  const parsed = parseAspectRatio(rawAr) ?? { w: 16, h: 9 }
  const bodyAspect = `${parsed.w} / ${parsed.h}`
  const size = sizeForAspect(rawAr)
  const modelChip = 'image'
  const meta = [modelChip, d.metadata?.image_size]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' · ')

  // Reference images don't carry an aspect_ratio in metadata — without
  // one the body lays out at 16:9 and `cover` would crop. Use `contain`
  // for references so the full image stays visible regardless of shape.
  const isReference = subtype === 'reference'
  const imgObjectFit: CSSProperties['objectFit'] = isReference ? 'contain' : 'cover'

  // Edits + references surface lineage in the footer because it's
  // information the bitmap alone can't convey.
  const footLeft: string =
    subtype === 'edit' && d.source_id !== undefined && d.source_id !== ''
      ? `edit of ${d.source_id}`
      : subtype === 'reference' && d.source_filename !== undefined && d.source_filename !== ''
        ? d.source_filename
        : label

  const { onExpandMedia } = useNodeActions()
  const canExpand = url !== null && url !== '' && onExpandMedia !== undefined
  const expandImage = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!canExpand || url === null) return
    onExpandMedia?.({
      id,
      kind: 'image',
      url,
      label,
      meta,
      prompt: d.prompt,
      references: d.derived_refs ?? [],
      nodeType: 'image_result',
      metadata: d.metadata,
    })
  }
  const zoomedOut = useZoomedOut()
  const target = Position.Left, source = Position.Right

  return (
    <div
      className={`node image_result${selected ? ' selected' : ''}`}
      data-state={state}
      data-subtype={subtype ?? 'image'}
      style={{ width: size.w }}
    >
      <Handle type="target" position={target} />
      <NodeHead label={`@${id}`} state={state} assetStatusUrl={url} />
      <div
        className="node-body"
        onDoubleClick={canExpand ? expandImage : undefined}
        style={{
          position: 'relative',
          aspectRatio: bodyAspect,
          overflow: 'hidden',
          background: 'var(--bg-1, #1a1a1f)',
          cursor: canExpand ? 'zoom-in' : 'default',
        }}
      >
        {zoomedOut ? (
          // B2: zoomed-out — skip the bitmap entirely.
          <ZoomedOutPlaceholder />
        ) : url !== null && url !== '' ? (
          // B1: lazy load + async decode + low fetch priority for off-
          // screen images; 300ms opacity fade-in once the bitmap is
          // ready avoids the paint-jank pop on a large canvas. Pattern
          // from pai-next 86eb510e.
          <ImageWithFade
            src={url}
            alt={label}
            objectFit={imgObjectFit}
          />
        ) : (
          <div style={SHARED_PLACEHOLDER_STYLES} />
        )}
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
            title="Expand in canvas (or double-click the image)"
            onClick={expandImage}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⤢
          </button>
        ) : null}
      </div>
      <div className="node-foot nodrag">
        <span>{footLeft}</span>
        {meta !== '' ? <span>{meta}</span> : null}
      </div>
      <Handle type="source" position={source} />
    </div>
  )
}

