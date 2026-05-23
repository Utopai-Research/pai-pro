/**
 * Wraps the Available section's outer div with dnd-kit's useDroppable
 * so a reel card dragged onto it commits a "remove from reel" mutation
 * on release.
 *
 * The droppable id is `'archive'` — matched by handleDragEnd in
 * TimelinePanel.tsx (sourceInReel && overId === 'archive' →
 * applyOptimisticOrder(baseline.filter(...))).
 *
 * Visual feedback: subtle bg-tint when `isOver`, matching the legacy
 * HTML5 highlight tone (bg-neutral-900/40).
 */
import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

interface AvailableDroppableProps {
  children: ReactNode
}

export default function AvailableDroppable({
  children,
}: AvailableDroppableProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: 'archive' })
  return (
    <div
      ref={setNodeRef}
      className={
        'border-b border-neutral-900 transition-colors ' +
        (isOver ? 'bg-neutral-900/40' : '')
      }
    >
      {children}
    </div>
  )
}
