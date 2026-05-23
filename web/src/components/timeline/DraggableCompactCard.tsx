/**
 * Per-Available-card draggable wrapper. Mirrors SortableClip's role
 * for reel cards: registers the clip with dnd-kit so the cross-region
 * drag from Available → reel slot works through the same DndContext.
 *
 * The inner CompactCard is rendered with `draggable={false}` (its
 * HTML5 onDragStart prop is undefined when wrapped here) so the
 * browser-level drag system doesn't steal pointer events from
 * dnd-kit's MouseSensor — same trick as SortableClip+ReelCard.
 *
 * Why useDraggable not useSortable:
 *   The reel uses SortableContext + useSortable for reorder math.
 *   Available is a flat draggable pocket — not sorted, just picked
 *   from. useDraggable is the right primitive: it registers a drag
 *   source without enrolling in a sortable list. During cross-region
 *   preview the source's id appears in the reel's SortableContext
 *   items array, at which point dnd-kit transitions it to a sortable
 *   for the duration of that drag (handover §8.7).
 */
import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'

interface DraggableCompactCardProps {
  id: string
  /** Children render the actual CompactCard chrome. The wrapper only
   *  owns drag mechanics + the fade-on-drag opacity. */
  children: ReactNode
}

export default function DraggableCompactCard({
  id,
  children,
}: DraggableCompactCardProps): JSX.Element {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="outline-none focus:outline-none"
      style={{
        // Fade the source while it's mid-drag — the cursor-following
        // ghost (ClipGhostBody in DragOverlay) is the user's anchor;
        // a faded source clarifies "this clip is travelling."
        opacity: isDragging ? 0.4 : 1,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      {children}
    </div>
  )
}
