/**
 * undoStack — the canvas's act history, as a pure data structure.
 *
 * One stack of undoable ACTS with a redo branch, extracted from CanvasView so
 * the ordering rules are testable without a React tree. The semantics the
 * apply-side (CanvasView) builds on:
 *
 *  - `push` records a NEW user act. It clears the redo branch — the same rule
 *    the timeline history uses: once you act, the futures you undid are gone.
 *  - `popUndo` moves the top entry to the redo branch and returns it; the
 *    caller applies the INVERSE. `popRedo` is the mirror image (caller
 *    re-applies the forward act).
 *  - Entries whose forward act cannot be replayed are the caller's problem:
 *    `peekRedo` + `discardRedoTop` exist so an unsupported entry can be shown
 *    ("redo isn't available for this") and dropped WITHOUT landing back on the
 *    undo side in an un-applied state.
 *  - Depth is capped (default 50); the oldest entry falls off. The array this
 *    replaced was unbounded and grew for the life of a project tab.
 *
 * The load-bearing rule: entries enter ONLY through `push`, which only UI
 * gesture handlers call. Nothing here subscribes to canvas broadcasts, so
 * agent / CLI / asset-sync writes can never mint an entry — undo is "undo
 * what YOU did", never "undo what the agent did". The test pins this by
 * asserting the public surface below is the whole API.
 */

export interface UndoStack<T> {
  push(entry: T): void
  /** Move the newest act to the redo branch and return it (caller applies the
   *  inverse). `null` when there is nothing to undo. */
  popUndo(): T | null
  /** Move the newest undone act back to the undo side and return it (caller
   *  replays the forward act). `null` when there is nothing to redo. */
  popRedo(): T | null
  peekUndo(): T | null
  peekRedo(): T | null
  /** Drop the redo top WITHOUT re-arming it on the undo side — for entries
   *  whose forward act cannot be replayed (the caller explains why). */
  discardRedoTop(): T | null
  canUndo(): boolean
  canRedo(): boolean
  clear(): void
}

export function createUndoStack<T>(limit = 50): UndoStack<T> {
  const undoArr: T[] = []
  const redoArr: T[] = []
  return {
    push(entry: T): void {
      undoArr.push(entry)
      if (undoArr.length > limit) undoArr.shift()
      redoArr.length = 0
    },
    popUndo(): T | null {
      const entry = undoArr.pop()
      if (entry === undefined) return null
      redoArr.push(entry)
      return entry
    },
    popRedo(): T | null {
      const entry = redoArr.pop()
      if (entry === undefined) return null
      undoArr.push(entry)
      return entry
    },
    peekUndo(): T | null {
      return undoArr.length > 0 ? undoArr[undoArr.length - 1] : null
    },
    peekRedo(): T | null {
      return redoArr.length > 0 ? redoArr[redoArr.length - 1] : null
    },
    discardRedoTop(): T | null {
      return redoArr.pop() ?? null
    },
    canUndo(): boolean {
      return undoArr.length > 0
    },
    canRedo(): boolean {
      return redoArr.length > 0
    },
    clear(): void {
      undoArr.length = 0
      redoArr.length = 0
    },
  }
}
