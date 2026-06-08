/**
 * Always-mounted droppable wrapping the reel area (both empty-state
 * and SortableContext-of-cards states). Drop on this droppable means
 * "append to end of current reel" — for an empty reel that's position
 * 1; for a non-empty reel of N cards that's position N+1.
 *
 * The droppable stays mounted for non-empty reels so trailing empty
 * row space remains an append target.
 *
 * Within the wrapper, the SortableClips' own droppables take precedence
 * via pointerWithin — so a cursor on a specific card still resolves to
 * that card's slot (not 'reel-area'). The wrapper only fires when
 * cursor is in empty row space such as the area past the last card.
 */
import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

interface ReelAreaDroppableProps {
  /** Empty-state hint or SortableContext with cards. */
  children: ReactNode
  /** True when neither truth-state reel cards nor preview cards exist. */
  showEmptyHint: boolean
}

export default function ReelAreaDroppable({
  children,
  showEmptyHint,
}: ReelAreaDroppableProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: 'reel-area' })
  if (showEmptyHint) {
    return (
      <div
        ref={setNodeRef}
        className={
          'flex h-20 items-center justify-center rounded-md border border-dashed px-4 text-center text-[11px] uppercase tracking-wide transition-colors ' +
          (isOver
            ? 'border-neutral-300 bg-neutral-900/60 text-neutral-200'
            : 'border-neutral-800 text-neutral-600')
        }
      >
        Drag a clip here to start the reel
      </div>
    )
  }
  // Non-empty reel: wrapper is a transparent passthrough. The isOver
  // signal isn't visually surfaced for the non-empty case — the
  // cursor's interaction with specific cards is communicated by the
  // SortableContext's reflow, and the "append at end" intent is
  // implicit from cursor position past the last card.
  return (
    <div ref={setNodeRef}>
      {children}
    </div>
  )
}
