/** Drop target for moving reel clips back into Available. */
import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

interface AvailableDroppableProps {
  children: ReactNode
}

export default function AvailableDroppable({
  children,
}: AvailableDroppableProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: 'available-drop' })
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
