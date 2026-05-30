/**
 * NodeActionsContext — callbacks the canvas's custom node renderers
 * may invoke (expand a media item to the canvas overlay, save inline
 * note edits, etc.). Callbacks may be omitted; consumers treat a
 * missing handler as a noop.
 *
 * Reel assign/clear are NOT in this context — both live in the
 * TimelinePanel (drag from Available to assign, Remove button to
 * clear). The canvas video_result node renders a read-only `#N`
 * indicator when assigned, without any click handler.
 */
import { createContext, useContext, type ReactNode } from 'react'

export interface NodeActionsContextValue {
  /**
   * Invoked when the user opens an image_result or video_result in
   * the MediaExpandOverlay — either via the corner ⤢ button or by
   * double-clicking the media body.
   */
  onExpandMedia?: (node: { id: string; [key: string]: unknown }) => void
  /**
   * Invoked when the user saves inline edits on a note from the
   * MediaExpandOverlay. Routes through the canvas mutator's
   * `updateNode` op via `POST /projects/:id/mutate`. Resolves on
   * success; rejects with an Error carrying the mutator's failure
   * class + message on validation / IO failure.
   */
  onSaveNote?: (
    nodeId: string,
    patch: { label?: string; body?: string },
  ) => Promise<void>
  /**
   * Edit a pending draft. The viewer's PATCH handler updates the
   * sidecar + captured argv and recomputes cost when a costed
   * dimension (image_size / resolution / duration) is in the patch.
   * Rejects on non-2xx.
   */
  onPatchDraft?: (
    jobId: string,
    patch: {
      prompt?: string
      aspect_ratio?: string
      image_size?: string
      resolution?: string
      duration?: number
      text?: string
    },
  ) => Promise<void>
  /**
   * Fire a staged draft. The viewer spawns the matching generate_*.js
   * CLI detached with the captured argv + `--existing-job-id`; the
   * draft sidecar flips to stage:"running" via the CLI's writePending,
   * then unlinks once the real result lands.
   */
  onFireDraft?: (jobId: string) => Promise<void>
  /** Cancel a draft and resolve its result sidecar. Idempotent server-side. */
  onDiscardDraft?: (jobId: string) => Promise<void>
  /** Hide a settled failed generation card. */
  onDismissFailedGeneration?: (jobId: string) => void
}

// Module-level empty value so consumers reading from outside a provider
// always see the same reference. Mirrors AssetStatusContext's
// EMPTY_ASSET_STATUSES.
const EMPTY_NODE_ACTIONS: NodeActionsContextValue = {}

const NodeActionsContext = createContext<NodeActionsContextValue>(EMPTY_NODE_ACTIONS)

export function NodeActionsProvider({
  value,
  children,
}: {
  value: NodeActionsContextValue
  children: ReactNode
}): JSX.Element {
  return (
    <NodeActionsContext.Provider value={value}>
      {children}
    </NodeActionsContext.Provider>
  )
}

export function useNodeActions(): NodeActionsContextValue {
  return useContext(NodeActionsContext)
}

/**
 * Asset-preupload status registry, keyed by media URL. Populated by the
 * `video-generation-assets` preupload step on the server. ImageResultNode reads this
 * to render an active/pending/rejected status chip on top of the image
 * and to tint a character's voice button red on rejection.
 *
 * Default value is an empty Map: until the server has reported anything,
 * no chip appears and no voice button picks up the rejected style.
 */
export type AssetStatusEntry = {
  status: 'active' | 'pending' | 'rejected'
  reason?: string
}

const EMPTY_ASSET_STATUSES: ReadonlyMap<string, AssetStatusEntry> = new Map()

const AssetStatusContext = createContext<ReadonlyMap<string, AssetStatusEntry>>(
  EMPTY_ASSET_STATUSES,
)

export function AssetStatusProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, AssetStatusEntry>
  children: ReactNode
}): JSX.Element {
  return (
    <AssetStatusContext.Provider value={value}>
      {children}
    </AssetStatusContext.Provider>
  )
}

export function useAssetStatuses(): ReadonlyMap<string, AssetStatusEntry> {
  return useContext(AssetStatusContext)
}
