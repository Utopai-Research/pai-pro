/**
 * RailExpandedPanel — scrollable list of asset rows for the active tab.
 *
 * Rows are pre-sorted (live first, archived second) by useAssets, with
 * an "Archived" separator between the groups when both have members.
 * EmptyState renders when the tab has zero rows. The `‹` button in
 * the header closes the panel (icons in the rail stay visible).
 */
import { Fragment } from 'react'
import { AssetRow } from './AssetRow'
import { EmptyState } from './EmptyState'
import type { AssetItem, AssetKind } from './useAssets'

interface RailExpandedPanelProps {
  kind: AssetKind
  items: AssetItem[]
  onRowClick: (item: AssetItem) => void
  onRestore: (id: string) => Promise<void> | void
  onHide: () => void
}

export function RailExpandedPanel({
  kind,
  items,
  onRowClick,
  onRestore,
  onHide,
}: RailExpandedPanelProps): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-1 flex-col bg-[#0a0a0a]">
        <Header kind={kind} live={0} archived={0} onHide={onHide} />
        <EmptyState kind={kind} />
      </div>
    )
  }

  const liveCount = items.filter((i) => !i.archived).length
  const archivedCount = items.length - liveCount
  const firstArchivedIndex = liveCount > 0 ? liveCount : -1

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[#0a0a0a]">
      <Header kind={kind} live={liveCount} archived={archivedCount} onHide={onHide} />
      <div className="scrollbar-subtle flex-1 overflow-y-auto px-2 pb-3">
        {items.map((item, idx) => (
          <Fragment key={item.id}>
            {idx === firstArchivedIndex && liveCount > 0 ? (
              <div className="my-2 flex items-center gap-2 px-2 text-[10px] uppercase tracking-wider text-neutral-600">
                <span>Archived</span>
                <span className="flex-1 border-t border-neutral-800" />
              </div>
            ) : null}
            <AssetRow item={item} onClick={onRowClick} onRestore={onRestore} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function Header({
  kind,
  live,
  archived,
  onHide,
}: {
  kind: AssetKind
  live: number
  archived: number
  onHide: () => void
}): JSX.Element {
  const TITLE: Record<AssetKind, string> = {
    images: 'Images',
    videos: 'Videos',
    audios: 'Audios',
    notes: 'Notes',
  }
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-200">
        {TITLE[kind]}
      </span>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] text-neutral-500">
          {live + archived === 0
            ? '0'
            : archived === 0
              ? `${live}`
              : `${live} · ${archived} archived`}
        </span>
        <button
          type="button"
          onClick={onHide}
          title="Close asset panel ([)"
          aria-label="Close asset panel"
          className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
        >
          <span aria-hidden className="font-mono text-sm leading-none">
            ‹
          </span>
        </button>
      </div>
    </div>
  )
}
