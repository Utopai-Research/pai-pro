/**
 * NodePillToolbar — the floating action pill for the current selection.
 *
 * One pill serves BOTH selection sizes, so there is never more than one on
 * screen:
 *
 *   single select → pill above the node: Download · Expand │ Refer · Group ·
 *     Delete. A divider splits the read/media actions from the selection
 *     actions; Delete is last and reddens on hover. Group is shown but
 *     disabled, since grouping needs 2+ nodes.
 *   multi select  → the same pill anchored to the selection's union bbox:
 *     Refer · Group · Delete. Download and Expand are single-node actions, so
 *     they drop out.
 *
 * Mutual exclusion is structural rather than two components suppressing each
 * other: a SINGLE <NodeToolbar> takes `nodeId = one-id` at n===1 and
 * `nodeId = [all ids]` at n>=2 (React Flow positions the latter at the union
 * bbox), and the button set switches with the count. The count is derived
 * once, so the two shapes can never coexist.
 *
 * Positioning comes from React Flow, not hand-computed screen coords: the
 * toolbar is portalled into the renderer and stays screen-space, so it neither
 * scales with zoom nor drifts on pan.
 *
 * Every action mirrors a handler that already exists — nothing here spends or
 * mutates on its own:
 *   Download → the asset's URL (a note downloads the .md the viewer mirrors)
 *   Expand   → onExpand(nodeId), the same overlay a dblclick opens
 *   Refer    → composer.insertAtCursor
 *   Group    → onGroup → GroupCreateModal
 *   Delete   → onArchive → the archive flow, which is undoable (Cmd+Z)
 *
 * `isVisible` is passed explicitly: the default miscounts selections that
 * include a group frame, and we want usePresence to drive the exit fade.
 */
import './node-pill-toolbar.css'
import { useRef, type CSSProperties } from 'react'
import {
  NodeToolbar,
  Position,
  useNodes,
  type Node as RFNode,
} from '@xyflow/react'
import { AtSign, Download, Group as GroupIcon, Maximize2, Trash2 } from 'lucide-react'
import { useChatComposer } from '@/contexts/ChatComposerContext'
import { usePresence } from '@/lib/usePresence'
import { cn } from '@/lib/utils'
import { VIEWER_URL } from '@/lib/socket'
import { downloadHref } from './nodeData'

/* The conic hover glow. These rgba() gradients must be inline styles —
   arbitrary rgba inside a Tailwind utility can render transparent. */
const SWEEP_STYLE: CSSProperties = {
  background:
    'conic-gradient(rgb(93,93,93) 0deg, rgba(106,106,106,0.1) 70deg, rgb(144,144,144) 180deg, rgba(144,144,144,0.1) 290deg, rgb(93,93,93) 360deg)',
  transform: 'scale(1.1, 0.7)',
}
const PLATE_STYLE: CSSProperties = {
  background:
    'radial-gradient(200% 140% at 50% 40.25%, rgb(26,26,26) 16%, rgb(101,103,102) 85%)',
}

function HoverGlow(): JSX.Element {
  return (
    <span className="pill-glow" aria-hidden>
      <span className="pill-glow-sweep">
        <span style={SWEEP_STYLE} />
      </span>
      <span className="pill-glow-plate" style={PLATE_STYLE} />
    </span>
  )
}

/** Where the viewer mirrors a note's markdown. Null without a project, which
 *  hides the Download button rather than offering a dead link. */
function noteDownloadUrl(projectId: string | null, nodeId: string): string | null {
  if (projectId === null || projectId === '') return null
  return `${VIEWER_URL}/projects/${encodeURIComponent(projectId)}/assets/notes/${encodeURIComponent(nodeId)}.md`
}

interface PillSnap {
  n: number
  anchorId: string | string[]
  selectedIds: string[]
  referTokens: string[]
  canGroup: boolean
  /** single-select only */
  singleId: string | null
  url: string | null
  canExpand: boolean
}

export interface NodePillToolbarProps {
  onGroup: (selectedIds: string[]) => void
  onArchive: (selectedIds: string[]) => void
  /** Opens the MediaExpandOverlay for one node — the same path a dblclick
   *  on the card takes. */
  onExpand: (nodeId: string) => void
  projectId: string | null
}

export function NodePillToolbar({
  onGroup,
  onArchive,
  onExpand,
  projectId,
}: NodePillToolbarProps): JSX.Element | null {
  const nodes = useNodes()
  const composer = useChatComposer()

  // Pending placeholders and group frames aren't actionable canvas nodes
  // here — same exclusions the pill's predecessor made.
  const selected: RFNode[] = nodes.filter(
    (n) =>
      n.selected === true &&
      n.type !== 'group_frame' &&
      n.type !== 'pending_generation',
  )
  const n = selected.length
  const { mounted, closing } = usePresence(n >= 1)
  // Snapshot the last non-empty selection so the pill can play its exit
  // animation after the selection is already gone.
  const snapRef = useRef<PillSnap | null>(null)

  if (n >= 1) {
    const single = n === 1 ? selected[0] : null
    const singleData = single?.data as
      | { image_url?: string; video_url?: string; audio_url?: string }
      | undefined
    snapRef.current = {
      n,
      anchorId:
        n === 1 && single !== null ? single.id : selected.map((node) => node.id),
      selectedIds: selected.map((node) => node.id),
      referTokens: selected.map((node) => {
        const data = node.data as { shortId?: string } | undefined
        return `@${data?.shortId ?? node.id}`
      }),
      canGroup: n >= 2,
      singleId: single?.id ?? null,
      url:
        single === null
          ? null
          : // A note carries no media URL — its bytes are the .md the viewer
            // mirrors under assets/notes/.
            single.type === 'note'
            ? noteDownloadUrl(projectId, single.id)
            : (singleData?.image_url ??
              singleData?.video_url ??
              singleData?.audio_url ??
              null),
      canExpand: single !== null && single.type !== 'note',
    }
  }

  const snap = snapRef.current
  if (!mounted || snap === null) return null

  const referDisabled = composer === null || snap.referTokens.length === 0
  const onRefer = (): void => {
    if (composer === null || snap.referTokens.length === 0) return
    composer.insertAtCursor(snap.referTokens.join('  ') + ' ')
  }
  const hasMediaActions =
    snap.n === 1 && ((snap.url !== null && snap.url !== '') || snap.canExpand)

  return (
    <NodeToolbar
      nodeId={snap.anchorId}
      position={Position.Top}
      // Clears the counter-scaled label that also sits above the card (both
      // are screen-space; the label is a constant ~24px tall).
      offset={30}
      align="center"
      isVisible={mounted}
    >
      <div
        className={cn('node-pill-toolbar pill-presence', closing && 'pill-closing')}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Media actions — single select only */}
        {snap.n === 1 && snap.url !== null && snap.url !== '' ? (
          <a
            className="pill-btn"
            href={downloadHref(snap.url)}
            download
            title="Download"
            aria-label="Download"
            onClick={(e) => e.stopPropagation()}
          >
            <HoverGlow />
            <Download size={17} strokeWidth={1.75} />
          </a>
        ) : null}
        {snap.n === 1 && snap.canExpand && snap.singleId !== null ? (
          <button
            type="button"
            className="pill-btn"
            title="Expand"
            aria-label="Expand"
            onClick={() => {
              if (snap.singleId !== null) onExpand(snap.singleId)
            }}
          >
            <HoverGlow />
            <Maximize2 size={17} strokeWidth={1.75} />
          </button>
        ) : null}
        {hasMediaActions ? <span className="pill-sep" /> : null}

        {/* Selection actions */}
        <button
          type="button"
          className="pill-btn"
          title={
            referDisabled
              ? 'Chat composer not ready'
              : 'Insert @-mentions for the selection into chat'
          }
          aria-label="Refer in chat"
          disabled={referDisabled}
          onClick={onRefer}
        >
          <HoverGlow />
          <AtSign size={17} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="pill-btn"
          title={snap.canGroup ? 'Group selected nodes (⌘G)' : 'Select 2+ nodes to group'}
          aria-label="Group selected nodes"
          disabled={!snap.canGroup}
          onClick={() => onGroup(snap.selectedIds)}
        >
          <HoverGlow />
          <GroupIcon size={17} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="pill-btn pill-btn-danger"
          title="Archive selected (Del) — undoable with ⌘Z"
          aria-label="Archive selected"
          onClick={() => onArchive(snap.selectedIds)}
        >
          <HoverGlow />
          <Trash2 size={17} strokeWidth={1.75} />
        </button>
      </div>
    </NodeToolbar>
  )
}
