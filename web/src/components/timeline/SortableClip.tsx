/**
 * Per-clip sortable wrapper for the reel. Adapted from pai-next's
 * handover §10.3 to pai-pro's duration-scaled row + VideoResultNode
 * shape.
 *
 * Responsibilities:
 *   - Register the clip with dnd-kit via useSortable so the parent
 *     SortableContext can reorder it.
 *   - Apply the sortable transform + transition that animates neighbor
 *     slide when another clip is being dragged.
 *   - When THIS clip is being dragged (isDragging), swap its visible
 *     content for <StripedPlaceholder> so the source slot reads as
 *     "the clip is travelling; it'll land back here on cancel" — the
 *     Premiere/CapCut convention.
 *
 * The cursor-following ghost is rendered separately in <DragOverlay>
 * (see ClipGhostBody in TimelinePanel.tsx) — this wrapper only owns
 * the source-slot rendering.
 *
 * The post-drop "transition trust" rule (handover §5.4): pass
 * useSortable's returned `transition` string verbatim. Do NOT replace
 * it with your own duration string conditional on isDragging — dnd-kit
 * returns 'transform 0ms linear' on the post-drop frame as a sentinel
 * to disable animation, and overriding it produces a visible "twitch"
 * where the dropped clip overshoots its destination and eases back.
 */
import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import StripedPlaceholder from './StripedPlaceholder'

interface SortableClipProps {
  id: string
  /** Duration-scaled timeline width for this clip. */
  widthPx: number
  /** The live card content rendered when this clip is NOT being dragged. */
  children: ReactNode
}

export default function SortableClip({
  id,
  widthPx,
  children,
}: SortableClipProps): JSX.Element {
  const {
    setNodeRef,
    listeners,
    attributes,
    isDragging,
    transform,
    transition,
  } = useSortable({
    id,
    // Suppress dnd-kit's FLIP layout animation when the items array
    // changes externally (e.g. a fresh canvas-state arrives mid-drag).
    // Without this, those external changes visibly slide.
    animateLayoutChanges: () => false,
    transition: { duration: 150, easing: 'ease-out' },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="relative h-full outline-none focus:outline-none"
      style={{
        width: `${widthPx}px`,
        minWidth: `${widthPx}px`,
        flexShrink: 0,
        transform: CSS.Translate.toString(transform),
        // Pass dnd-kit's transition verbatim — see file-level comment.
        transition: transition ?? undefined,
        // Hide the dragged clip's own slot visual (the placeholder fills
        // the same box) without collapsing layout — the wrapper's box
        // must keep its sortable-slot dimensions for neighbor reflow math.
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      {isDragging ? (
        <div className="relative h-full w-full">
          <StripedPlaceholder />
        </div>
      ) : (
        children
      )}
    </div>
  )
}
