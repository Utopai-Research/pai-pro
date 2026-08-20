/**
 * CanvasRail — the canvas's toolbar: a pill floating on the left edge.
 *
 * Two banks, top to bottom, separated by a divider:
 *
 *   edit     — Undo / Redo, the same acts as ⌘Z and ⇧⌘Z.
 *   navigate — the asset browser's door.
 *
 * LEFT-CENTRE specifically: the bottom-left corner is spoken for (MiniMap +
 * ZoomBar), bottom-centre belongs to the save pill and the undo toast, and the
 * top strip is the project header. The rail FLOATS over the canvas — it is a
 * toolbar, not a docked sidebar (the 44px docked column it replaced cost the
 * canvas that width at all times, to show four counts).
 *
 * It mounts in CanvasView, OUTSIDE CanvasPage's host ref, like the flyout — so
 * it never swallows a drop (see AssetBrowser's header). Two consequences:
 *
 *   - It carries its own `canvas-host` class. The --ink-N / --bg-N custom
 *     properties are scoped to that class, and without it every colour here
 *     resolves to nothing.
 *   - Pointer events stop at the pill. It sits over the canvas, and a
 *     double-click that bubbled through would reach the pane's own handler.
 *
 * No ⊕ Add button: this repo has no spawn menu to open, and a button that does
 * nothing is worse than a missing one. Nodes arrive from the agent, from a
 * file drop, or restored out of the browser.
 */
import { FolderOpen, Redo2, Undo2 } from 'lucide-react'

const BTN =
  'flex size-[30px] items-center justify-center rounded-[8px] text-[var(--ink-2)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--ink-0)]'

export function CanvasRail({
  onUndo,
  onRedo,
  assetsOpen,
  onToggleAssets,
}: {
  /** Same act as ⌘Z — a no-op when the stack is empty. */
  onUndo: () => void
  /** Same act as ⇧⌘Z. */
  onRedo: () => void
  assetsOpen: boolean
  onToggleAssets: () => void
}): JSX.Element {
  return (
    <div
      className="canvas-host absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-2 rounded-[12px] border border-[var(--line-2)] bg-[var(--bg-1)] p-2 shadow-[0_6px_20px_oklch(0_0_0_/_0.4)]"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={onUndo} title="Undo (⌘Z)" aria-label="Undo" className={BTN}>
        <Undo2 size={16} strokeWidth={1.6} aria-hidden />
      </button>
      <button type="button" onClick={onRedo} title="Redo (⇧⌘Z)" aria-label="Redo" className={BTN}>
        <Redo2 size={16} strokeWidth={1.6} aria-hidden />
      </button>
      <div aria-hidden className="mx-0.5 h-px self-stretch bg-[var(--line-1)]" />
      <button
        type="button"
        onClick={onToggleAssets}
        title="Asset browser (])"
        aria-label="Asset browser"
        aria-pressed={assetsOpen}
        className={
          BTN + (assetsOpen ? ' bg-[var(--bg-2)] !text-[var(--cv-accent)]' : '')
        }
      >
        <FolderOpen size={16} strokeWidth={1.6} aria-hidden />
      </button>
    </div>
  )
}
