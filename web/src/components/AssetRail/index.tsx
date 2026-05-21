/**
 * AssetRail — persistent left rail showing the project's asset library.
 *
 * The 48 px icon column is always visible. The expanded panel toggles
 * via clicking a tab icon (open + switch, or close if it's already
 * the active tab), the `‹` button in the panel header, or `[`.
 * `hidden` here means "panel closed" — icons stay; owned at CanvasView
 * so the `[` listener and the rail itself share one source of truth.
 *
 * Per-project state (active tab, panel width) is read from localStorage
 * on project switch. Workflow data is passed in from CanvasView so we
 * piggyback on its existing socket subscription instead of adding a
 * third consumer.
 */
import { useCallback, useEffect, useState } from 'react'
import { mutateCanvas } from '@/lib/canvas-stub'
import { useCanvasFocus } from '@/contexts/CanvasFocusContext'
import type { Workflow } from '@/types/canvas'
import { RailExpandedPanel } from './RailExpandedPanel'
import { RailIconColumn } from './RailIconColumn'
import { useAssets, type AssetItem, type AssetKind } from './useAssets'

const PANEL_MIN_WIDTH = 220
const PANEL_MAX_WIDTH = 380
const PANEL_DEFAULT_WIDTH = 260

const lsWidthKey = (projectId: string): string =>
  `pai-pro:asset-rail:width:${projectId}`
const lsTabKey = (projectId: string): string =>
  `pai-pro:asset-rail:tab:${projectId}`

function readLs(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLs(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode etc — silent no-op */
  }
}

function readActiveTab(projectId: string | null): AssetKind {
  if (projectId === null) return 'images'
  const v = readLs(lsTabKey(projectId))
  if (v === 'images' || v === 'videos' || v === 'audios' || v === 'notes') return v
  return 'images'
}

function readWidth(projectId: string | null): number {
  if (projectId === null) return PANEL_DEFAULT_WIDTH
  const v = readLs(lsWidthKey(projectId))
  if (v === null) return PANEL_DEFAULT_WIDTH
  const n = Number(v)
  if (!Number.isFinite(n)) return PANEL_DEFAULT_WIDTH
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, n))
}

interface AssetRailProps {
  projectId: string | null
  workflow: Workflow | null
  hidden: boolean
  onToggleHidden: () => void
}

export function AssetRail({
  projectId,
  workflow,
  hidden,
  onToggleHidden,
}: AssetRailProps): JSX.Element | null {
  const groups = useAssets(workflow)
  const canvasFocus = useCanvasFocus()

  // Per-project state — re-read from localStorage when the project
  // changes so a tab/width selection on project A doesn't leak into B.
  const [activeTab, setActiveTab] = useState<AssetKind>(() =>
    readActiveTab(projectId),
  )
  const [panelWidth, setPanelWidth] = useState<number>(() => readWidth(projectId))

  useEffect(() => {
    setActiveTab(readActiveTab(projectId))
    setPanelWidth(readWidth(projectId))
  }, [projectId])

  const persistTab = useCallback(
    (next: AssetKind) => {
      setActiveTab(next)
      if (projectId !== null) writeLs(lsTabKey(projectId), next)
    },
    [projectId],
  )

  // Tab-click semantics: open the panel if it's closed; close it if
  // clicking the already-active tab; just switch tabs otherwise. The
  // icon column is always visible regardless.
  const onTabClick = useCallback(
    (next: AssetKind) => {
      if (hidden) {
        persistTab(next)
        onToggleHidden()
        return
      }
      if (next === activeTab) {
        onToggleHidden()
        return
      }
      persistTab(next)
    },
    [hidden, activeTab, persistTab, onToggleHidden],
  )

  // Drag-to-resize the expanded panel. Window-level listeners so the
  // drag survives leaving the handle's hit box. Final width persists
  // via setState callback (reads `curr` not the stale closure).
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const startX = e.clientX
      const startW = panelWidth
      const onMove = (ev: MouseEvent): void => {
        const next = Math.max(
          PANEL_MIN_WIDTH,
          Math.min(PANEL_MAX_WIDTH, startW + (ev.clientX - startX)),
        )
        setPanelWidth(next)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        if (projectId !== null) {
          setPanelWidth((curr) => {
            writeLs(lsWidthKey(projectId), String(Math.round(curr)))
            return curr
          })
        }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [panelWidth, projectId],
  )

  const onRowClick = useCallback(
    (item: AssetItem) => {
      if (item.archived) return // Restore button handles archived rows.
      if (canvasFocus === null) return
      canvasFocus(item.id)
    },
    [canvasFocus],
  )

  const onRestore = useCallback(
    async (id: string): Promise<void> => {
      if (projectId === null) return
      try {
        await mutateCanvas(projectId, 'updateNode', {
          id,
          patch: { archived: null, archived_at: null },
        })
        // The mutation broadcasts canvas-state → useWorkflow → projection
        // → React Flow on the next tick. Wait one socket round-trip
        // before centering so rf.getNode(id) actually finds the node.
        setTimeout(() => {
          canvasFocus?.(id)
        }, 200)
      } catch (err) {
        console.warn(
          `[asset-rail:${projectId}] restore ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [projectId, canvasFocus],
  )

  return (
    <aside
      className="relative flex h-full shrink-0 bg-[#0a0a0a]"
      style={{ width: hidden ? 48 : 48 + panelWidth }}
    >
      <RailIconColumn
        groups={groups}
        activeTab={activeTab}
        panelClosed={hidden}
        onTabClick={onTabClick}
      />
      {hidden ? null : (
        <>
          <div style={{ width: panelWidth }} className="flex h-full">
            <RailExpandedPanel
              kind={activeTab}
              items={groups[activeTab]}
              onRowClick={onRowClick}
              onRestore={onRestore}
              onHide={onToggleHidden}
            />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize asset rail"
            onMouseDown={onResizeMouseDown}
            className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-neutral-700/60"
          />
        </>
      )}
    </aside>
  )
}
