/**
 * Always-mounted droppable wrapping the reel area (both empty-state
 * and SortableContext-of-cards states). Drop on this droppable means
 * "append to end of current reel" — for an empty reel that's position
 * 1; for a non-empty reel of N cards that's position N+1.
 *
 * Why always-mounted (vs the prior ReelEmptyDroppable which only
 * rendered when reel was empty): with the conditional approach, the
 * "append at end" case for a non-empty reel had no drop target — the
 * trailing empty space past the last card had no useDroppable
 * registered. The cursor's sticky-over (collision killer C) would
 * resolve to the last reel card, which caused drops past the last
 * card to insert BEFORE the last card (splice at index N-1) instead
 * of appending after it (splice at index N). Always-mounted droppable
 * fixes this by giving the trailing empty space a real over target.
 *
 * Within the wrapper, the SortableClips' own droppables take precedence
 * via pointerWithin — so a cursor on a specific card still resolves to
 * that card's slot (not 'reel-area'). The wrapper only fires when
 * cursor is in empty row space such as the area past the last card.
 */
import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

interface ReelAreaDroppableProps {
  /** Reel content — empty-state hint OR SortableContext with cards.
   *  The wrapper toggles between two visual states based on
   *  `showEmptyHint`. */
  children: ReactNode
  /** True when there are no reel cards to render (no truth-state reel
   *  AND no cross-region preview). Drives the dashed-border "Drag a
   *  clip here to start the reel" placeholder visual; false when reel
   *  has cards (the wrapper is transparent). */
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
