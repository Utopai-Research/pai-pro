/**
 * AssetRow — single row in the expanded panel.
 *
 * Live rows: single-click scrolls the canvas to the node, dblclick
 * opens MediaExpandOverlay. Faint "on canvas" pill on the right.
 * Archived rows: dblclick opens overlay; the "Put on canvas" button
 * restores at the original position; dragging the row places it at
 * the cursor. Single-click is a no-op (nothing to scroll to).
 */
import { memo, useEffect, useRef, useState } from 'react'
import { useMediaExpand } from '@/contexts/MediaExpandContext'
import type { AssetItem } from './useAssets'

/** Custom MIME for asset-rail → canvas drag. Avoids colliding with
 * UploadOverlay's file-drop listeners (those check for `Files` and
 * short-circuit on anything else). */
export const DRAG_MIME = 'application/x-pai-archived-node'

interface AssetRowProps {
  item: AssetItem
  highlighted: boolean
  onClick: (item: AssetItem) => void
  onRestore: (id: string) => Promise<void> | void
}

function GlyphForKind({ kind }: { kind: AssetItem['kind'] }): JSX.Element {
  if (kind === 'videos') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="m22 8-6 4 6 4Z" />
      </svg>
    )
  }
  if (kind === 'audios') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 5 6 9H2v6h4l5 4Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M19 5a9 9 0 0 1 0 14" />
      </svg>
    )
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  )
}

function ThumbnailBox({ item }: { item: AssetItem }): JSX.Element {
  // Image — render the photo as-is (no grayscale even when archived;
  // the Restore button + dimmed metadata text are already enough
  // signal that the row is archived).
  if (item.kind === 'images' && item.thumbnail_url !== null) {
    return (
      <img
        src={item.thumbnail_url}
        alt=""
        loading="lazy"
        draggable={false}
        data-drag-image="true"
        className="h-14 w-14 shrink-0 rounded-md object-cover"
      />
    )
  }
  // Video — `<video preload="metadata">` shows the first frame as a
  // poster, mimicking a real thumbnail. `#t=0.1` nudges the seek
  // position so we get a slightly more interesting frame than the
  // literal frame 0 (often black).
  if (item.kind === 'videos' && item.video_url !== null) {
    return (
      <video
        src={`${item.video_url}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        data-drag-image="true"
        className="h-14 w-14 shrink-0 rounded-md bg-neutral-900 object-cover"
        aria-hidden
      />
    )
  }
  // Audio / Notes — kind-specific glyph fallback.
  return (
    <div
      aria-hidden
      data-drag-image="true"
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-neutral-400"
    >
      <GlyphForKind kind={item.kind} />
    </div>
  )
}

function AudioInline({ url }: { url: string }): JSX.Element {
  // Native HTML5 audio control. preload=none so we don't burn bandwidth
  // until the user clicks play. stopPropagation on the wrapper so
  // clicking the player doesn't trigger the row's scroll-to-node.
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="mt-1"
    >
      <audio src={url} controls preload="none" className="h-8 w-full" />
    </div>
  )
}

function AssetRowImpl({
  item,
  highlighted,
  onClick,
  onRestore,
}: AssetRowProps): JSX.Element {
  const [restoring, setRestoring] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const expand = useMediaExpand()

  useEffect(() => {
    if (!highlighted) return
    requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView({ block: 'center' })
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
    if (expand !== null) expand(item.id)
  }

  // setDragImage on the 56×56 thumbnail so the ghost is just the
  // thumbnail under the cursor — the default ghost is the whole row
  // and would visually trail the id + description text.
  const handleDragStart = (e: React.DragEvent): void => {
    const thumb = e.currentTarget.querySelector(
      '[data-drag-image]',
    ) as HTMLElement | null
    if (thumb !== null) {
      e.dataTransfer.setDragImage(thumb, 28, 28)
    }
    e.dataTransfer.setData(DRAG_MIME, item.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div
      ref={rowRef}
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
      title="Double-click to expand"
      className={
        'group flex cursor-pointer gap-2 rounded-md border p-2 transition-colors ' +
        (highlighted
          ? 'border-amber-300/70 bg-amber-300/10 shadow-[0_0_0_1px_rgba(252,211,77,0.18)]'
          : 'border-transparent hover:bg-neutral-900')
      }
    >
      <ThumbnailBox item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={'truncate text-xs font-mono ' + (item.archived ? 'text-neutral-500' : 'text-neutral-200')}>
          {item.id}
        </span>
        <p
          className={'line-clamp-2 text-xs ' + (item.archived ? 'text-neutral-600' : 'text-neutral-400')}
          title={item.prompt_excerpt || undefined}
        >
          {item.prompt_excerpt || (
            <span className="italic text-neutral-600">no description</span>
          )}
        </p>
        {item.kind === 'audios' && item.archived === false && item.audio_url !== null ? (
          <AudioInline url={item.audio_url} />
        ) : null}
        <div className="mt-1 flex items-center justify-between gap-2">
          {item.archived ? (
            <button
              type="button"
              onClick={handleRestore}
              disabled={restoring}
              className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-200 transition-colors hover:bg-neutral-700 disabled:opacity-50"
            >
              {restoring ? 'Placing…' : 'Put on canvas'}
            </button>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-neutral-600">
              on canvas
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export const AssetRow = memo(AssetRowImpl)
