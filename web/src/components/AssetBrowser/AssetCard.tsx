/**
 * AssetCard — one asset in the browser's grid.
 *
 * The grid (rather than the rail panel's row list) is the reason the browser
 * is a modal: a media pool is browsed by picture, and 240px of rail could
 * never show enough of them at once. Everything a row could do survives —
 * click to focus, double-click to expand, drag an off-canvas asset to the
 * cursor, "Restore to canvas", inline audio — it just hangs off a card now.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Waypoints } from 'lucide-react'
import { useMediaExpand } from '@/contexts/MediaExpandContext'
import { cn } from '@/lib/utils'
import { DRAG_MIME } from './dnd'
import { ThumbnailBox } from './ThumbnailBox'
import type { AssetItem } from './useAssets'

/** Card thumbnail height. Also the drag-ghost centering offset (half of it). */
const THUMB = 132

interface AssetCardProps {
  item: AssetItem
  highlighted: boolean
  onClick: (item: AssetItem) => void
  onRestore: (id: string) => Promise<void> | void
  /** The modal must get out of the way before the drop lands: the canvas's
   *  drop test is `canvasHostRef.contains(target)`, and the modal covers it. */
  onDragStart: () => void
  /** Expanding opens MediaExpandOverlay, which mounts inside the canvas host
   *  the modal is covering — so the modal closes on its way there. */
  onExpanded: () => void
  /** "Used in N" → frame those N nodes on the canvas. */
  onShowUsages: (item: AssetItem) => void
}

function AssetCardImpl({
  item,
  highlighted,
  onClick,
  onRestore,
  onDragStart,
  onExpanded,
  onShowUsages,
}: AssetCardProps): JSX.Element {
  const [restoring, setRestoring] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const expand = useMediaExpand()

  useEffect(() => {
    if (!highlighted) return
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ block: 'center' })
    })
  }, [highlighted, item.archived, item.archived_at])

  const handleRestore = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (restoring) return
    setRestoring(true)
    try {
      await onRestore(item.id)
    } finally {
      setRestoring(false)
    }
  }

  const handleDoubleClick = (): void => {
    if (expand === null) return
    expand(item.id)
    onExpanded()
  }

  // setDragImage on the thumbnail so the ghost under the cursor is the
  // picture, not the whole card with its id and description trailing behind.
  const handleDragStart = (e: React.DragEvent): void => {
    const thumb = e.currentTarget.querySelector('[data-drag-image]') as HTMLElement | null
    if (thumb !== null) {
      e.dataTransfer.setDragImage(thumb, THUMB / 2, THUMB / 2)
    }
    e.dataTransfer.setData(DRAG_MIME, item.id)
    e.dataTransfer.effectAllowed = 'move'
    onDragStart()
  }

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      draggable={item.archived}
      onDragStart={handleDragStart}
      onClick={() => onClick(item)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleDoubleClick()
        } else if (e.key === ' ') {
          e.preventDefault()
          onClick(item)
        }
      }}
      title={item.prompt_excerpt || item.id}
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-[10px] border transition-colors',
        highlighted
          ? 'border-amber-300/70 bg-amber-300/10'
          : 'border-border bg-card hover:border-neutral-600',
      )}
    >
      <div className="relative flex items-center justify-center bg-background">
        <ThumbnailBox item={item} size={THUMB} fill />
        {item.used_in.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onShowUsages(item)
            }}
            title={`Used in ${item.used_in.length}: ${item.used_in.join(', ')}`}
            aria-label={`Show the ${item.used_in.length} nodes derived from ${item.id}`}
            className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-100 transition-colors hover:text-amber-300"
          >
            <Waypoints size={10} strokeWidth={1.8} aria-hidden />
            {item.used_in.length}
          </button>
        ) : null}
        {item.archived ? (
          <button
            type="button"
            onClick={handleRestore}
            disabled={restoring}
            className="absolute inset-x-0 bottom-0 bg-black/70 py-1 text-[10px] font-medium text-neutral-100 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-60"
          >
            {restoring ? 'Restoring…' : 'Restore to canvas ↩'}
          </button>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
        <span
          className={cn(
            'truncate font-mono text-[11px]',
            item.archived ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {item.id}
        </span>
        <span className="truncate text-[10.5px] text-muted-foreground">
          {item.prompt_excerpt || 'no description'}
        </span>
        {item.kind === 'audios' && !item.archived && item.audio_url !== null ? (
          // stopPropagation so scrubbing the player doesn't also focus the node.
          <audio
            src={item.audio_url}
            controls
            preload="none"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 h-7 w-full"
          />
        ) : null}
      </div>
    </div>
  )
}

export const AssetCard = memo(AssetCardImpl)
