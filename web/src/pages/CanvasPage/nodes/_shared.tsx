/**
 * Shared chrome used by every node renderer in this directory.
 *
 *   - NodeHead — head row with label, lifecycle state chip, asset status chip
 *   - ImageWithFade — <img> with lazy decode + 300ms opacity fade-in
 *   - ZoomedOutPlaceholder / useZoomedOut — viewport-cull below ZOOM_THRESHOLD
 *   - nodePropsEqual — narrow memo equality (data ref + selected)
 *
 * `data` from RF flows through projection.ts which preserves identity
 * for unchanged nodes via a WeakMap cache; `nodePropsEqual` plus per-
 * renderer `memo()` is what turns those stable refs into skipped renders.
 */
import '../nodes-base.css'
import { useEffect, useState, type CSSProperties } from 'react'
import type { NodeProps } from '@xyflow/react'
import { useStore } from '@xyflow/react'
import { useAssetStatuses } from '../NodeActionsContext'
import type { NodeState } from '../nodeData'

/**
 * Status chip. Renders nothing when the URL is missing or absent from
 * the AssetStatusContext registry (the default state — the registry is
 * empty until the server reports an asset-preupload status).
 *
 * Lives in the card header alongside the lifecycle state-chip — never
 * overlays the media body — so the ✓ never covers a piece of the image
 * the user wants to see.
 */
function AssetStatusChip({ url }: { url: string | null | undefined }): JSX.Element | null {
  const assets = useAssetStatuses()
  const entry = url !== null && url !== undefined && url !== '' ? assets.get(url) : null
  if (!entry) return null
  // Hover-only explanation via `data-tip` (CSS `:hover::after`). Custom
  // popup instead of native `title` so it appears immediately on hover and
  // can be styled to fit the dark canvas chrome. `aria-label` carries the
  // same copy for screen readers.
  if (entry.status === 'active') {
    // "Cleared as a reference" is the asset-level guarantee: the upload
    // step won't reject this URL when we hand it back as a video-gen
    // input. The generated video itself still goes through moderation
    // separately, so the chip is necessary but not sufficient — call that
    // out explicitly so users don't read ✓ as a green light on the final
    // clip.
    const tip =
      "Cleared as a video reference. The final generated video is moderated separately — passing here doesn't promise the output will pass."
    return (
      <span className="asset-status-chip asset-status-chip-active" aria-label={tip} data-tip={tip}>
        ✓
      </span>
    )
  }
  if (entry.status === 'pending') {
    const tip = 'Checking with the upload step…'
    return (
      <span className="asset-status-chip asset-status-chip-pending" aria-label={tip} data-tip={tip}>
        ⏳
      </span>
    )
  }
  if (entry.status === 'rejected') {
    // Failure is the one state we want users to spot without hovering: the
    // chip carries visible "blocked" text alongside the glyph, and the tip
    // spells out the consequence (can't reuse as a video reference) and
    // the reported reason.
    const reason =
      entry.reason !== undefined && entry.reason !== '' ? entry.reason : 'no reason given'
    const tip = `Blocked by the upload step — can't be used as a video reference. Reason: ${reason}`
    return (
      <span className="asset-status-chip asset-status-chip-rejected" aria-label={tip} data-tip={tip}>
        <span aria-hidden="true">✗</span>
        <span className="asset-status-chip-text">blocked</span>
      </span>
    )
  }
  return null
}

const STATE_LABELS: Record<NodeState, string> = {
  pending: 'pending',
  running: 'running',
  complete: 'ready',
  failed: 'failed',
}

export interface NodeHeadProps {
  /** Real cards pass `@<node-id>`; pending placeholders pass a kind word
   *  since their final id isn't minted yet. */
  label: string
  state: NodeState
  /** Override the default state label (e.g. "generating video…" instead of "running"). */
  stateLabel?: string
  /** URL keying the asset-status chip (✓/⏳/✗). Omit for nodes with no media URL. */
  assetStatusUrl?: string | null
  /** Hard suppression for nodes with no lifecycle to track (notes). */
  hideStateChip?: boolean
}

export function NodeHead({ label, state, stateLabel, assetStatusUrl, hideStateChip }: NodeHeadProps): JSX.Element {
  // Result cards (image_result / video_result) pass assetStatusUrl — the
  // chip carries enough signal on its own, so drop the redundant lifecycle
  // state-chip. Notes pass hideStateChip directly (no async lifecycle to
  // surface). Pending nodes keep the state-chip as their only indicator.
  const showStateChip = !hideStateChip && assetStatusUrl === undefined
  return (
    <div className="node-head">
      <span className="kind">{label}</span>
      <span className="node-head-right">
        {assetStatusUrl !== undefined ? <AssetStatusChip url={assetStatusUrl} /> : null}
        {showStateChip ? (
          <span className="state-chip">
            <span className="dot" />
            {stateLabel ?? STATE_LABELS[state]}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// B2: viewport culling + zoom-threshold media skip.
//
// Below ZOOM_THRESHOLD a node is small enough on-screen that the
// detailed <img>/<video> contributes no visible information but
// still costs decode, layout, and paint. Render a solid gray block
// instead. useStore's selector ensures we only re-render when the
// zoom value actually changes (not on every pan tick).
const ZOOM_THRESHOLD = 0.5

export function useZoomedOut(): boolean {
  return useStore((s) => s.transform[2] < ZOOM_THRESHOLD)
}

// True when this node is a member of a currently-selected group_frame.
// Boolean selector → re-renders only on flip, not on every store tick.
export function useIsInSelectedFrame(nodeId: string): boolean {
  return useStore((s) => {
    for (const n of s.nodes) {
      if (n.type !== 'group_frame') continue
      if (n.selected !== true) continue
      const memberIds = (n.data as { memberIds?: string[] } | undefined)?.memberIds
      if (memberIds !== undefined && memberIds.includes(nodeId)) return true
    }
    return false
  })
}

export function ZoomedOutPlaceholder(): JSX.Element {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'rgba(80, 80, 100, 0.7)',
      }}
    />
  )
}

// ImageWithFade — wraps <img> with B1's polish:
//   * loading="lazy" so off-screen images aren't fetched on mount
//   * decoding="async" so the main thread isn't stalled on big decodes
//   * fetchPriority="low" tells the browser these are nice-to-have
//   * 300ms opacity fade-in once onLoad fires — avoids paint-jank pop
// Reset the loaded flag when `src` changes so re-generated images
// also fade in.
export function ImageWithFade({
  src,
  alt,
  objectFit,
}: {
  src: string
  alt: string
  objectFit: CSSProperties['objectFit']
}): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setLoaded(false)
  }, [src])
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      onLoad={() => setLoaded(true)}
      onError={(e) => {
        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
      }}
      style={{
        width: '100%',
        height: '100%',
        objectFit,
        display: 'block',
        opacity: loaded ? 1 : 0,
        transition: 'opacity 300ms ease-in-out',
      }}
    />
  )
}

// React.memo with a narrow equality fn — only re-render when data
// ref (the meaningful payload) or selection state changes. React
// Flow internally re-evaluates several NodeProps fields per render
// (positionAbsolute, measured dims, etc) which would defeat the
// default shallowEqual; data + selected is the signal we actually
// care about, and it pairs with projection.ts's WeakMap cache to
// turn A1's stable workflow-node refs into skipped renders.
export function nodePropsEqual(prev: NodeProps, next: NodeProps): boolean {
  return prev.data === next.data && prev.selected === next.selected
}
