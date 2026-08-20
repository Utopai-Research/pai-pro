/**
 * AssetBrowser — the project's media pool as a full grid, in a flyout docked
 * beside the CanvasRail.
 *
 * A flyout, not a modal: no scrim, no focus trap, the canvas stays live behind
 * it. Two reasons, both load-bearing:
 *
 *   1. NOT A PORTAL. shadcn's Dialog portals to <body>, outside `.canvas-host`,
 *      where our --ink-N / --bg-N custom properties don't resolve — the surface
 *      would come out near-white. This renders in place and carries its own
 *      `.canvas-host` class, like every other canvas-adjacent surface.
 *   2. IT MUST GET OUT OF THE WAY OF A DRAG. The canvas decides whether a drop
 *      is its own with `canvasHostRef.contains(e.target)`. An open panel covers
 *      part of the canvas, so dragging an asset "onto the canvas" could land on
 *      the panel and be ignored. Every card's `onDragStart` closes it; the drag
 *      survives (the browser owns the DnD session) and the drop lands on canvas.
 *
 * THREE THINGS IT ADDS OVER THE LIST, and why:
 *
 *   1. ROLE SECTIONS. `data.subtype` is the asset's production role
 *      (character / location / shot …) and we have always had it and never
 *      shown it. Grouping by file kind alone is what makes an asset list read
 *      as a file drawer; sectioning the live grid by role is what makes it
 *      read as a gallery. Sections appear only when a kind actually has more
 *      than one role — videos carry no subtype at all, so their grid is flat.
 *   2. SEARCH. Over id, label and prompt. A 70-node project cannot be scanned.
 *   3. SORT. Recent (default) / Uses / Name. "Uses" ranks by the derived-edge
 *      count — the question a media pool gets asked most ("what is this
 *      character actually IN?").
 *
 * Search and sort run INSIDE the sections rather than flattening them, so a
 * search that spans roles still tells you which hits are locations and which
 * are references.
 *
 * 🔴 Four gestures CLOSE the panel, all for one reason: the thing they act on
 * is the canvas, and this covers part of it. Focusing a node (or the "used in
 * N" set) would move a viewport the user cannot see; expanding mounts
 * MediaExpandOverlay inside the canvas host underneath; and the drag is
 * invariant 2 above.
 */
import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { mutateCanvas } from '@/lib/canvas-stub'
import { useCanvasFocus } from '@/contexts/CanvasFocusContext'
import type { Workflow } from '@/types/canvas'
import { AssetCard } from './AssetCard'
import { EmptyState } from './EmptyState'
import {
  SORT_MODES,
  matchesQuery,
  sectionBySubtype,
  sortItems,
  type SortMode,
} from './browserQuery'
import { KIND_LABELS, KIND_ORDER } from './kindIcons'
import { useAssets, type AssetItem, type AssetKind } from './useAssets'

/** Ask the browser to show a particular asset — the archive flow uses it to
 *  point at what just left the canvas. */
export interface AssetRevealRequest {
  id: string
  kind: AssetKind
}

interface AssetBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  workflow: Workflow | null
  /** Non-null → switch to that kind and flash the card. */
  reveal: AssetRevealRequest | null
}

const lsKindKey = (projectId: string): string => `pai-pro:asset-rail:tab:${projectId}`

function readKind(projectId: string | null): AssetKind {
  if (projectId === null) return 'images'
  try {
    const v = window.localStorage.getItem(lsKindKey(projectId))
    if (v === 'images' || v === 'videos' || v === 'audios' || v === 'notes') return v
  } catch {
    /* private mode etc — fall through to the default */
  }
  return 'images'
}

/** How long a revealed card stays flashed. */
const HIGHLIGHT_MS = 3200

export function AssetBrowser({
  open,
  onOpenChange,
  projectId,
  workflow,
  reveal,
}: AssetBrowserProps): JSX.Element | null {
  const groups = useAssets(workflow)
  const canvasFocus = useCanvasFocus()
  const [kind, setKindState] = useState<AssetKind>(() => readKind(projectId))
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // Per-project, like the rail's tab was: a kind chosen in project A must not
  // follow you into project B.
  const setKind = (next: AssetKind): void => {
    setKindState(next)
    if (projectId === null) return
    try {
      window.localStorage.setItem(lsKindKey(projectId), next)
    } catch {
      /* private mode etc — silent no-op */
    }
  }

  useEffect(() => {
    setKindState(readKind(projectId))
    setQuery('')
  }, [projectId])

  // A stale search would read as an empty project, so it clears on each open.
  useEffect(() => {
    if (!open) return
    setQuery('')
  }, [open])

  useEffect(() => {
    if (reveal === null) return
    setKindState(reveal.kind)
    setHighlightedId(reveal.id)
    const timer = window.setTimeout(() => {
      setHighlightedId((curr) => (curr === reveal.id ? null : curr))
    }, HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [reveal])

  const onFocus = (ids: string | string[]): void => {
    canvasFocus?.(ids)
  }

  const onRestore = async (id: string): Promise<void> => {
    if (projectId === null) return
    try {
      await mutateCanvas(projectId, 'updateNode', {
        id,
        patch: { archived: null, archived_at: null },
      })
      // The mutation broadcasts canvas-state → useWorkflow → projection → React
      // Flow on the next tick. Wait one socket round-trip before centering so
      // rf.getNode(id) actually finds the node.
      setTimeout(() => {
        canvasFocus?.(id)
      }, 200)
    } catch (err) {
      console.warn(
        `[asset-browser:${projectId ?? '-'}] restore ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const items = groups[kind]
  const { live, archived, sections, hits } = useMemo(() => {
    const matched = items.filter((i) => matchesQuery(i, query))
    const liveItems = sortItems(
      matched.filter((i) => !i.archived),
      sort,
    )
    const archivedItems = sortItems(
      matched.filter((i) => i.archived),
      sort,
    )
    return {
      live: liveItems,
      archived: archivedItems,
      // Sections describe the live grid only: what is off the canvas is a bin,
      // and a bin sorted by production role would suggest it is still filed.
      sections: sectionBySubtype(liveItems),
      hits: matched.length,
    }
  }, [items, query, sort])

  const close = (): void => onOpenChange(false)
  const handleClick = (item: AssetItem): void => {
    if (item.archived) return // Restore handles archived cards.
    onFocus(item.id)
    close()
  }
  const handleShowUsages = (item: AssetItem): void => {
    if (item.used_in.length === 0) return
    onFocus(item.used_in)
    close()
  }

  const cardProps = (item: AssetItem): React.ComponentProps<typeof AssetCard> => ({
    item,
    highlighted: item.id === highlightedId,
    onClick: handleClick,
    onRestore,
    onDragStart: close,
    onExpanded: close,
    onShowUsages: handleShowUsages,
  })

  const searching = query.trim() !== ''

  // Esc closes — same courtesy a modal gives; the flyout must never be a trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null

  return (
    // `canvas-host` on the panel root: it mounts outside CanvasPage's host, and
    // without it every --ink-N / --bg-N below resolves to nothing.
    // Pointer events stop here — the panel floats over the canvas, and a
    // double-click bubbling through would reach the pane's own handler.
    <div
      role="dialog"
      aria-label="Asset browser"
      className="canvas-host absolute left-16 top-3 z-20 flex max-h-[calc(100%-5rem)] w-[520px] max-w-[calc(100%-9rem)] flex-col overflow-hidden rounded-[12px] border border-[var(--line-2)] bg-[var(--bg-1)] shadow-[0_18px_50px_oklch(0_0_0_/_0.55)]"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line-1)] px-3.5 py-2.5">
        <div className="flex items-center gap-1">
            {KIND_ORDER.map((k) => {
              const active = k === kind
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={active}
                  className={
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ' +
                    (active
                      ? 'bg-[var(--bg-2)] text-[var(--ink-0)]'
                      : 'text-[var(--ink-3)] hover:bg-[var(--bg-2)] hover:text-[var(--ink-1)]')
                  }
                >
                  {KIND_LABELS[k]}
                  <span className="font-mono text-[10px] tabular-nums opacity-70">
                    {groups.counts[k]}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="relative">
              <Search
                size={13}
                strokeWidth={1.8}
                aria-hidden
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-3)]"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search id, name, prompt…"
                aria-label="Search assets"
                className="h-7 w-44 rounded-md border border-[var(--line-1)] bg-[var(--bg-0)] pl-7 pr-6 text-xs text-[var(--ink-0)] outline-none placeholder:text-[var(--ink-4)] focus-visible:border-[var(--line-2)]"
              />
              {searching ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--ink-3)] hover:text-[var(--ink-0)]"
                >
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-0.5 rounded-md border border-[var(--line-1)] p-0.5">
              {SORT_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSort(m.id)}
                  aria-pressed={sort === m.id}
                  title={
                    m.id === 'uses' ? 'Sort by how many nodes were derived from it' : undefined
                  }
                  className={
                    'rounded px-2 py-0.5 text-[11px] transition-colors ' +
                    (sort === m.id
                      ? 'bg-[var(--bg-2)] text-[var(--ink-0)]'
                      : 'text-[var(--ink-3)] hover:text-[var(--ink-1)]')
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close asset browser (Esc)"
              className="flex size-7 items-center justify-center rounded-lg text-[var(--ink-3)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--ink-0)]"
            >
              <X size={14} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
          {items.length === 0 ? (
            <EmptyState kind={kind} />
          ) : hits === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-medium text-[var(--ink-0)]">No match</p>
              <p className="text-xs text-[var(--ink-3)]">
                Nothing in {KIND_LABELS[kind]} matches “{query.trim()}”.
              </p>
            </div>
          ) : (
            <>
              {sections.length > 0 ? (
                sections.map((section) => (
                  <div key={section.key} className="mb-5">
                    <SectionHead label={section.label} count={section.items.length} />
                    <Grid>
                      {section.items.map((item) => (
                        <AssetCard key={item.id} {...cardProps(item)} />
                      ))}
                    </Grid>
                  </div>
                ))
              ) : (
                <Grid>
                  {live.map((item) => (
                    <AssetCard key={item.id} {...cardProps(item)} />
                  ))}
                </Grid>
              )}
              {archived.length > 0 ? (
                <>
                  <div className="my-4">
                    <SectionHead label="Archived" count={archived.length} />
                  </div>
                  <Grid>
                    {archived.map((item) => (
                      <AssetCard key={item.id} {...cardProps(item)} />
                    ))}
                  </Grid>
                </>
              ) : null}
            </>
          )}
      </div>
    </div>
  )
}

/** auto-fill, not auto-fit: a group with one card keeps a card-sized card
 *  instead of stretching it across the whole panel. 132px cells rather than the
 *  modal's 148 — the flyout is 520px wide and this keeps it at three columns. */
function Grid({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 px-1.5 pb-1">
      {children}
    </div>
  )
}

function SectionHead({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--ink-3)]">
        {label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-[var(--ink-3)]">{count}</span>
      <span className="h-px flex-1 bg-[var(--line-1)]" />
    </div>
  )
}
